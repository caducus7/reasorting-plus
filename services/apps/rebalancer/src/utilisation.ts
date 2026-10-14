// Market utilisation: monitoring and alerting only, never a gate (spec 6.7; at ~90% on Base a gate
// would idle funds permanently). Exit liquidity is gated directly by policy.ts.
//
// Aave V3 definition: utilisation = totalDebt / (virtualUnderlyingBalance + totalDebt), the ratio its
// interest-rate strategy prices. The alert threshold follows the reserve's own kink, read on chain
// (DefaultReserveInterestRateStrategyV2.getOptimalUsageRatio), so a governance change moves it:
//   raise at optimal + half the headroom to 100% (95% at the 90% kink measured on 2026-10-14);
//   resolve at or below the optimal ratio (hysteresis: the market sits at the kink most of the time,
//   docs/spikes/c8-liquidity: 77-91% over 90 days).
import { parseAbi, type Address, type PublicClient } from "viem";
import type { AlertOutbox } from "@chain/indexer/alerts";

export type Utilisation = { debt: bigint; available: bigint; utilBps: bigint; optimalBps: bigint; blockNumber: bigint };
export type UtilisationSource = () => Promise<Utilisation>;

const RAY = 10n ** 27n;
const BPS = 10_000n;

const poolAbi = parseAbi([
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
  "function getVirtualUnderlyingBalance(address) view returns (uint128)",
]);
const erc20Abi = parseAbi(["function totalSupply() view returns (uint256)"]);
const strategyAbi = parseAbi(["function getOptimalUsageRatio(address reserve) view returns (uint256)"]);

/** utilisation in bps, rounded down; 0 for an empty market. */
export function utilisationBps(debt: bigint, available: bigint): bigint {
  const total = debt + available;
  return total === 0n ? 0n : (debt * BPS) / total;
}

export function aaveUtilisation(client: Pick<PublicClient, "readContract" | "getBlockNumber">, pool: Address, asset: Address): UtilisationSource {
  return async () => {
    const blockNumber = await client.getBlockNumber();
    const r = await client.readContract({ address: pool, abi: poolAbi, functionName: "getReserveData", args: [asset], blockNumber });
    const [debt, available, optimalRay] = await Promise.all([
      client.readContract({ address: r.variableDebtTokenAddress, abi: erc20Abi, functionName: "totalSupply", blockNumber }),
      client.readContract({ address: pool, abi: poolAbi, functionName: "getVirtualUnderlyingBalance", args: [asset], blockNumber }),
      client.readContract({ address: r.interestRateStrategyAddress, abi: strategyAbi, functionName: "getOptimalUsageRatio", args: [asset], blockNumber }),
    ]);
    return { debt, available, utilBps: utilisationBps(debt, available), optimalBps: (optimalRay * BPS) / RAY, blockNumber };
  };
}

export type UtilisationAction = "raise" | "resolve" | "keep";

/** Pure threshold with hysteresis. */
export function utilisationAction(u: Pick<Utilisation, "utilBps" | "optimalBps">): UtilisationAction {
  const raiseAt = u.optimalBps + (BPS - u.optimalBps) / 2n;
  if (u.utilBps >= raiseAt) return "raise";
  if (u.utilBps <= u.optimalBps) return "resolve";
  return "keep";
}

/** One check: logs the reading (the monitoring half) and opens or resolves the alert. A failed read
 * is logged, not paged: the per-escrow read_failed path already pages when reads break. */
export function utilisationMonitor(read: UtilisationSource, alerts: Pick<AlertOutbox, "open" | "resolve">, o: { market: string; log?: (line: string) => void }) {
  const log = o.log ?? ((l) => console.log(l));
  const key = `UTILISATION:${o.market}`;
  return async (): Promise<UtilisationAction | "read_failed"> => {
    let u: Utilisation;
    try {
      u = await read();
    } catch (e) {
      log(JSON.stringify({ utilisation: "read_failed", market: o.market, error: (e as Error).message }));
      return "read_failed";
    }
    const action = utilisationAction(u);
    log(JSON.stringify({ utilisation: `${u.utilBps}`, optimal: `${u.optimalBps}`, debt: `${u.debt}`, available: `${u.available}`, block: `${u.blockNumber}`, market: o.market, action }));
    if (action === "raise") {
      await alerts.open([
        {
          invariant: "UTILISATION",
          severity: "alert",
          key,
          message: `${o.market} utilisation ${Number(u.utilBps) / 100}% is above the ${Number(u.optimalBps) / 100}% kink by more than half the headroom: exit liquidity is thinning (monitoring only; the 5x exit rule acts on liquidity)`,
          details: { utilBps: Number(u.utilBps), optimalBps: Number(u.optimalBps), available: u.available.toString() },
          response: ["watch_market_liquidity"],
        },
      ]);
    } else if (action === "resolve") {
      await alerts.resolve([key]);
    }
    return action;
  };
}
