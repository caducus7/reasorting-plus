// Import (brief C7): upsert by channel feed and UID, delete what left the feed, conditional GET,
// staleness, back-off on failure without ever deleting, and conflicts (brief test 3: exactly one INV-3
// alert per conflict, not one per poll).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Alert, Notifier } from "@chain/indexer/alerts";
import { createSync, type EscrowedSource, type Feed } from "../src/importer.js";
import { migrate } from "../src/db.js";
import { freshDb } from "./pg.js";

const R = `0x${"a1".repeat(32)}`;
const TZ = "Europe/Athens";
let db: Awaited<ReturnType<typeof freshDb>>;
let server: Server;
let base: string;
let feedBody = "";
let feedStatus = 200;
let etag = '"e1"';

const ev = (uid: string, from: string, to: string) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${from.replaceAll("-", "")}\r\nDTEND;VALUE=DATE:${to.replaceAll("-", "")}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\n`;
const cal = (...evs: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${evs.join("")}END:VCALENDAR\r\n`;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
  server = createServer((req, res) => {
    if (feedStatus !== 200) return res.writeHead(feedStatus).end();
    if (req.headers["if-none-match"] === etag) return res.writeHead(304).end();
    res.writeHead(200, { etag, "content-type": "text/calendar" }).end(feedBody);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await db.drop();
});

let alerts: Alert[];
let escrowed: Awaited<ReturnType<EscrowedSource>>;
let clock: Date;
const capture: Notifier = { notify: async (a) => void alerts.push(a) };
const feed: Feed = { feedId: "airbnb-villa", resourceId: R, channel: "airbnb", url: "" };

function sync(feeds: Feed[] = [{ ...feed, url: `${base}/villa.ics` }]) {
  return createSync({
    pool: db.pool,
    chainId: 31337,
    feeds,
    zones: new Map([[R, TZ]]),
    escrowed: async () => escrowed,
    notifiers: [capture],
    now: () => clock,
    fetchOptions: { allowAddress: (ip) => ip === "127.0.0.1", requireHttps: false, timeoutMs: 2_000 },
    pollIntervalSec: 300,
    maxBackoffSec: 3_600,
    staleAlertSec: 900,
    jitter: () => 1,
  });
}
const blocks = async () =>
  (await db.pool.query("SELECT ref, lower(stay)::text AS f, upper(stay)::text AS t FROM calendar_blocks WHERE source = 'airbnb-villa' ORDER BY ref")).rows.map((r) => [r.ref, r.f, r.t]);
const feedRow = async () => (await db.pool.query("SELECT * FROM channel_feeds WHERE feed_id = 'airbnb-villa'")).rows[0];
const state = async () => (await db.pool.query("SELECT * FROM ical_sync.feed_state WHERE feed_id = 'airbnb-villa'")).rows[0];

beforeEach(() => {
  alerts = [];
  escrowed = [];
  feedStatus = 200;
});

