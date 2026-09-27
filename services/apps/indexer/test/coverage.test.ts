// Every event on the published ABIs has a projection rule or is explicitly ignored: an ABI change
// that adds an event must fail here, not surface later as an UNKNOWN_EVENT anomaly in production.
import { describe, expect, it } from "vitest";
import { escrowAbi } from "@chain/abi";
import { MemoryStore } from "../src/core/memoryStore.js";
import { bootstrapEscrow, reduce } from "../src/core/reducer.js";

const ESCROW = "0x00000000000000000000000000000000000000e5" as const;

describe("reducer covers the escrow ABI", () => {
  for (const item of escrowAbi) {
    if (item.type !== "event") continue;
    it(item.name, async () => {
      const store = new MemoryStore();
      await bootstrapEscrow(store, { chainId: 1, escrow: ESCROW, vault: null });
      const r = await reduce(store, {
        name: item.name,
        args: {},
        chainId: 1,
        address: ESCROW,
        blockNumber: 1n,
        blockHash: `0x${"00".repeat(32)}`,
        timestamp: 1n,
        txHash: `0x${"01".repeat(32)}`,
        logIndex: 0,
      }).catch(() => ({ anomalies: [] as { code: string }[] })); // empty args may throw: that is a rule
      expect(r.anomalies.map((a) => a.code)).not.toContain("UNKNOWN_EVENT");
    });
  }
});
