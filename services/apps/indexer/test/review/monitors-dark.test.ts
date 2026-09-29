// Review 0005 R2: one escrow whose vault views revert (a broken vault, ADR 0013 §3,
// before the guardian writes it off) must not stop the monitors for the others, and the failed read
// must itself alert: every accrue-first function of that escrow reverts, so its funds are stuck.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { newEscrowRow } from "../../src/core/reducer.js";
import { runMonitors } from "../../src/worker/monitors.js";
import { AlertOutbox, type Alert } from "../../src/worker/notifier.js";
import { migrate } from "../../src/worker/main.js";
import type { Snapshot } from "../../src/worker/projection.js";
import { freshDb } from "../anvil/harness.js";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
});
afterAll(async () => db.drop());

const BROKEN = "0x00000000000000000000000000000000000000b0";
const OK = "0x00000000000000000000000000000000000000a0";

it("a reverting escrow read alerts, and the other escrows are still checked", async () => {
  const client = {
    getBlock: async () => ({ timestamp: 1_800_000_000n }),
    readContract: async ({ address, functionName }: { address: string; functionName: string }) => {
      if (address === BROKEN) throw new Error("execution reverted"); // totalAssets() -> vault.previewRedeem reverts
      if (functionName === "usdc") return "0x00000000000000000000000000000000000000c0";
      if (functionName === "totalAssets" || functionName === "balanceOf" || functionName === "lastAssets") return 100n;
      if (functionName === "totalOpenPrincipal") return 1_000_000_000n; // INV-1 breached on the healthy escrow
      return 0n;
    },
  } as unknown as PublicClient;
  const snap: Snapshot = {
    block: 10n,
    escrows: [newEscrowRow(31337, BROKEN), newEscrowRow(31337, OK)],
    bookings: [],
    balances: new Map(),
    anomalies: [],
  };
  const sent: Alert[] = [];
  const outbox = new AlertOutbox(db.pool, 31337, [{ notify: async (a) => void sent.push(a) }]);
  await runMonitors(db.pool, client, snap, new Map(), outbox).catch(() => {});
  const got = sent.map((a) => `${a.invariant}:${a.escrow}`);
  expect(got, JSON.stringify(got)).toContain(`INV-1:${OK}`);
  expect(got, JSON.stringify(got)).toContain(`READ_FAILED:${BROKEN}`);
  // The broken escrow's earlier alerts stay open: unknown is not cleared.
  await db.pool.query("INSERT INTO indexer_ops.alerts (dedupe_key, invariant, severity, chain_id, escrow, message) VALUES ($1, 'INV-1', 'page', 31337, $2, 'earlier')", [`INV-1:${BROKEN}`, BROKEN]);
  await runMonitors(db.pool, client, snap, new Map(), outbox);
  expect((await db.pool.query("SELECT 1 FROM indexer_ops.alerts WHERE dedupe_key = $1 AND resolved_at IS NULL", [`INV-1:${BROKEN}`])).rowCount).toBe(1);
});
