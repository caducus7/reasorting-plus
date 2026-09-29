// Brief C7 test 2, on Anvil with the real contracts, a real Ponder process and the C6 worker:
//   - a reorg removing a deposit before `safe` never appears in the export;
//   - after `safe`, a removal (deep reorg) deletes it on the next export;
//   - a cancellation leaves the export only once it is itself at `safe` (ADR 0017 §2).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ICAL from "ical.js";
import type { PublicClient } from "viem";
import { escrowAbi } from "@chain/abi";
import { createWorker, type Worker } from "@chain/indexer/ops";
// The indexer's Anvil harness (test-only import across packages).
import { book, freshDb, KEYS, propertiesFile, RESOURCE, startAnvil, startPonder, type Anvil, type Ponder } from "../../../indexer/test/anvil/harness.js";
import { migrate } from "../../src/db.js";
import { createExportApp, exportToken, exportUid } from "../../src/export.js";
import { exportableSource } from "../../src/sources.js";

const GENESIS = Date.parse("2026-08-01T09:00:00Z") / 1000;
const DAY = 86_400;
const SECRET = "s".repeat(48);
let a: Anvil;
let db: Awaited<ReturnType<typeof freshDb>>;
let ponder: Ponder;
let worker: Worker;
let app: ReturnType<typeof createExportApp>;

beforeAll(async () => {
  db = await freshDb();
  a = await startAnvil(GENESIS);
  await migrate(db.pool);
  ponder = await startPonder({ dbUrl: db.url, rpcUrl: a.url, factory: a.dep.factory, schema: "live_1", viewsSchema: "indexer" });
  worker = createWorker(
    { DATABASE_URL: db.url, RPC_URL: a.url, CHAIN_ID: 31337, PONDER_SCHEMA: "indexer", PROPERTIES_FILE: propertiesFile(), POLL_MS: 200, MONITOR_EVERY_MS: 1_000, RECEIVED_CONFIRMATIONS: 2, MAX_LAG_BLOCKS: 60 },
    db.pool,
    a.client as PublicClient,
    [],
  );
  app = createExportApp({
    secret: SECRET,
    pairs: [{ resourceId: RESOURCE, channel: "airbnb" }],
    zones: new Map([[RESOURCE.toLowerCase(), "Europe/Athens"]]),
    names: new Map([[RESOURCE.toLowerCase(), "Villa"]]),
    exportable: exportableSource(db.pool, "indexer", 31337, 3_650),
  });
}, 300_000);

afterAll(async () => {
  ponder?.stop();
  a?.stop();
  await db?.drop();
});

async function settle() {
  await ponder.indexed(await a.client.getBlockNumber());
  await worker.tick();
}
async function exported(): Promise<{ uids: string[]; text: string }> {
  const r = await app.request(`/ical/${exportToken(SECRET, RESOURCE, "airbnb")}.ics`);
  expect(r.status).toBe(200);
  const text = await r.text();
  const cal = new ICAL.Component(ICAL.parse(text) as unknown as unknown[]);
  return { uids: cal.getAllSubcomponents("vevent").map((e) => e.getFirstPropertyValue("uid") as string), text };
}
const reorg = (depth: bigint) => a.test.request({ method: "anvil_reorg" as never, params: [Number(depth), []] as never });

describe("export follows the safe head (brief C7 test 2)", () => {
  it("a deposit reorged out before safe never appears", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 30 * DAY, nights: 3, priceAtomic: 450_000_000n });
    await a.test.mine({ blocks: 2 });
    await settle();
    expect((await exported()).uids).not.toContain(exportUid(SECRET, b.bookingId)); // received, not safe
    await reorg((await a.client.getBlockNumber()) - b.block + 1n);
    await a.test.mine({ blocks: 40 }); // well past where it would have been safe
    await settle();
    expect((await exported()).uids).not.toContain(exportUid(SECRET, b.bookingId));
  });

  it("a safe deposit appears with no guest data; after a deep reorg removes it, the next export drops it", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 40 * DAY, nights: 2, priceAtomic: 300_000_000n });
    await a.test.mine({ blocks: 40 }); // Anvil safe = latest - 32
    await settle();
    const e = await exported();
    expect(e.uids).toContain(exportUid(SECRET, b.bookingId));
    expect(e.text.toLowerCase()).not.toContain(b.guest.slice(2).toLowerCase());
    expect(e.text.toLowerCase()).not.toContain(b.bookingId.slice(2, 22));
    await reorg((await a.client.getBlockNumber()) - b.block + 1n);
    await a.test.mine({ blocks: 1 });
    // Ponder rolls a reorg back inside its 30-60 block window and stalls beyond it (docs/adr/0017 §4);
    // which one depends on where its finality step is. Beyond: the runbook's full replay.
    const gone = async () => (await db.pool.query("SELECT 1 FROM indexer.booking WHERE booking_id = $1", [b.bookingId])).rowCount === 0;
    const rolledBack = await ponder.until(gone, "rollback", 8_000).then(() => true, () => false);
    if (!rolledBack) {
      expect(ponder.log).toMatch(/unrecoverable/i);
      expect((await exported()).uids).toContain(exportUid(SECRET, b.bookingId)); // stale until the replay
      ponder.stop();
      ponder = await startPonder({ dbUrl: db.url, rpcUrl: a.url, factory: a.dep.factory, schema: "live_2", viewsSchema: "indexer" });
      await ponder.indexed(await a.client.getBlockNumber());
      expect(await gone()).toBe(true);
    }
    console.log(`deep reorg path: ${rolledBack ? "Ponder rolled back" : "Ponder stalled; full replay"}`);
    await worker.tick();
    expect((await exported()).uids).not.toContain(exportUid(SECRET, b.bookingId));
  });

  it("a cancelled booking stays exported until the cancellation is at safe", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 60 * DAY, nights: 2, priceAtomic: 300_000_000n });
    await a.test.mine({ blocks: 40 });
    await settle();
    expect((await exported()).uids).toContain(exportUid(SECRET, b.bookingId));
    await a.send(KEYS.guest, { address: a.dep.escrow, abi: escrowAbi, functionName: "cancelByGuest", args: [b.bookingId] });
    await settle();
    expect((await exported()).uids).toContain(exportUid(SECRET, b.bookingId)); // cancellation could still be reorged away
    await a.test.mine({ blocks: 33 });
    await settle();
    expect((await exported()).uids).not.toContain(exportUid(SECRET, b.bookingId));
  });
});
