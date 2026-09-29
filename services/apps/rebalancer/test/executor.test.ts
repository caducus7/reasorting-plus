// Brief C8 test 3 (second half) and "Watch for": the executor pre-checks every move, never loops on
// a revert, keeps one transaction in flight per escrow, replaces a stuck one at the same nonce (never
// a second deploy), cancels it if the decision no longer holds, survives a restart mid-flight, and
// never sends in dry-run mode.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutor, type ChainPort, type Sent } from "../src/executor.js";
import { migrate } from "../src/db.js";
import type { Snapshot } from "../src/policy.js";
import { freshDb } from "./pg.js";

const U = 1_000_000n;
const ESCROW = "0x00000000000000000000000000000000000000e5";
const ME = "0x0000000000000000000000000000000000000abc";
let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
});
afterAll(async () => db.drop());
beforeEach(async () => {
  await db.pool.query("TRUNCATE rebalancer.decisions, rebalancer.pending_tx, rebalancer.cooldowns, rebalancer.required_liquid");
});

const healthy: Snapshot = {
  now: 1_800_000_000n, hasVault: true, vaultWrittenOff: false, vaultTotalSupply: 10n ** 18n,
  idle: 100_001n * U, idleFinalized: 100_001n * U, position: 0n, maxWithdraw: 0n, marketAvailable: 50_000_000n * U,
  lossDebt: 0n, shortfallSince: 0n, reserve: U, liabilities: 100_000n * U, maxDeployBps: 9_000, required: 10_000n * U,
  price: { ok: true, answer: 100_000_000n, updatedAt: 1_799_999_000n }, projectionLagBlocks: 0n,
};

/** A scriptable fake chain. */
function fakeChain(o: { snapshot?: () => Snapshot; simulate?: () => { ok: true } | { ok: false; error: string } } = {}) {
  const f = {
    sent: [] as Sent[],
    simulated: 0,
    mined: new Map<string, "success" | "reverted">(),
    nonce: 5,
    fees: { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n },
    snap: o.snapshot ?? (() => healthy),
    sendFails: false,
  };
  const port: ChainPort = {
    chainId: 31337,
    escrow: ESCROW,
    sender: ME,
    snapshot: async () => ({ snapshot: f.snap(), block: 100n, rebalancer: ME }),
    simulate: async () => (f.simulated++, (o.simulate ?? (() => ({ ok: true as const })))()),
    nonce: async () => f.nonce,
    fees: async () => f.fees,
    sign: async (req) => {
      const hash = `0x${Buffer.from(`${req.kind}:${req.nonce}:${req.maxFeePerGas}`).toString("hex").padEnd(64, "0").slice(0, 64)}`;
      return { raw: `0xraw${hash.slice(2)}`, hash };
    },
    send: async (raw) => {
      if (f.sendFails) throw new Error("network");
      f.sent.push({ raw });
    },
    receipt: async (h) => (f.mined.has(h) ? { status: f.mined.get(h)! } : null),
  };
  return { f, port };
}

let clock = new Date("2026-10-01T00:00:00Z");
const tick = (sec: number) => (clock = new Date(clock.getTime() + sec * 1000));
const make = (port: ChainPort, dryRun = false) =>
  createExecutor({ pool: db.pool, chain: port, dryRun, now: () => clock, stuckAfterSec: 180, cooldownSec: 600, maxCooldownSec: 21_600 });
const rows = async () => (await db.pool.query("SELECT kind, reason, outcome, amount::text, tx_hash FROM rebalancer.decisions ORDER BY id")).rows;

