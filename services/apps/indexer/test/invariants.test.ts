// Brief C6 acceptance: "each invariant has a test that breaks it deliberately and sees the alert".
// Each case breaks one invariant, runs it through the real alert outbox (Postgres) and a capturing
// notifier, and checks: one alert, sent once, resolved when the condition clears (except facts).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/core/memoryStore.js";
import { bootstrapEscrow, reduce } from "../src/core/reducer.js";
import {
  fromAnomaly,
  inv1,
  inv2,
  inv3,
  inv4,
  inv5,
  lag,
  MIN_LOSS_ATOMIC,
  reconcile,
  requiredLiquid,
  type Breach,
  type LedgerFields,
} from "../src/core/invariants.js";
import { newEscrowRow } from "../src/core/reducer.js";
import type { BookingRow, ChainEvent } from "../src/core/types.js";
import { AlertOutbox, type Alert, type Notifier } from "../src/worker/notifier.js";
import { migrate } from "../src/worker/main.js";
import { freshDb } from "./anvil/harness.js";

const E = "0x00000000000000000000000000000000000000e5" as const;
let db: Awaited<ReturnType<typeof freshDb>>;
let sent: Alert[];
let outbox: AlertOutbox;
const capture: Notifier = { notify: async (a) => void sent.push(a) };

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
});
afterAll(async () => db?.drop());

/** Breaks, re-sends, clears and re-breaks one invariant through the outbox. */
async function lifecycle(family: string, broken: Breach | Breach[] | null, healthy: Breach | Breach[] | null, severity: string) {
  sent = [];
  outbox = new AlertOutbox(db.pool, 31337, [capture]);
  const list = (b: Breach | Breach[] | null) => (b === null ? [] : Array.isArray(b) ? b : [b]);
  expect(list(healthy)).toEqual([]);
  expect(list(broken).length).toBeGreaterThan(0);
  await outbox.sync(family, list(broken));
  expect(sent).toHaveLength(list(broken).length);
  expect(sent[0]!.severity).toBe(severity);
  await outbox.sync(family, list(broken)); // still broken: no second notification
  expect(sent).toHaveLength(list(broken).length);
  const open = await db.pool.query("SELECT * FROM indexer_ops.alerts WHERE dedupe_key = $1 AND resolved_at IS NULL", [list(broken)[0]!.key]);
  expect(open.rowCount).toBe(1);
  expect(open.rows[0].response.length).toBeGreaterThan(0);
  await outbox.sync(family, list(healthy)); // cleared: resolved
  const still = await db.pool.query("SELECT * FROM indexer_ops.alerts WHERE dedupe_key = $1 AND resolved_at IS NULL", [list(broken)[0]!.key]);
  expect(still.rowCount).toBe(0);
  await outbox.sync(family, list(broken)); // recurs: alerts again
  expect(sent).toHaveLength(2 * list(broken).length);
  await outbox.sync(family, []);
}

const fields = (o: Partial<LedgerFields> = {}): LedgerFields & { totalAssets: bigint } => ({
  totalOpenPrincipal: 1_000_000_000n,
  totalDisputed: 100_000_000n,
  totalPendingYield: 10_000_000n,
  totalClaimable: 200_000_000n,
  reserve: 1_000_000n,
  lossDebt: 0n,
  accYieldPerUnit: 0n,
  lastAssets: 1_320_000_000n,
  yieldUnallocated: 9_000_000n,
  ownerClaimable: 0n,
  pendingOwnerYield: 0n,
  shortfallSince: 0n,
  totalAssets: 1_320_000_000n,
  ...o,
});

const booking = (o: Partial<BookingRow>): BookingRow =>
  ({ status: "ESCROWED", checkInUtc: 0n, checkOutUtc: 0n, principalAtomic: 0n, ...o }) as BookingRow;

