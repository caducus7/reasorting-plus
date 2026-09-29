// Review 0005 R3: a reverting chain read (a broken vault) leaves a decision row explaining the hold
// and pages; the page resolves when reads succeed again.
import { afterAll, beforeAll, expect, it } from "vitest";
import { AlertOutbox, type Alert } from "@chain/indexer/alerts";
import { createExecutor, type ChainPort } from "../../src/executor.js";
import { migrate } from "../../src/db.js";
import type { Snapshot } from "../../src/policy.js";
import { freshDb } from "../pg.js";

const U = 1_000_000n;
const E = "0x00000000000000000000000000000000000000e5";
let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
});
afterAll(async () => db.drop());

it("a read failure is logged and pages; recovery resolves it", async () => {
  let broken = true;
  const snap: Snapshot = {
    now: 1n, hasVault: true, vaultWrittenOff: false, vaultTotalSupply: 10n ** 18n, idle: 10n * U, idleFinalized: 10n * U,
    position: 0n, maxWithdraw: 0n, marketAvailable: 0n, lossDebt: 0n, shortfallSince: 0n, reserve: U, liabilities: 10n * U,
    maxDeployBps: 9_000, required: 1n * U, price: { ok: true, answer: 100_000_000n, updatedAt: 1n }, projectionLagBlocks: 0n,
  };
  const port = {
    chainId: 31337, escrow: E, sender: "0x0000000000000000000000000000000000000abc",
    snapshot: async () => {
      if (broken) throw new Error('The contract function "previewRedeem" reverted');
      return { snapshot: snap, block: 2n, rebalancer: "0x0000000000000000000000000000000000000abc" };
    },
  } as unknown as ChainPort;
  const sent: Alert[] = [];
  const ex = createExecutor({ pool: db.pool, chain: port, dryRun: true, alerts: new AlertOutbox(db.pool, 31337, [{ notify: async (a) => void sent.push(a) }]) });
  await ex.cycle();
  await ex.cycle();
  const rows = (await db.pool.query("SELECT kind, reason, detail FROM rebalancer.decisions ORDER BY id")).rows;
  expect(rows[0]).toMatchObject({ kind: "hold", reason: "read_failed" });
  expect(rows[0].detail).toMatch(/previewRedeem/);
  expect(sent.map((a) => [a.severity, a.key])).toEqual([["page", `REBALANCER:read_failed:${E}`]]); // once
  broken = false;
  await ex.cycle();
  expect((await db.pool.query("SELECT 1 FROM indexer_ops.alerts WHERE resolved_at IS NULL AND dedupe_key LIKE 'REBALANCER:read_failed:%'")).rowCount).toBe(0);
});