describe("import", () => {
  it("registers the feed as never imported (C5 fails closed), imports, then answers 304 without rewriting", async () => {
    clock = new Date("2026-10-01T10:00:00Z");
    etag = '"e1"';
    feedBody = cal(ev("a@airbnb.com", "2026-10-23", "2026-10-27"), ev("b@airbnb.com", "2026-11-24", "2026-12-01"));
    const s = sync();
    await s.syncConfig();
    expect((await feedRow()).last_success_at).toBeNull();
    await s.pollDue();
    expect(await blocks()).toEqual([
      ["a@airbnb.com", "2026-10-23", "2026-10-27"],
      ["b@airbnb.com", "2026-11-24", "2026-12-01"],
    ]);
    expect((await feedRow()).last_success_at.toISOString()).toBe(clock.toISOString());
    clock = new Date("2026-10-01T10:05:00Z");
    await s.pollDue();
    expect((await state()).last_status).toBe("304");
    expect((await feedRow()).last_success_at.toISOString()).toBe(clock.toISOString());
    expect(await blocks()).toHaveLength(2);
  });

  it("updates changed events and deletes events that left the feed", async () => {
    clock = new Date("2026-10-01T10:10:00Z");
    etag = '"e2"';
    feedBody = cal(ev("a@airbnb.com", "2026-10-24", "2026-10-27"), ev("c@airbnb.com", "2027-01-02", "2027-01-05"));
    await sync().pollDue();
    expect(await blocks()).toEqual([
      ["a@airbnb.com", "2026-10-24", "2026-10-27"],
      ["c@airbnb.com", "2027-01-02", "2027-01-05"],
    ]);
  });

  it("failures back off, never delete, and surface staleness once; recovery resolves it", async () => {
    const s = sync();
    const before = await blocks();
    const nexts: number[] = [];
    for (const [i, status] of [500, 500, 500].entries()) {
      feedStatus = status;
      clock = i === 0 ? new Date("2026-10-01T10:15:00Z") : new Date((await state()).next_attempt_at);
      await s.pollDue();
      nexts.push((new Date((await state()).next_attempt_at).getTime() - clock.getTime()) / 1000);
    }
    expect(nexts).toEqual([300, 600, 1_200]); // 5, 10, 20 minutes
    expect((await state()).failures).toBe(3);
    expect(await blocks()).toEqual(before); // never deleted on failure
    // A garbage 200 is a failure too.
    feedStatus = 200;
    etag = '"e3"';
    feedBody = "<html>login</html>";
    clock = new Date((await state()).next_attempt_at);
    await s.pollDue();
    expect((await state()).failures).toBe(4);
    expect(await blocks()).toEqual(before);
    // Stale by now (> 900 s since the last success): one alert, even over repeated checks.
    await s.checkStaleness();
    await s.checkStaleness();
    expect(alerts.map((a) => a.invariant)).toEqual(["FEED_STALE"]);
    // Recovery: success resets the back-off and resolves the alert.
    feedBody = cal(ev("a@airbnb.com", "2026-10-24", "2026-10-27"));
    clock = new Date((await state()).next_attempt_at);
    await s.pollDue();
    await s.checkStaleness();
    expect((await state()).failures).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM ical_sync.feed_state WHERE feed_id = 'airbnb-villa'")).rowCount).toBe(1);
    expect((await db.pool.query("SELECT 1 FROM indexer_ops.alerts WHERE invariant = 'FEED_STALE' AND resolved_at IS NULL")).rowCount).toBe(0);
  });

  it("the back-off is capped", async () => {
    const s = sync();
    feedStatus = 503;
    for (let i = 0; i < 8; i++) {
      clock = new Date((await state()).next_attempt_at);
      await s.pollDue();
    }
    const st = await state();
    expect((new Date(st.next_attempt_at).getTime() - clock.getTime()) / 1000).toBe(3_600);
    feedStatus = 200;
    clock = new Date(st.next_attempt_at);
    await s.pollDue();
  });

  it("a forced overlap raises exactly one INV-3 alert per conflict, not one per poll; logged with timestamps", async () => {
    etag = '"e4"';
    feedBody = cal(ev("a@airbnb.com", "2026-10-24", "2026-10-27"), ev("d@airbnb.com", "2026-11-10", "2026-11-12"));
    escrowed = [
      { escrow: "0x00000000000000000000000000000000000000e5", bookingId: `0x${"b1".repeat(32)}`, resourceId: R, checkInUtc: 1_792_933_200n, checkOutUtc: 1_793_178_000n }, // 2026-10-25 15:00 -> 10-28 11:00 Athens
    ];
    const s = sync();
    for (let i = 0; i < 3; i++) {
      clock = new Date(Date.parse("2026-10-02T00:00:00Z") + i * 300_000);
      etag = `"e4-${i}"`; // a fresh 200 each poll
      await s.pollDue();
    }
    expect(alerts.filter((a) => a.invariant === "INV-3")).toHaveLength(1);
    const a = alerts.find((x) => x.invariant === "INV-3")!;
    expect(a.key).toBe(`INV-3:overlap:0x${"b1".repeat(32)}:airbnb-villa:a@airbnb.com`);
    const log = (await db.pool.query("SELECT * FROM ical_sync.conflicts")).rows;
    expect(log).toHaveLength(1);
    expect(log[0].first_seen_at.toISOString()).toBe("2026-10-02T00:00:00.000Z");
    expect(log[0].last_seen_at.toISOString()).toBe("2026-10-02T00:10:00.000Z");
    expect(log[0].resolved_at).toBeNull();

    // The channel drops the clashing event: the conflict and its alert resolve.
    etag = '"e5"';
    feedBody = cal(ev("d@airbnb.com", "2026-11-10", "2026-11-12"));
    clock = new Date("2026-10-02T00:15:00Z");
    await s.pollDue();
    expect((await db.pool.query("SELECT resolved_at FROM ical_sync.conflicts")).rows[0].resolved_at).not.toBeNull();
    expect((await db.pool.query("SELECT 1 FROM indexer_ops.alerts WHERE invariant = 'INV-3' AND resolved_at IS NULL")).rowCount).toBe(0);
  });

  it("a feed removed from the configuration loses its blocks and its staleness row", async () => {
    await sync([]).syncConfig();
    expect(await blocks()).toEqual([]);
    expect(await feedRow()).toBeUndefined();
  });
});