describe("invariant monitors: each breach alerts (spec 10.4)", () => {
  it("INV-1 solvency pages at MIN_LOSS_ATOMIC, not below", async () => {
    const ok = fields();
    const need = ok.totalOpenPrincipal + ok.totalDisputed + ok.totalClaimable;
    expect(inv1(E, fields({ totalAssets: need - MIN_LOSS_ATOMIC + 1n } as never))).toBeNull(); // rounding band
    await lifecycle("INV-1", inv1(E, fields({ totalAssets: need - MIN_LOSS_ATOMIC } as never)), inv1(E, ok), "page");
  });

  it("INV-2 full solvency alerts on a loss, warns on dust", async () => {
    expect(inv2(E, fields({ totalAssets: 1_320_000_000n - 5n } as never))?.severity).toBe("warn");
    await lifecycle("INV-2", inv2(E, fields({ totalAssets: 1_320_000_000n - MIN_LOSS_ATOMIC } as never)), inv2(E, fields()), "alert");
  });

  it("INV-3 calendar: an escrowed booking missing, and a channel event overlapping one", async () => {
    const b = [{ escrow: E, bookingId: "0xb1", resourceId: "0xr", from: "2026-07-01", to: "2026-07-04" }];
    const own = { resourceId: "0xr", source: "escrow", ref: "0xb1", from: "2026-07-01", to: "2026-07-04" };
    await lifecycle("INV-3", inv3(b, []), inv3(b, [own]), "alert");
    const clash = { resourceId: "0xr", source: "airbnb", ref: "uid-9", from: "2026-07-03", to: "2026-07-05" };
    const adjacent = { ...clash, from: "2026-07-04", to: "2026-07-06" }; // [from, to): touching is not overlap
    await lifecycle("INV-3", inv3(b, [own, clash]), inv3(b, [own, adjacent]), "alert");
  });

  it("INV-4 yield conservation pages when credited yield exceeds realised gain", async () => {
    const e = { ...newEscrowRow(31337, E), realisedGain: 100n, crystallisedYield: 100n };
    await lifecycle("INV-4", inv4({ ...e, crystallisedYield: 101n }), inv4(e), "page");
  });

  it("INV-5 liquidity alerts when idle is below what must stay liquid (spec 6.7)", async () => {
    const f = fields();
    const now = 1_780_000_000n;
    const soon = [booking({ checkInUtc: now + 13n * 86_400n, principalAtomic: 400_000_000n })];
    const later = [booking({ checkInUtc: now + 15n * 86_400n, principalAtomic: 400_000_000n })];
    const need = f.totalClaimable + f.totalDisputed + f.totalPendingYield;
    expect(requiredLiquid(f, soon, now)).toBe(need + 400_000_000n);
    expect(requiredLiquid(f, later, now)).toBe(need); // above the 10% floor here
    await lifecycle("INV-5", inv5(E, need, requiredLiquid(f, soon, now)), inv5(E, need, requiredLiquid(f, later, now)), "alert");
  });

  it("INV-6 settlement conservation: an inconsistent BookingSettled pages via the reducer", async () => {
    const store = new MemoryStore();
    await bootstrapEscrow(store, { chainId: 31337, escrow: E, vault: null });
    const ev = (name: string, args: Record<string, unknown>, logIndex: number): ChainEvent => ({
      name, args, chainId: 31337, address: E, blockNumber: 5n, blockHash: `0x${"00".repeat(32)}`, timestamp: 1n, txHash: `0x${"0a".repeat(32)}`, logIndex,
    });
    const id = `0x${"b0".repeat(32)}`;
    await reduce(store, ev("BookingDeposited", {
      bookingId: id, guest: "0x0000000000000000000000000000000000000001", resourceId: id, checkInUtc: 10n, checkOutUtc: 20n,
      principalAtomic: 1_000n, feeBps: 500, guestYieldBps: 5_000, policyHash: id, cutoffs: [], finalBps: 0,
      arbitrator: "0x0000000000000000000000000000000000000002", accAtDeposit: 0n,
    }, 0));
    const r = await reduce(store, ev("BookingSettled", {
      bookingId: id, outcome: 0, principalAtomic: 1_000n, refund: 0n, ownerPrincipal: 951n, fee: 50n, // 1 atomic unit too many
      y: 0n, guestYield: 0n, ownerYield: 0n, feeRecipient: "0x0000000000000000000000000000000000000003",
    }, 1));
    const inv6 = r.anomalies.filter((a) => a.code === "INV-6");
    expect(inv6).toHaveLength(1);
    const breach = fromAnomaly({ id: `${inv6[0]!.eventKey}:0`, escrow: E, code: "INV-6", message: inv6[0]!.message });
    expect(breach.invariant).toBe("INV-6");
    // Anomalies are facts: they are never auto-resolved, so check open and sent only.
    sent = [];
    outbox = new AlertOutbox(db.pool, 31337, [capture]);
    await outbox.sync("ANOMALY", [breach], { autoResolve: false });
    await outbox.sync("ANOMALY", [], { autoResolve: false });
    expect(sent.map((a) => [a.invariant, a.severity])).toEqual([["INV-6", "page"]]);
    const open = await db.pool.query("SELECT 1 FROM indexer_ops.alerts WHERE dedupe_key = $1 AND resolved_at IS NULL", [breach.key]);
    expect(open.rowCount).toBe(1);
  });

  it("RECONCILE: projection differing from the contract at the same block pages", async () => {
    const f = fields();
    await lifecycle("RECONCILE", reconcile(E, 9n, f, { ...f, totalClaimable: f.totalClaimable + 1n }), reconcile(E, 9n, f, f), "page");
  });

  it("LAG: a stalled projection pages", async () => {
    await lifecycle("LAG", lag(100n, 200n, 60n), lag(150n, 200n, 60n), "page");
  });
});
