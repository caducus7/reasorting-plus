// Brief C8 test 1: a table of scenarios with the expected decision for each (spec 6.7), and brief
// test 3 (first half): the policy can never emit a move the on-chain caps would reject, and a price
// move never causes a redeem.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decide, DEFAULTS, onchainDeployAllowed, type Snapshot } from "../src/policy.js";

const U = 1_000_000n; // 1 USDC
const NOW = 1_800_000_000n;

/** Healthy: 100k of far-future principal, nothing deployed, 1 USDC reserve, deep market, price 1.0. */
const base = (o: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  hasVault: true,
  vaultWrittenOff: false,
  vaultTotalSupply: 10n ** 18n,
  idle: 100_001n * U,
  idleFinalized: 100_001n * U,
  position: 0n,
  maxWithdraw: 0n,
  marketAvailable: 50_000_000n * U,
  lossDebt: 0n,
  shortfallSince: 0n,
  reserve: 1n * U,
  liabilities: 100_000n * U,
  maxDeployBps: 9_000,
  required: 10_000n * U,
  price: { ok: true, answer: 100_000_000n, updatedAt: NOW - 3_600n },
  projectionLagBlocks: 0n,
  ...o,
});

type Row = [name: string, s: Snapshot, expect: { kind: string; reason?: string; amount?: bigint }];
const rows: Row[] = [
  ["healthy: deploy up to the owner's maxDeployBps cap", base(), { kind: "deploy", amount: 90_000n * U }],
  ["booking inside 14 days: redeem the gap", base({ idle: 10_001n * U, idleFinalized: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, required: 60_000n * U }), { kind: "redeem", reason: "below_required", amount: 49_999n * U }],
  ["gap larger than the vault can pay now: redeem what it can", base({ idle: 1n * U, position: 90_000n * U, maxWithdraw: 20_000n * U, required: 60_000n * U }), { kind: "redeem", reason: "below_required", amount: 20_000n * U }],
  ["liquidity crunch (< 5x our position): redeem all we can", base({ idle: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, marketAvailable: 449_999n * U }), { kind: "redeem", reason: "liquidity_exit", amount: 90_000n * U }],
  ["at exactly 5x: stay", base({ idle: 10_001n * U, idleFinalized: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, marketAvailable: 450_000n * U }), { kind: "hold" }],
  ["depeg (-1.5%): no deploy", base({ price: { ok: true, answer: 98_500_000n, updatedAt: NOW - 60n } }), { kind: "hold", reason: "price_out_of_band" }],
  ["depeg (+1.5%): no deploy", base({ price: { ok: true, answer: 101_500_000n, updatedAt: NOW - 60n } }), { kind: "hold", reason: "price_out_of_band" }],
  ["depeg while deployed and liquid: never redeem because of price", base({ idle: 10_001n * U, idleFinalized: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, price: { ok: true, answer: 95_000_000n, updatedAt: NOW - 60n } }), { kind: "hold", reason: "price_out_of_band" }],
  // Review 0006 G2: the position is a USDC claim against USDC liabilities, so exiting during a depeg
  // realises no USD-price loss; what a depeg threatens is pool liquidity (Aave, March 2023). The exit wins.
  ["depeg and a liquidity crunch together: the liquidity exit still fires", base({ idle: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, marketAvailable: 449_999n * U, price: { ok: true, answer: 95_000_000n, updatedAt: NOW - 60n } }), { kind: "redeem", reason: "liquidity_exit", amount: 90_000n * U }],
  ["depeg, crunch and an unreadable price: the exit does not wait on the oracle", base({ idle: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, marketAvailable: 449_999n * U, price: { ok: false, reason: "sequencer_down" } }), { kind: "redeem", reason: "liquidity_exit", amount: 90_000n * U }],
  ["depeg and a booking inside 14 days: the refund comes first", base({ idle: 10_001n * U, position: 90_000n * U, maxWithdraw: 90_000n * U, required: 60_000n * U, price: { ok: true, answer: 95_000_000n, updatedAt: NOW - 60n } }), { kind: "redeem", reason: "below_required", amount: 49_999n * U }],
  ["within 1%: deploy", base({ price: { ok: true, answer: 99_000_000n, updatedAt: NOW - 60n } }), { kind: "deploy", amount: 90_000n * U }],
  ["lossDebt outstanding: no deploy", base({ lossDebt: 5n * U }), { kind: "hold", reason: "loss_active" }],
  ["shortfall observed: no deploy", base({ shortfallSince: NOW - 100n }), { kind: "hold", reason: "loss_active" }],
  ["stale price: no deploy", base({ price: { ok: true, answer: 100_000_000n, updatedAt: NOW - 90_001n } }), { kind: "hold", reason: "price_stale" }],
  ["price unreadable or sequencer down: no deploy", base({ price: { ok: false, reason: "sequencer_down" } }), { kind: "hold", reason: "price_unavailable" }],
  ["dust excess (< 500 USDC): no deploy", base({ idle: 10_400n * U, idleFinalized: 10_400n * U, liabilities: 10_000n * U, required: 10_000n * U }), { kind: "hold", reason: "below_minimum_move" }],
  ["only finalised deposits count", base({ idleFinalized: 60_001n * U }), { kind: "deploy", amount: 50_001n * U }],
  ["liquidity gate: after the move the market keeps >= 20x our position", base({ marketAvailable: 1_000_000n * U }), { kind: "deploy", amount: (1_000_000n * U) / 19n }],
  ["liquidity gate closed (< 20x already)", base({ position: 60_000n * U, maxWithdraw: 60_000n * U, idle: 40_001n * U, idleFinalized: 40_001n * U, marketAvailable: 1_100_000n * U }), { kind: "hold", reason: "liquidity_gate" }],
  ["reserve below the 1 USDC floor: no deploy (the contract would revert)", base({ reserve: 999_999n }), { kind: "hold", reason: "reserve_below_floor" }],
  ["vault written off: no deploy", base({ vaultWrittenOff: true }), { kind: "hold", reason: "vault_unavailable" }],
  ["no vault: nothing to do", base({ hasVault: false }), { kind: "hold", reason: "no_vault" }],
  ["cannot redeem the gap (vault pays nothing): hold and alert", base({ idle: 1n * U, position: 90_000n * U, maxWithdraw: 0n, required: 60_000n * U }), { kind: "hold", reason: "cannot_redeem" }],
  ["projection lagging: no deploy", base({ projectionLagBlocks: 200n }), { kind: "hold", reason: "projection_lagging" }],
];

