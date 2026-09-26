// Live escrow reads for prepare (C5 brief: "read the live effectiveFeeBps() and guestYieldBps
// from chain ... not from a cache older than the current block"). Every value is read at one
// pinned block so the terms are mutually consistent.

import { erc20Abi, type Address, type PublicClient } from "viem";
import { escrowAbi } from "@chain/abi";

export type LiveTerms = {
  blockNumber: bigint;
  blockTimestamp: number; // chain time: all expiry maths uses this, not the server clock
  effectiveFeeBps: number;
  guestYieldBps: number;
  pendingFeeAt: number; // 0 if none
  paused: boolean;
  lossDebt: bigint;
  quoteSigner: Address;
  minNightlyAtomic: bigint;
  maxOpenPrincipalAtomic: bigint;
  totalOpenPrincipal: bigint;
};

export interface EscrowReader {
  liveTerms(): Promise<LiveTerms>;
}

export function escrowReader(client: PublicClient, escrow: Address): EscrowReader {
  const read = <T>(functionName: string, blockNumber: bigint) =>
    client.readContract({ address: escrow, abi: escrowAbi, functionName: functionName as never, blockNumber }) as Promise<T>;
  return {
    async liveTerms() {
      const block = await client.getBlock({ blockTag: "latest" });
      const n = block.number;
      const [fee, split, pendingAt, paused, debt, signer, minNightly, cap, open] = await Promise.all([
        read<number>("effectiveFeeBps", n),
        read<number>("guestYieldBps", n),
        read<bigint>("pendingFeeAt", n),
        read<boolean>("paused", n),
        read<bigint>("lossDebt", n),
        read<Address>("quoteSigner", n),
        read<bigint>("minNightlyAtomic", n),
        read<bigint>("maxOpenPrincipalAtomic", n),
        read<bigint>("totalOpenPrincipal", n),
      ]);
      return {
        blockNumber: n,
        blockTimestamp: Number(block.timestamp),
        effectiveFeeBps: Number(fee),
        guestYieldBps: Number(split),
        pendingFeeAt: Number(pendingAt),
        paused,
        lossDebt: debt,
        quoteSigner: signer,
        minNightlyAtomic: minNightly,
        maxOpenPrincipalAtomic: cap,
        totalOpenPrincipal: open,
      };
    },
  };
}

/** EIP-712 domain the escrow signs under (ERC-5267 `eip712Domain()`); checked at startup. */
export async function readDomain(client: PublicClient, escrow: Address) {
  const [, name, version, chainId, verifyingContract] = (await client.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "eip712Domain",
  })) as readonly [string, string, string, bigint, Address, string, readonly bigint[]];
  return { name, version, chainId: Number(chainId), verifyingContract };
}

export async function readUsdcAddress(client: PublicClient, escrow: Address): Promise<Address> {
  return (await client.readContract({ address: escrow, abi: escrowAbi, functionName: "usdc" })) as Address;
}

export async function usdcDecimals(client: PublicClient, usdc: Address): Promise<number> {
  return Number(await client.readContract({ address: usdc, abi: erc20Abi, functionName: "decimals" }));
}