describe("executor", () => {
  it("dry run (the default) logs the decision and never signs or sends", async () => {
    const { f, port } = fakeChain();
    const ex = make(port, true);
    await ex.cycle();
    expect(f.sent).toEqual([]);
    expect((await rows())[0]).toMatchObject({ kind: "deploy", outcome: "dry_run", amount: `${90_000n * U}` });
  });

  it("pre-checks every move; a pre-check revert backs off and does not retry every cycle", async () => {
    const { f, port } = fakeChain({ simulate: () => ({ ok: false, error: "DeployCapExceeded" }) });
    const ex = make(port);
    for (let i = 0; i < 10; i++) {
      await ex.cycle();
      tick(60);
    }
    expect(f.sent).toEqual([]);
    expect(f.simulated).toBe(1); // 10 minutes of cooldown after the first revert
    tick(60);
    await ex.cycle();
    expect(f.simulated).toBe(2);
    await ex.cycle(); // second strike doubles the cooldown
    tick(900);
    await ex.cycle();
    expect(f.simulated).toBe(2);
    const outcomes = (await rows()).map((r) => r.outcome);
    expect(outcomes.filter((o) => o === "precheck_reverted")).toHaveLength(2);
  });

  it("one transaction in flight; mined success is recorded", async () => {
    const { f, port } = fakeChain();
    const ex = make(port);
    await ex.cycle();
    expect(f.sent).toHaveLength(1);
    await ex.cycle(); // pending, not stuck: nothing new
    expect(f.sent).toHaveLength(1);
    const p = (await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rows[0];
    f.mined.set(p.hashes[0], "success");
    await ex.cycle();
    expect((await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rowCount).toBe(0);
    expect((await rows()).map((r) => r.outcome)).toContain("mined");
  });

  it("a stuck transaction is replaced at the same nonce with >= 12.5% higher fees, never a second deploy", async () => {
    const { f, port } = fakeChain();
    const ex = make(port);
    await ex.cycle();
    tick(200);
    await ex.cycle();
    const p = (await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rows[0];
    expect(p.hashes).toHaveLength(2);
    expect(Number(p.nonce)).toBe(5);
    expect(BigInt(p.max_fee)).toBeGreaterThanOrEqual((1_000n * 1125n) / 1000n);
    expect(BigInt(p.priority_fee)).toBeGreaterThanOrEqual((100n * 1125n) / 1000n);
    // The first broadcast mines after all: it is recorded and nothing else is sent.
    f.mined.set(p.hashes[0], "success");
    await ex.cycle();
    expect(f.sent).toHaveLength(2);
    expect((await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rowCount).toBe(0);
  });

  it("if the decision no longer holds when a transaction is stuck, it is cancelled at the same nonce", async () => {
    let depeg = false;
    const { f, port } = fakeChain({ snapshot: () => (depeg ? { ...healthy, price: { ok: true, answer: 95_000_000n, updatedAt: 1_799_999_000n } } : healthy) });
    const ex = make(port);
    await ex.cycle();
    depeg = true;
    tick(200);
    await ex.cycle();
    const p = (await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rows[0];
    expect(p.kind).toBe("cancel");
    expect(Number(p.nonce)).toBe(5);
    expect((await rows()).map((r) => r.kind)).toContain("cancel");
  });

  it("a restart mid-flight resumes the pending transaction (rebroadcast), not a new one", async () => {
    const { f, port } = fakeChain();
    f.sendFails = true; // crash between the write-ahead row and the broadcast
    await make(port).cycle().catch(() => {});
    expect((await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rowCount).toBe(1);
    f.sendFails = false;
    const ex2 = make(port); // new process
    await ex2.cycle();
    expect(f.sent).toHaveLength(1); // the same signed transaction, rebroadcast
    expect(f.simulated).toBe(1);
  });

  it("an on-chain revert is recorded and cools down; a nonce used by someone else is detected", async () => {
    const { f, port } = fakeChain();
    const ex = make(port);
    await ex.cycle();
    const p = (await db.pool.query("SELECT * FROM rebalancer.pending_tx")).rows[0];
    f.mined.set(p.hashes[0], "reverted");
    f.nonce = 6; // a mined transaction, even a reverted one, consumes its nonce
    await ex.cycle();
    await ex.cycle();
    expect(f.sent).toHaveLength(1); // cooling down
    expect((await rows()).map((r) => r.outcome)).toContain("reverted");
    tick(700);
    await ex.cycle();
    expect(f.sent).toHaveLength(2);
    f.nonce = 8; // our nonce 6 was consumed by another transaction
    await ex.cycle();
    expect((await rows()).map((r) => r.outcome)).toContain("nonce_consumed");
  });

  it("refuses to act when this key is not the escrow's rebalancer", async () => {
    const { f, port } = fakeChain();
    const ex = make({ ...port, snapshot: async () => ({ snapshot: healthy, block: 1n, rebalancer: "0x0000000000000000000000000000000000000def" }) });
    await ex.cycle();
    expect(f.sent).toEqual([]);
    expect((await rows())[0]).toMatchObject({ outcome: "not_rebalancer" });
  });
});
