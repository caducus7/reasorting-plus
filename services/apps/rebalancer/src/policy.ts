// Rebalancer policy (spec 6.7, C8 brief) as one pure function over a snapshot, so every decision is
// explainable from its inputs and checks alone (brief acceptance) and testable without a chain.
//
// Order, safety first:
//   1. Exit: market available liquidity < 5x our position -> redeem all we can.
//   2. Refunds: idle < required liquid -> redeem the gap (whatever the price: this is not a
//      price-driven redeem, it is the guest's money being needed).
//   3. Deploy only if every gate passes; failing safe means not deploying. Never redeem because of
//      the USDC price (spec 6.7: redeeming during a depeg locks in the loss).
// Deploy amounts respect, exactly, the checks LedgerLib.deploy makes on-chain (onchainDeployAllowed),
// so the rebalancer can never produce a transaction the caps would reject.

export const BPS = 10_000n;
export const MIN_BUFFER_BPS = 1_000n; // Params.sol
export const MIN_VAULT_SUPPLY = 1_000_000n; // Params.sol (shares)
export const RESERVE_FLOOR = 1_000_000n; // Params.sol (1 USDC)
export const PRICE_ONE = 100_000_000n; // Chainlink USD feeds: 8 decimals

export const DEFAULTS = {
  minMoveAtomic: 500_000_000n, // spec 6.7: 500 USDC
  deployLiquidityX: 20n, // deploy only if available >= 20x our position after the move
  exitLiquidityX: 5n, // redeem all if available < 5x our position
  priceBandBps: 100n, // ±1%
  maxPriceAgeSec: 90_000n, // USDC/USD on Base heartbeat is 24 h (measured, docs/adr/0019) + 1 h
  maxProjectionLagBlocks: 60n,
};
export type Config = typeof DEFAULTS;

export type Price = { ok: true; answer: bigint; updatedAt: bigint } | { ok: false; reason: string };

export type Snapshot = {
  now: bigint; // chain time
  hasVault: boolean;
  vaultWrittenOff: boolean;
  vaultTotalSupply: bigint;
  idle: bigint; // escrow USDC balance at latest
  idleFinalized: bigint; // escrow USDC balance at the finalized head (spec 10.2)
  position: bigint; // vault.previewRedeem(vault.balanceOf(escrow)) = on-chain "deployed"
  maxWithdraw: bigint; // vault.maxWithdraw(escrow)
  marketAvailable: bigint; // market available liquidity (Aave: Pool.getVirtualUnderlyingBalance)
  lossDebt: bigint;
  shortfallSince: bigint;
  reserve: bigint;
  liabilities: bigint; // on-chain: open + disputed + pending + claimable
  maxDeployBps: number;
  required: bigint; // required liquid amount (spec 6.7), computed conservatively
  price: Price;
  projectionLagBlocks: bigint;
};

export type Check = { name: string; ok: boolean; detail?: string };
export type Decision =
  | { kind: "redeem"; amount: bigint; reason: "liquidity_exit" | "below_required"; checks: Check[] }
  | { kind: "deploy"; amount: bigint; reason: "excess"; checks: Check[] }
  | { kind: "hold"; reason: string; alert?: boolean; checks: Check[] };

const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a));
const s = (x: bigint) => x.toString();

/** LedgerLib.deploy / Escrow.deploy, check for check (docs/adr/0013, spec 6.3). */
export function onchainDeployAllowed(x: Snapshot, a: bigint): { ok: true } | { ok: false; error: string } {
  if (x.vaultWrittenOff) return { ok: false, error: "VaultIsWrittenOff" };
  if (!x.hasVault) return { ok: false, error: "NoVault" };
  if (a === 0n) return { ok: false, error: "ZeroAmount" };
  if (x.lossDebt !== 0n) return { ok: false, error: "LossDebtOutstanding" };
  if (x.shortfallSince !== 0n) return { ok: false, error: "ShortfallPending" };
  if (x.vaultTotalSupply < MIN_VAULT_SUPPLY) return { ok: false, error: "VaultNotSeeded" };
  if (x.reserve < RESERVE_FLOOR) return { ok: false, error: "ReserveBelowFloor" };
  if (a > x.idle || x.idle - a < (x.liabilities * MIN_BUFFER_BPS) / BPS) return { ok: false, error: "BufferBreached" };
  if (x.position + a > (x.liabilities * BigInt(x.maxDeployBps)) / BPS) return { ok: false, error: "DeployCapExceeded" };
  return { ok: true };
}

