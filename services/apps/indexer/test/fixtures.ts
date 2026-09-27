// Loads the C9 ledger tapes written by contracts/test/indexer/LedgerTape.t.sol and decodes them
// into the reducer's event shape. Regenerate with:
//   cd contracts && WRITE_LEDGER_FIXTURES=1 forge test --match-path test/indexer/LedgerTape.t.sol
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, getAddress, type Address, type Hex } from "viem";
import { escrowAbi } from "@chain/abi";
import type { ChainEvent } from "../src/core/types.js";

export const FIELDS = [
  "totalOpenPrincipal",
  "totalDisputed",
  "totalPendingYield",
  "totalClaimable",
  "reserve",
  "lossDebt",
  "accYieldPerUnit",
  "lastAssets",
  "yieldUnallocated",
  "ownerClaimable",
  "pendingOwnerYield",
  "shortfallSince",
] as const;
export type Field = (typeof FIELDS)[number];

export type Tape = {
  name: string;
  escrow: Address;
  vault: Address;
  accounts: Address[];
  events: ChainEvent[];
  snapshots: { at: number; fields: Record<Field, bigint>; guestClaimable: bigint[]; feeClaimable: bigint[]; pendingGuestYield: bigint[] }[];
};

const dir = join(import.meta.dirname, "fixtures");

export function loadTapes(): Tape[] {
  return readdirSync(dir)
    .filter((f) => f.startsWith("ledger-") && f.endsWith(".json"))
    .sort()
    .map((f) => parse(f, JSON.parse(readFileSync(join(dir, f), "utf8"), exact)));
}

// forge writes uint256 as bare JSON numbers; read them from the source text, never as doubles.
const exact = (_k: string, v: unknown, ctx?: { source?: string }) =>
  typeof v === "number" && ctx?.source !== undefined ? BigInt(ctx.source) : v;

type Raw = Record<string, unknown> & { topics: Hex[]; data: Hex[]; tx: string[]; ts: string[]; snapAt: string[] };

function parse(name: string, j: Raw): Tape {
  const escrow = getAddress(j.escrow as string);
  const perTx = new Map<string, number>();
  const events: ChainEvent[] = j.topics.map((packed, i) => {
    const topics = (packed.slice(2).match(/.{64}/g) ?? []).map((t) => `0x${t}` as Hex) as [Hex, ...Hex[]];
    const d = decodeEventLog({ abi: escrowAbi, topics, data: j.data[i]! });
    const tx = j.tx[i]!;
    const logIndex = perTx.get(tx) ?? 0;
    perTx.set(tx, logIndex + 1);
    const n = BigInt(tx);
    return {
      name: d.eventName,
      args: d.args as unknown as Record<string, unknown>,
      chainId: 31337,
      address: escrow,
      blockNumber: n,
      blockHash: `0x${n.toString(16).padStart(64, "0")}` as Hex,
      timestamp: BigInt(j.ts[i]!),
      txHash: `0x${(n + 1n << 128n).toString(16).padStart(64, "0")}` as Hex,
      logIndex,
    };
  });
  const nAcc = (j.accounts as string[]).length;
  const col = (k: string) => (j[k] as string[]).map(BigInt);
  const snapshots = j.snapAt.map((at, s) => ({
    at: Number(at),
    fields: Object.fromEntries(FIELDS.map((f) => [f, col(f)[s]!])) as Record<Field, bigint>,
    guestClaimable: col("guestClaimable").slice(s * nAcc, (s + 1) * nAcc),
    feeClaimable: col("feeClaimable").slice(s * nAcc, (s + 1) * nAcc),
    pendingGuestYield: col("pendingGuestYield").slice(s * nAcc, (s + 1) * nAcc),
  }));
  return {
    name,
    escrow,
    vault: getAddress(j.vault as string),
    accounts: (j.accounts as string[]).map((a) => getAddress(a)),
    events,
    snapshots,
  };
}
