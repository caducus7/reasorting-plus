// Brief C6 test 1 (reorg), on Anvil with the real contracts and a real Ponder process: index a
// deposit, force a reorg that removes it, and check that the booking and all its ledger entries roll
// back and that the calendar slot frees only if the deposit had not reached `safe`.
//   pnpm --filter @chain/indexer test:anvil   (needs anvil, forge and Postgres)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { createWorker, migrate, type Worker } from "../../src/worker/main.js";
import type { Alert, Notifier } from "../../src/worker/notifier.js";
import { escrowAbi } from "@chain/abi";
import { book, KEYS, freshDb, propertiesFile, startAnvil, startPonder, type Anvil, type Ponder } from "./harness.js";

const GENESIS = Date.parse("2026-05-01T09:00:00Z") / 1000;
const DAY = 86_400;

let a: Anvil;
let db: Awaited<ReturnType<typeof freshDb>>;
let ponder: Ponder;
let worker: Worker;
const alerts: Alert[] = [];
const capture: Notifier = { notify: async (x) => void alerts.push(x) };

const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await db.pool.query(sql, args)).rows as T[];
const calendarRow = (bookingId: string) => q("SELECT * FROM calendar_blocks WHERE source = 'escrow' AND ref = $1", [bookingId]);
const bookingRow = (bookingId: string) => q("SELECT * FROM indexer.booking WHERE booking_id = $1", [bookingId]);
async function diag(tag: string) {
  const cp = await q("SELECT latest_checkpoint FROM indexer._ponder_checkpoint").catch((e) => String(e));
  const ev = await q("SELECT name, block_number, block_hash FROM indexer.processed_event WHERE name <> 'Initialized' ORDER BY block_number").catch((e) => String(e));
  const blocks = [];
  for (let n = 10n; n <= 22n; n++) blocks.push(`${n}:${(await a.client.getBlock({ blockNumber: n }).catch(() => null))?.hash?.slice(0, 10)}`);
  console.log(`DIAG ${tag}`, JSON.stringify({ cp, ev, blocks, latest: String(await a.client.getBlockNumber()) }), "\n", ponder.log.slice(-4000));
}
const reorg = (depth: bigint) => a.test.request({ method: "anvil_reorg" as never, params: [Number(depth), []] as never });

beforeAll(async () => {
  db = await freshDb();
  a = await startAnvil(GENESIS);
  await migrate(db.pool);
  ponder = await startPonder({ dbUrl: db.url, rpcUrl: a.url, factory: a.dep.factory, schema: "live_1", viewsSchema: "indexer" });
  worker = createWorker(
    {
      DATABASE_URL: db.url,
      RPC_URL: a.url,
      CHAIN_ID: 31337,
      PONDER_SCHEMA: "indexer",
      PROPERTIES_FILE: propertiesFile(),
      POLL_MS: 200,
      MONITOR_EVERY_MS: 1_000,
      RECEIVED_CONFIRMATIONS: 2,
      MAX_LAG_BLOCKS: 5,
    },
    db.pool,
    a.client as PublicClient,
    [capture],
  );
}, 180_000);

afterAll(async () => {
  ponder?.stop();
  a?.stop();
  await db?.drop();
});

