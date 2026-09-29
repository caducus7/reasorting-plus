// Market available liquidity (spec 6.7 liquidity gate).
import { parseAbi, type Address, type PublicClient } from "viem";

export type LiquiditySource = (blockNumber: bigint) => Promise<bigint>;

/** Aave V3: the reserve's virtual underlying balance, which caps StataTokenV2 maxWithdraw
 * (docs/adr/0016; Pool address from bgd-labs/aave-address-book AaveV3Base.POOL). */
export function aaveLiquidity(client: PublicClient, pool: Address, usdc: Address): LiquiditySource {
  const abi = parseAbi(["function getVirtualUnderlyingBalance(address) view returns (uint128)"]);
  return (blockNumber) => client.readContract({ address: pool, abi, functionName: "getVirtualUnderlyingBalance", args: [usdc], blockNumber });
}

/** Testnet MockYieldVault: its withdraw limit is the simulated market liquidity (set it below 5x the
 * position to demo a crunch); no limit set means an unconstrained market. */
export function mockVaultLiquidity(client: PublicClient, vault: Address): LiquiditySource {
  const abi = parseAbi(["function withdrawLimit() view returns (uint256)"]);
  return async (blockNumber) => {
    const lim = await client.readContract({ address: vault, abi, functionName: "withdrawLimit", blockNumber });
    return lim === 2n ** 256n - 1n ? 2n ** 128n : lim;
  };
}
