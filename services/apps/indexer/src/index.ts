// Ponder handlers: every factory and escrow log goes through the one reducer (src/core), the same
// code the ledger tests and the replay diff run.
import { ponder } from "ponder:registry";
import { escrowAbi, escrowFactoryAbi } from "@chain/abi";
import { getAddress, type Hex } from "viem";
import { reduce } from "./core/reducer.js";
import type { ChainEvent } from "./core/types.js";
import { PonderStore } from "./ponderStore.js";

type PonderLogEvent = {
  args: Record<string, unknown>;
  log: { address: string; logIndex: number };
  block: { number: bigint; hash: Hex; timestamp: bigint };
  transaction: { hash: Hex };
};
type Ctx = { chain: { id: number }; db: ConstructorParameters<typeof PonderStore>[0] };

function handler(name: string) {
  return async ({ event, context }: { event: PonderLogEvent; context: Ctx }) => {
    const ev: ChainEvent = {
      name,
      args: event.args,
      chainId: context.chain.id,
      address: getAddress(event.log.address),
      blockNumber: event.block.number,
      blockHash: event.block.hash,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
    };
    const store = new PonderStore(context.db);
    const r = await reduce(store, ev);
    if (r.anomalies.length) await store.recordAnomalies(r.anomalies, ev.blockNumber);
  };
}

const on = (name: string, fn: ReturnType<typeof handler>) => ponder.on(name as never, fn as never);

// Factory: only EscrowCreated feeds the projections; the others are recorded as processed.
for (const item of escrowFactoryAbi) {
  if (item.type === "event" && item.name === "EscrowCreated") on(`EscrowFactory:${item.name}`, handler(item.name));
}
for (const item of escrowAbi) {
  if (item.type === "event") on(`Escrow:${item.name}`, handler(item.name));
}
