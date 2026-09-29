// Review 0005 R1: one rebalancer key serving two escrows (main.ts's ESCROWS list).
// Escrow A has a transaction in flight at nonce 5; escrow B's next cycle must not sign at nonce 5,
// or one replaces or blocks the other.
import { afterAll, beforeAll, expect, it } from "vitest";
import { createExecutor, type ChainPort, type SignRequest } from "../../src/executor.js";
import { migrate } from "../../src/db.js";
import type { Snapshot } from "../../src/policy.js";
import { freshDb } from "../pg.js";

const U = 1_000_000n;
const ME = "0x0000000000000000000000000000000000000abc";
let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
});
afterAll(async () => db.drop());

const healthy: Snapshot = {
  now: 1_800_000_000n, hasVault: true, vaultWrittenOff: false, vaultTotalSupply: 10n ** 18n,
  idle: 100_001n * U, idleFinalized: 100_001n * U, position: 0n, maxWithdraw: 0n, marketAvailable: 50_000_000n * U,
  lossDebt: 0n, shortfallSince: 0n, reserve: U, liabilities: 100_000n * U, maxDeployBps: 9_000, required: 10_000n * U,
  price: { ok: true, answer: 100_000_000n, updatedAt: 1_799_999_000n }, projectionLagBlocks: 0n,
};

it("two escrows sharing one key never sign at the same nonce", async () => {
  const signed: SignRequest[] = [];
  const shared = { minedNonce: 5 }; // one account: one nonce sequence
  const port = (escrow: string): ChainPort => ({
    chainId: 31337, escrow, sender: ME,
    snapshot: async () => ({ snapshot: healthy, block: 1n, rebalancer: ME }),
    simulate: async () => ({ ok: true }),
    nonce: async () => shared.minedNonce,
    fees: async () => ({ maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n }),
    sign: async (req) => (signed.push(req), { raw: `0x${escrow.slice(2, 6)}${req.nonce}`, hash: `0x${escrow.slice(2, 10)}${String(req.nonce).padStart(56, "0")}` }),
    send: async () => {},
    receipt: async () => null,
  });
  const a = createExecutor({ pool: db.pool, chain: port("0x00000000000000000000000000000000000000aa"), dryRun: false });
  const b = createExecutor({ pool: db.pool, chain: port("0x00000000000000000000000000000000000000bb"), dryRun: false });
  await a.cycle(); // A: deploy at nonce 5, unmined
  await b.cycle(); // B: must not reuse nonce 5
  const nonces = signed.map((s) => s.nonce);
  expect(new Set(nonces).size, `nonces signed: ${nonces}`).toBe(nonces.length);
  const b2 = (await db.pool.query("SELECT outcome FROM rebalancer.decisions WHERE escrow = $1 ORDER BY id DESC LIMIT 1", ["0x00000000000000000000000000000000000000bb"])).rows[0];
  expect(b2.outcome).toBe("sender_busy");
});