export function decide(x: Snapshot, cfg: Config = DEFAULTS): Decision {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => (checks.push({ name, ok, detail }), ok);
  const hold = (reason: string, alert = false): Decision => ({ kind: "hold", reason, alert, checks });

  if (!check("vault configured", x.hasVault)) return hold("no_vault");

  // 1. Exit on thin market liquidity (not price-driven).
  if (x.position > 0n) {
    const thin = x.marketAvailable < cfg.exitLiquidityX * x.position;
    check("market liquidity >= exit multiple of position", !thin, `${s(x.marketAvailable)} vs ${cfg.exitLiquidityX}x ${s(x.position)}`);
    if (thin) {
      const amount = min(x.position, x.maxWithdraw);
      return amount > 0n ? { kind: "redeem", amount, reason: "liquidity_exit", checks } : hold("cannot_redeem", true);
    }
  }

  // 2. Refunds first.
  const below = x.idle < x.required;
  check("idle >= required liquid", !below, `${s(x.idle)} vs ${s(x.required)}`);
  if (below) {
    const amount = min(x.required - x.idle, x.position, x.maxWithdraw);
    return amount > 0n ? { kind: "redeem", amount, reason: "below_required", checks } : hold("cannot_redeem", true);
  }

  // 3. Deploy gates. Failing any of them means holding.
  if (!check("vault usable (not written off, seeded)", !x.vaultWrittenOff && x.vaultTotalSupply >= MIN_VAULT_SUPPLY)) return hold("vault_unavailable");
  if (!check("no loss active (lossDebt, shortfall)", x.lossDebt === 0n && x.shortfallSince === 0n, `lossDebt ${s(x.lossDebt)} since ${s(x.shortfallSince)}`)) return hold("loss_active");
  if (!x.price.ok) return check("price readable, sequencer up", false, x.price.reason), hold("price_unavailable");
  if (!check("price fresh", x.now - x.price.updatedAt <= cfg.maxPriceAgeSec, `age ${s(x.now - x.price.updatedAt)} s`)) return hold("price_stale");
  const dev = x.price.answer > PRICE_ONE ? x.price.answer - PRICE_ONE : PRICE_ONE - x.price.answer;
  if (!check("USDC within band", dev * BPS <= cfg.priceBandBps * PRICE_ONE, `answer ${s(x.price.answer)}`)) return hold("price_out_of_band");
  if (!check("reserve >= floor", x.reserve >= RESERVE_FLOOR, s(x.reserve))) return hold("reserve_below_floor", true);
  if (!check("projection current", x.projectionLagBlocks <= cfg.maxProjectionLagBlocks, `${s(x.projectionLagBlocks)} blocks`)) return hold("projection_lagging");

  const idleFinal = min(x.idle, x.idleFinalized); // only finalised deposits count
  const bounds: [string, bigint][] = [
    ["below_minimum_move", idleFinal > x.required ? idleFinal - x.required : 0n], // excess
    ["buffer", ((): bigint => {
      const floor = (x.liabilities * MIN_BUFFER_BPS) / BPS;
      return x.idle > floor ? x.idle - floor : 0n;
    })()],
    ["deploy_cap", ((): bigint => {
      const cap = (x.liabilities * BigInt(x.maxDeployBps)) / BPS;
      return cap > x.position ? cap - x.position : 0n;
    })()],
    // available + a >= X (position + a)  <=>  a <= (available - X position) / (X - 1)
    ["liquidity_gate", ((): bigint => {
      const need = cfg.deployLiquidityX * x.position;
      return x.marketAvailable > need ? (x.marketAvailable - need) / (cfg.deployLiquidityX - 1n) : 0n;
    })()],
  ];
  for (const [n, v] of bounds) check(`bound ${n}`, true, s(v));
  const [binding, amount] = bounds.reduce((a, b) => (b[1] < a[1] ? b : a));
  if (!check("amount >= minimum move", amount >= cfg.minMoveAtomic, `${s(amount)} (bound: ${binding})`)) return hold(binding);
  const onchain = onchainDeployAllowed(x, amount);
  if (!check("on-chain caps permit", onchain.ok, onchain.ok ? undefined : onchain.error)) return hold(`precheck_${onchain.ok ? "" : onchain.error}`, true);
  return { kind: "deploy", amount, reason: "excess", checks };
}