describe("decide: spec 6.7 scenario table", () => {
  for (const [name, s, want] of rows) {
    it(name, () => {
      const d = decide(s);
      expect(d.kind, JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(want.kind);
      if (want.reason) expect(d.reason).toBe(want.reason);
      if (want.amount !== undefined) expect(d.kind !== "hold" && d.amount).toBe(want.amount);
      // Every decision carries the inputs and checks that explain it (brief acceptance).
      expect(d.checks.length).toBeGreaterThan(0);
    });
  }
  it("defaults are the spec's pilot values", () => {
    expect(DEFAULTS).toMatchObject({ minMoveAtomic: 500n * U, deployLiquidityX: 20n, exitLiquidityX: 5n, priceBandBps: 100n, maxPriceAgeSec: 90_000n });
  });
});

const big = (max: bigint) => fc.bigInt({ min: 0n, max });
const snapshot = fc.record({
  idle: big(10n ** 12n),
  idleFinalized: big(10n ** 12n),
  position: big(10n ** 12n),
  maxWithdraw: big(10n ** 12n),
  marketAvailable: big(10n ** 15n),
  lossDebt: fc.constantFrom(0n, 0n, 0n, 1n),
  shortfallSince: fc.constantFrom(0n, 0n, 0n, 5n),
  reserve: big(3_000_000n),
  liabilities: big(10n ** 12n),
  maxDeployBps: fc.integer({ min: 0, max: 9_000 }),
  required: big(10n ** 12n),
  vaultTotalSupply: fc.constantFrom(0n, 999_999n, 10n ** 18n),
  vaultWrittenOff: fc.boolean(),
  answer: fc.bigInt({ min: 90_000_000n, max: 110_000_000n }),
  age: fc.bigInt({ min: 0n, max: 200_000n }),
});

describe("decide: properties (brief test 3, first half)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mk = (r: any): Snapshot =>
    base({ ...r, idleFinalized: r.idleFinalized > r.idle ? r.idle : r.idleFinalized, maxWithdraw: r.maxWithdraw > r.position ? r.position : r.maxWithdraw, price: { ok: true, answer: r.answer, updatedAt: NOW - r.age } });

  it("never emits a deploy the contract's caps would reject, nor a redeem the vault cannot pay", () => {
    fc.assert(
      fc.property(snapshot, (r) => {
        const s = mk(r);
        const d = decide(s);
        if (d.kind === "deploy") expect(onchainDeployAllowed(s, d.amount)).toEqual({ ok: true });
        if (d.kind === "redeem") {
          expect(d.amount > 0n).toBe(true);
          expect(d.amount <= s.maxWithdraw && d.amount <= s.position).toBe(true);
        }
      }),
      { numRuns: 20_000 },
    );
  });

  it("a price move never turns a hold or deploy into a redeem, and never deploys when out of band", () => {
    fc.assert(
      fc.property(snapshot, fc.bigInt({ min: 50_000_000n, max: 150_000_000n }), (r, bad) => {
        const good = decide(mk({ ...r, answer: 100_000_000n, age: 0n }));
        const moved = decide(mk({ ...r, answer: bad, age: 0n }));
        if (moved.kind === "redeem") expect(good).toMatchObject({ kind: "redeem", amount: moved.amount });
        const off = bad < 99_000_000n || bad > 101_000_000n;
        if (off) expect(moved.kind).not.toBe("deploy");
      }),
      { numRuns: 20_000 },
    );
  });

  // Deploy-biased generator: the gates open, so the property exercises the amount bounds themselves
  // (a uniform generator reaches a deploy in ~0.03% of runs).
  const deployish = fc
    .record({
      liabilities: fc.bigInt({ min: 0n, max: 10n ** 12n }),
      idleFrac: fc.bigInt({ min: 0n, max: 12_000n }),
      reqFrac: fc.bigInt({ min: 0n, max: 10_000n }),
      finFrac: fc.bigInt({ min: 5_000n, max: 10_000n }),
      posFrac: fc.bigInt({ min: 0n, max: 10_000n }),
      mwFrac: fc.bigInt({ min: 0n, max: 10_000n }),
      mktX: fc.bigInt({ min: 0n, max: 60n }),
      maxDeployBps: fc.integer({ min: 0, max: 9_000 }),
      reserve: fc.bigInt({ min: 900_000n, max: 3_000_000n }),
    })
    .map((r) => {
      const idle = (r.liabilities * r.idleFrac) / 10_000n;
      const position = (r.liabilities * r.posFrac) / 10_000n;
      return base({
        liabilities: r.liabilities,
        idle,
        idleFinalized: (idle * r.finFrac) / 10_000n,
        required: (idle * r.reqFrac) / 10_000n,
        position,
        maxWithdraw: (position * r.mwFrac) / 10_000n,
        marketAvailable: (r.mktX * position) + 10n ** 9n,
        maxDeployBps: r.maxDeployBps,
        reserve: r.reserve,
      });
    });

  it("deploy-biased: every emitted deploy passes the on-chain checks, and deploys do happen", () => {
    let deploys = 0;
    fc.assert(
      fc.property(deployish, (s) => {
        const d = decide(s);
        // The final on-chain check is a backstop: the bounds alone must already satisfy it, else the
        // policy holds where a smaller valid deploy existed.
        if (d.kind === "hold") expect(d.reason.startsWith("precheck_"), d.reason).toBe(false);
        if (d.kind === "deploy") {
          deploys++;
          expect(onchainDeployAllowed(s, d.amount)).toEqual({ ok: true });
          expect(d.amount >= DEFAULTS.minMoveAtomic).toBe(true);
          expect(d.amount <= (s.idle < s.idleFinalized ? s.idle : s.idleFinalized) - s.required).toBe(true);
          expect(s.marketAvailable + d.amount >= 20n * (s.position + d.amount)).toBe(true);
        }
      }),
      { numRuns: 20_000 },
    );
    expect(deploys).toBeGreaterThan(1_000); // ~8.7% of runs deploy
  });
});