describe("reorg (brief C6 test 1)", () => {
  it("rolls back an unsafe deposit, its ledger entries and its calendar slot", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 30 * DAY, nights: 3, priceAtomic: 450_000_000n });
    await a.test.mine({ blocks: 2 });
    await ponder.indexed(await a.client.getBlockNumber());
    await worker.tick({ monitors: true });

    expect(await bookingRow(b.bookingId)).toHaveLength(1);
    const legs = await q("SELECT * FROM indexer.journal WHERE block_number = $1", [b.block.toString()]);
    expect(legs.length).toBeGreaterThan(0);
    expect(await calendarRow(b.bookingId)).toHaveLength(1);
    expect((await q("SELECT milestone FROM indexer_ops.booking_milestones WHERE booking_id = $1", [b.bookingId])).map((r) => r.milestone)).toEqual(["received"]);
    const openBefore = (await q<{ amount: string }>("SELECT amount FROM indexer.balance WHERE account = 'open_principal'"))[0]!.amount;
    expect(BigInt(openBefore)).toBe(450_000_000n);
    expect(alerts.filter((x) => x.severity === "page")).toEqual([]); // reconcile clean, no anomalies

    const depth = (await a.client.getBlockNumber()) - b.block + 1n; // 3 blocks: well inside safe
    await reorg(depth);
    await a.test.mine({ blocks: 1 });
    await ponder.until(async () => (await bookingRow(b.bookingId)).length === 0, "booking rolled back", 20_000).catch(async (e) => {
      await diag("part1-no-rollback");
      throw e;
    });

    // Every ledger entry and processed event of the deposit block is gone; balances are back to zero.
    expect(await q("SELECT * FROM indexer.journal WHERE block_number >= $1", [b.block.toString()])).toEqual([]);
    expect(await q("SELECT * FROM indexer.processed_event WHERE block_number >= $1", [b.block.toString()])).toEqual([]);
    expect(await q("SELECT * FROM indexer.balance WHERE amount <> 0")).toEqual([]);

    await worker.tick({ monitors: true });
    expect(await calendarRow(b.bookingId)).toEqual([]); // had not reached safe: the slot frees
    const ms = (await q("SELECT milestone FROM indexer_ops.booking_milestones WHERE booking_id = $1 ORDER BY id", [b.bookingId])).map((r) => r.milestone);
    expect(ms).toEqual(["received", "reverted"]);
    expect(alerts.filter((x) => x.severity === "page")).toEqual([]);
  }, 120_000);

  it("keeps the slot of a deposit that had reached safe, and pages the deep reorg", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 40 * DAY, nights: 2, priceAtomic: 300_000_000n });
    await a.test.mine({ blocks: 40 }); // Anvil: safe = latest - 32
    await ponder.indexed(await a.client.getBlockNumber());
    await worker.tick({ monitors: true });
    if ((await bookingRow(b.bookingId)).length === 0) await diag("part2-missing");
    const ms = (await q("SELECT milestone FROM indexer_ops.booking_milestones WHERE booking_id = $1 ORDER BY id", [b.bookingId])).map((r) => r.milestone);
    expect(ms).toContain("safe");
    expect(await calendarRow(b.bookingId)).toHaveLength(1);

    const depth = (await a.client.getBlockNumber()) - b.block + 1n; // 41 blocks: past safe and past Ponder's window
    await reorg(depth);
    await a.test.mine({ blocks: 1 });
    // 41 blocks is inside Ponder's 30-60 block window here: it rolls the deposit back.
    await ponder.until(async () => (await bookingRow(b.bookingId)).length === 0, "booking rolled back", 20_000);

    await worker.tick({ monitors: true });
    expect(await calendarRow(b.bookingId)).toHaveLength(1); // not freed
    expect(alerts.some((x) => x.invariant === "DEEP_REORG" && x.severity === "page")).toBe(true);

    const after = (await q("SELECT milestone FROM indexer_ops.booking_milestones WHERE booking_id = $1 ORDER BY id", [b.bookingId])).map((r) => r.milestone);
    expect(after).toContain("reverted");
    expect(alerts.some((x) => x.key.startsWith("DEEP_REORG:booking:") && x.escrow)).toBe(true);
  }, 240_000);

  it("halts loudly on a reorg beyond Ponder's window; the slot stays blocked through the full replay", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 50 * DAY, nights: 4, priceAtomic: 600_000_000n });
    await a.test.mine({ blocks: 90 });
    await ponder.indexed(await a.client.getBlockNumber());
    await worker.tick({ monitors: true });
    expect(await calendarRow(b.bookingId)).toHaveLength(1);
    const pagesBefore = alerts.filter((x) => x.invariant === "DEEP_REORG").length;

    await reorg((await a.client.getBlockNumber()) - b.block + 1n); // 91 blocks: beyond any window
    await a.test.mine({ blocks: 1 });
    // Ponder stops indexing at once and retries for up to 10 minutes before exiting: wait for the
    // detection, not the exit.
    await ponder.until(async () => /unrecoverable/i.test(ponder.log), "unrecoverable reorg detected", 30_000);
    await a.test.mine({ blocks: 10 }); // the chain moves on; the projection does not

    // The projection is stale, but the head tracker sees safe move and the lag monitor sees the stall.
    await worker.tick({ monitors: true });
    expect(await calendarRow(b.bookingId)).toHaveLength(1);
    expect(alerts.filter((x) => x.invariant === "DEEP_REORG").length).toBeGreaterThan(pagesBefore);
    expect(alerts.some((x) => x.invariant === "LAG" && x.severity === "page")).toBe(true);
    // Reconciliation against the chain at the projection's block also sees the phantom principal.
    const recon = alerts.find((x) => x.invariant === "RECONCILE");
    expect(recon?.details?.totalOpenPrincipal).toBe("600000000 != 0");

    // Recovery (runbook): stop it, full replay into a new schema; Ponder switches the views when ready.
    ponder.stop();
    ponder = await startPonder({ dbUrl: db.url, rpcUrl: a.url, factory: a.dep.factory, schema: "live_2", viewsSchema: "indexer" });
    await ponder.indexed(await a.client.getBlockNumber());
    expect(await bookingRow(b.bookingId)).toEqual([]);
    await worker.tick({ monitors: true });
    expect(await calendarRow(b.bookingId)).toHaveLength(1); // still blocked: it had reached safe
    const ms = (await q("SELECT milestone FROM indexer_ops.booking_milestones WHERE booking_id = $1 ORDER BY id", [b.bookingId])).map((r) => r.milestone);
    expect(ms).toEqual(["received", "safe", "finalized", "reverted"]);
    // After the replay the ledger reconciles with the contract again: the reconcile and lag alerts
    // resolve; the deep-reorg pages stay open for a human (they are facts, not conditions).
    const open = (await q<{ invariant: string }>("SELECT invariant FROM indexer_ops.alerts WHERE resolved_at IS NULL")).map((r) => r.invariant);
    expect(open.filter((i) => i !== "DEEP_REORG")).toEqual([]);
    expect((await q("SELECT * FROM indexer_ops.alerts WHERE invariant = 'LAG' AND resolved_at IS NULL"))).toEqual([]);
  }, 300_000);

  it("frees a cancelled booking's slot only once the cancellation is at safe", async () => {
    const b = await book(a, { checkInUtc: (await a.now()) + 60 * DAY, nights: 2, priceAtomic: 300_000_000n });
    await a.test.mine({ blocks: 2 });
    await ponder.indexed(await a.client.getBlockNumber());
    await worker.tick();
    expect(await calendarRow(b.bookingId)).toHaveLength(1);

    await a.send(KEYS.guest, { address: a.dep.escrow, abi: escrowAbi, functionName: "cancelByGuest", args: [b.bookingId] });
    await ponder.indexed(await a.client.getBlockNumber());
    await worker.tick();
    expect((await bookingRow(b.bookingId))[0]!.outcome).toBe("CANCELLED_BY_GUEST");
    expect(await calendarRow(b.bookingId)).toHaveLength(1); // a reorg could still undo the cancellation

    await a.test.mine({ blocks: 33 }); // Anvil: safe = latest - 32
    await ponder.indexed(await a.client.getBlockNumber());
    await worker.tick();
    expect(await calendarRow(b.bookingId)).toEqual([]);
  }, 120_000);
});
