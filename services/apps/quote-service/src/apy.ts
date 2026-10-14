// Live supply APY for the yield estimate (brief C5: "current APY from the adapter or market",
// labelled an estimate, with asOf). The escrow's vault is the Aave StataTokenV2 wrapper over the
// Base USDC reserve; the wrapper adds no fee layer (C4 fork test test_noFeeLayerOver30Days), so the
// reserve's supply rate is the vault's rate.
//
// Aave V3 Pool.getReserveData(asset).currentLiquidityRate is the supply APR in ray (1e27). Aave
// compounds it per second; APY = exp(APR) - 1 matches (1 + APR/31,536,000)^31,536,000 - 1 to within
// 1e-8 at these rates (review: 3.804% APR gives 387.7507 bps both ways). Rounded down to whole bps:
// an estimate shown to a guest must not overstate.
//
// A rate read never fails the endpoint: the last good read serves for maxAgeSec, then the configured
// APY_ESTIMATE_BPS (spec 5.3: "always labelled an estimate"; asOf says when the rate was observed).
import { parseAbi, type Address, type PublicClient } from "viem";

export type Apy = { bps: number; asOf: number; source: "market" | "config" };
export type ApySource = () => Promise<Apy>;

const RAY = 10n ** 27n;

/** floor((exp(aprRay / 1e27) - 1) * 10_000), exact in bigint (Taylor series in ray). */
export function aprRayToApyBps(aprRay: bigint): number {
  if (aprRay < 0n) throw new Error("negative rate");
  if (aprRay > 5n * RAY) throw new Error("rate above 500% APR is not a supply rate");
  let term = RAY;
  let sum = 0n;
  for (let k = 1n; k < 200n && term > 0n; k++) {
    term = (term * aprRay) / RAY / k;
    sum += term;
  }
  return Number((sum * 10_000n) / RAY);
}

export const aavePoolAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

/** Reads the reserve's supply rate; `asOf` is the block's timestamp. */
export function aaveSupplyRate(client: Pick<PublicClient, "readContract" | "getBlock">, pool: Address, asset: Address) {
  return async (): Promise<{ aprRay: bigint; asOf: number }> => {
    const block = await client.getBlock({ blockTag: "latest" });
    const r = await client.readContract({ address: pool, abi: aavePoolAbi, functionName: "getReserveData", args: [asset], blockNumber: block.number! });
    return { aprRay: r.currentLiquidityRate, asOf: Number(block.timestamp) };
  };
}

export function staticApy(bps: number, now: () => Date = () => new Date()): ApySource {
  return async () => ({ bps, asOf: Math.floor(now().getTime() / 1000), source: "config" });
}

/** Cached market APY with a bounded fallback. */
export function marketApy(
  read: () => Promise<{ aprRay: bigint; asOf: number }>,
  o: { fallbackBps: number; ttlSec?: number; maxAgeSec?: number; now?: () => Date; log?: (msg: string) => void },
): ApySource {
  const now = o.now ?? (() => new Date());
  const ttl = o.ttlSec ?? 300;
  const maxAge = o.maxAgeSec ?? 3_600;
  const log = o.log ?? ((m) => console.warn(m));
  let last: { bps: number; asOf: number; fetchedAt: number } | null = null;
  let inflight: Promise<void> | null = null;
  const refresh = async () => {
    try {
      const r = await read();
      last = { bps: aprRayToApyBps(r.aprRay), asOf: r.asOf, fetchedAt: Math.floor(now().getTime() / 1000) };
    } catch (e) {
      log(`apy: market read failed: ${(e as Error).message}`);
    }
  };
  return async () => {
    const t = Math.floor(now().getTime() / 1000);
    if (!last || t - last.fetchedAt >= ttl) {
      inflight ??= refresh().finally(() => (inflight = null));
      await inflight;
    }
    if (last && t - last.fetchedAt < maxAge) return { bps: last.bps, asOf: last.asOf, source: "market" };
    return { bps: o.fallbackBps, asOf: t, source: "config" };
  };
}
