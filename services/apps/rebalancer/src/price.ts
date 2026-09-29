// USDC price for the depeg gate (docs/adr/0019): Chainlink USDC/USD on Base, with Chainlink's L2
// sequencer uptime check (answer 0 = up; wait GRACE after it comes back, docs "L2 Sequencer Uptime
// Feeds"). Any doubt returns { ok: false }, which only ever stops deployment.
import { parseAbi, type Address, type PublicClient } from "viem";
import type { Price } from "./policy.js";

const AGG = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
]);

export type PriceSource = (now: bigint) => Promise<Price>;

export async function chainlinkPrice(
  client: PublicClient,
  o: { feed: Address; sequencerFeed?: Address; sequencerGraceSec?: bigint },
): Promise<PriceSource> {
  // Checked once at start: the feed must be what we think it is.
  const [dec, desc] = await Promise.all([
    client.readContract({ address: o.feed, abi: AGG, functionName: "decimals" }),
    client.readContract({ address: o.feed, abi: AGG, functionName: "description" }),
  ]);
  if (dec !== 8 || desc !== "USDC / USD") throw new Error(`price feed ${o.feed} is "${desc}" with ${dec} decimals`);
  return async (now) => {
    try {
      if (o.sequencerFeed) {
        const [, up, startedAt] = await client.readContract({ address: o.sequencerFeed, abi: AGG, functionName: "latestRoundData" });
        if (up !== 0n) return { ok: false, reason: "sequencer_down" };
        if (now - startedAt < (o.sequencerGraceSec ?? 3_600n)) return { ok: false, reason: "sequencer_grace_period" };
      }
      const [, answer, , updatedAt] = await client.readContract({ address: o.feed, abi: AGG, functionName: "latestRoundData" });
      if (answer <= 0n) return { ok: false, reason: "non_positive_answer" };
      if (updatedAt === 0n || updatedAt > now + 60n) return { ok: false, reason: "bad_timestamp" };
      return { ok: true, answer, updatedAt };
    } catch (e) {
      return { ok: false, reason: `read_failed: ${(e as Error).message.slice(0, 120)}` };
    }
  };
}

/** Testnets and Anvil only (no Chainlink USDC feed there): a constant $1.00, always fresh. */
export function fixedPrice(chainId: number): PriceSource {
  if (chainId === 8453) throw new Error("a fixed price is refused on Base mainnet");
  return async (now) => ({ ok: true, answer: 100_000_000n, updatedAt: now });
}
