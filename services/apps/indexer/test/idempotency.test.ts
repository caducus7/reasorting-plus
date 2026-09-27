// Brief C6 test 2 (idempotency): replaying the same logs twice produces identical projections, and a
// log delivered twice (a retry, or a re-emitted batch) is applied once, keyed on
// (chainId, txHash, logIndex) as spec 10.1 requires.
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/core/memoryStore.js";
import { reduce, bootstrapEscrow } from "../src/core/reducer.js";
import { loadTapes } from "./fixtures.js";

const tapes = loadTapes();

async function replay(tape: (typeof tapes)[number], dup: boolean) {
  const store = new MemoryStore();
  await bootstrapEscrow(store, { chainId: 31337, escrow: tape.escrow, vault: tape.vault });
  for (const ev of tape.events) {
    await reduce(store, ev);
    if (dup) {
      const again = await reduce(store, ev);
      expect(again.duplicate).toBe(true);
      expect(again.legs).toEqual([]);
    }
  }
  return store.dump();
}

describe("idempotency", () => {
  for (const tape of tapes.slice(0, 4)) {
    it(`${tape.name}: two replays are identical`, async () => {
      expect(await replay(tape, false)).toEqual(await replay(tape, false));
    });
    it(`${tape.name}: duplicate delivery of every log changes nothing`, async () => {
      expect(await replay(tape, true)).toEqual(await replay(tape, false));
    });
  }
});
