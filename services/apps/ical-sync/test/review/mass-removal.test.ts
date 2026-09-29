// Mass-removal guard (review 0006 G1): a feed that suddenly drops most of its future blocks (an empty
// or truncated export, a channel outage that answers 200 with an empty VCALENDAR) must not reopen
// those dates. Prior art: Microsoft Entra Connect's "prevent accidental deletes" (a deletion threshold,
// on by default, blocks the deletes until an admin approves them) and rsync/rclone --max-delete.
// Adapted to the asymmetry here: additions and changes still import; only unapproved future removals
// over the threshold are held, alerted, and applied after `pnpm confirm-removals <feedId>`.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Alert, Notifier } from "@chain/indexer/alerts";
import { createSync, type Feed } from "../../src/importer.js";
import { confirmRemovals } from "../../src/confirm-removals.js";
import { migrate } from "../../src/db.js";
import { freshDb } from "../pg.js";

const R = `0x${"c3".repeat(32)}`;
let db: Awaited<ReturnType<typeof freshDb>>;
let server: Server;
let base: string;
let body = "";
let etag = '"v0"';
let clock = new Date("2026-10-01T10:00:00Z");
let alerts: Alert[] = [];

const ev = (uid: string, from: string, to: string) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${from.replaceAll("-", "")}\r\nDTEND;VALUE=DATE:${to.replaceAll("-", "")}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\n`;
const cal = (...evs: string[]) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${evs.join("")}END:VCALENDAR\r\n`;
const A = ev("a", "2026-10-10", "2026-10-12");
const B = ev("b", "2026-10-20", "2026-10-25");
const C = ev("c", "2026-11-01", "2026-11-04");
const D = ev("d", "2026-12-01", "2026-12-03");
const PAST = ev("p", "2026-09-20", "2026-09-22"); // ended before "today" (2026-10-01 Athens)

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
  server = createServer((req, res) => {
    if (req.headers["if-none-match"] === etag) return res.writeHead(304).end();
    res.writeHead(200, { etag, "content-type": "text/calendar" }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await db.drop();
});
beforeEach(async () => {
  alerts = [];
  await db.pool.query("DELETE FROM calendar_blocks; DELETE FROM ical_sync.feed_state; DELETE FROM channel_feeds; DELETE FROM indexer_ops.alerts");
});

const capture: Notifier = { notify: async (a) => void alerts.push(a) };
const feed = (): Feed => ({ feedId: "vrbo-loft", resourceId: R, channel: "vrbo", url: `${base}/loft.ics` });
const sync = () =>
  createSync({
    pool: db.pool,
    chainId: 31337,
    feeds: [feed()],
    zones: new Map([[R, "Europe/Athens"]]),
    escrowed: async () => [],
    notifiers: [capture],
    now: () => clock,
    fetchOptions: { allowAddress: (ip) => ip === "127.0.0.1", requireHttps: false, timeoutMs: 2_000 },
    jitter: () => 1,
  });
const refs = async () => (await db.pool.query("SELECT ref FROM calendar_blocks WHERE source = 'vrbo-loft' ORDER BY ref")).rows.map((r) => r.ref as string);
const st = async () => (await db.pool.query("SELECT * FROM ical_sync.feed_state WHERE feed_id = 'vrbo-loft'")).rows[0];
const openAlerts = async () => (await db.pool.query("SELECT dedupe_key FROM indexer_ops.alerts WHERE resolved_at IS NULL ORDER BY dedupe_key")).rows.map((r) => r.dedupe_key as string);
let n = 0;
async function serve(s: ReturnType<typeof sync>, text: string) {
  body = text;
  etag = `"v${++n}"`;
  clock = new Date(clock.getTime() + 300_000);
  await db.pool.query("UPDATE ical_sync.feed_state SET next_attempt_at = $1", [clock]);
  await s.pollDue();
}

describe("mass-removal guard", () => {
  it("an empty feed keeps every future block, still counts as a successful import, and alerts once", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A, B, C, PAST));
    expect(await refs()).toEqual(["a", "b", "c", "p"]);
    await serve(s, cal());
    await serve(s, cal());
    expect(await refs()).toEqual(["a", "b", "c"]); // the past block goes; the future ones are held
    expect((await st()).held_removals.sort()).toEqual(["a", "b", "c"]);
    expect((await st()).last_status).toBe("200");
    expect(alerts.map((a) => a.key)).toEqual(["FEED_MASS_REMOVAL:vrbo-loft"]);
    expect(await openAlerts()).toEqual(["FEED_MASS_REMOVAL:vrbo-loft"]);
  });

  it("additions still import while removals are held", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A, B, C));
    await serve(s, cal(D)); // truncated export that happens to carry one new event
    expect(await refs()).toEqual(["a", "b", "c", "d"]);
    expect((await st()).held_removals.sort()).toEqual(["a", "b", "c"]);
  });

  it("the feed coming back clears the hold and resolves the alert without any operator action", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A, B, C));
    await serve(s, cal());
    await serve(s, cal(A, B, C));
    expect(await refs()).toEqual(["a", "b", "c"]);
    expect((await st()).held_removals).toEqual([]);
    expect(await openAlerts()).toEqual([]);
  });

  it("ordinary removals below the threshold apply at once (single cancellation, half or fewer)", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A, B, C, D));
    await serve(s, cal(A, B, C)); // 1 of 4
    await serve(s, cal(A)); // 2 of 3 would be held ...
    expect(await refs()).toEqual(["a", "b", "c"]);
    const s2 = sync();
    await serve(s2, cal(A, B, C)); // b, c return: the hold clears
    await serve(s2, cal(A, C)); // 1 of 3: a cancellation
    expect(await refs()).toEqual(["a", "c"]);
    await serve(s2, cal(A)); // 1 of 2, not more than half
    expect(await refs()).toEqual(["a"]);
    expect(await openAlerts()).toEqual([]);
  });

  it("confirm-removals approves exactly the held set; it bypasses the 304 and applies on the next poll", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A, B, C));
    await serve(s, cal());
    expect(await confirmRemovals(db.pool, "vrbo-loft")).toEqual(["a", "b", "c"]);
    // Same etag: without the validators cleared the channel would answer 304 and nothing would apply.
    clock = new Date(clock.getTime() + 300_000);
    await db.pool.query("UPDATE ical_sync.feed_state SET next_attempt_at = LEAST(next_attempt_at, $1)", [clock]);
    await s.pollDue();
    expect(await refs()).toEqual([]);
    const row = await st();
    expect(row.held_removals).toEqual([]);
    expect(row.approved_removals).toEqual([]);
    expect(await openAlerts()).toEqual([]);
  });

  it("an approval does not stretch to removals the operator did not see", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A, B, C, D));
    await serve(s, cal(D)); // a, b, c held
    await confirmRemovals(db.pool, "vrbo-loft");
    await serve(s, cal()); // now d vanished too: a, b, c go; d alone is 1 of 1 but the feed is empty -> held
    expect(await refs()).toEqual(["d"]);
    expect((await st()).held_removals).toEqual(["d"]);
    expect(await openAlerts()).toEqual(["FEED_MASS_REMOVAL:vrbo-loft"]);
  });

  it("confirming a feed with nothing held is refused", async () => {
    const s = sync();
    await s.syncConfig();
    await serve(s, cal(A));
    await expect(confirmRemovals(db.pool, "vrbo-loft")).rejects.toThrow(/nothing held/);
    await expect(confirmRemovals(db.pool, "nope")).rejects.toThrow(/unknown feed/);
  });
});
