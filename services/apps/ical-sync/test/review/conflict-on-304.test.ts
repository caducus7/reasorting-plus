// Import (brief C7): upsert by channel feed and UID, delete what left the feed, conditional GET,
// staleness, back-off on failure without ever deleting, and conflicts (brief test 3: exactly one INV-3
// alert per conflict, not one per poll).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Alert, Notifier } from "@chain/indexer/alerts";
import { createSync, type EscrowedSource, type Feed } from "../../src/importer.js";
import { migrate } from "../../src/db.js";
import { freshDb } from "../pg.js";

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

describe("review 0005 R4 and R5", () => {
  it("a booking deposited onto an existing channel block is logged as a conflict even while the feed answers 304", async () => {
    clock = new Date("2026-10-03T00:00:00Z");
    etag = '"r4"';
    feedBody = cal(ev("x@airbnb.com", "2026-12-10", "2026-12-14"));
    const s = sync();
    await s.syncConfig();
    await s.pollDue(); // imported; no escrow bookings yet
    // A guest deposits onto those nights (the residual race of spec 9); the feed has not changed.
    escrowed = [{ escrow: "0x00000000000000000000000000000000000000e5", bookingId: `0x${"c4".repeat(32)}`, resourceId: R, checkInUtc: 1_796_824_800n, checkOutUtc: 1_797_066_000n }];
    clock = new Date("2026-10-03T00:06:00Z");
    await s.pollDue(); // 304
    await s.pollDue();
    const log = (await db.pool.query("SELECT * FROM ical_sync.conflicts WHERE booking_id = $1", [`0x${"c4".repeat(32)}`])).rows;
    expect(log).toHaveLength(1);
  });
  it("export URLs come from the on-demand command, not the service log", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("../../src/main.ts", import.meta.url), "utf8");
    expect(main).not.toMatch(/exportToken\(/); // the service never computes (so never logs) the URLs
    const { exportUrls } = await import("../../src/export-urls.js");
    const u = exportUrls("https://ical.example.com/", "s".repeat(48), [{ resourceId: R, channel: "airbnb" }, { resourceId: R, channel: "airbnb" }]);
    expect(u).toHaveLength(1);
    expect(u[0]!.url).toMatch(/^https:\/\/ical\.example\.com\/ical\/[A-Za-z0-9_-]{43}\.ics$/);
  });
});
