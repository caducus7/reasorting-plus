// Boot check found by the Base Sepolia fork rehearsal: a quote signer with code (an EIP-7702
// delegation) would make every quote revert InvalidQuoteSignature, so the service refuses to start.
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { assertSignerHasNoCode } from "../src/chain.js";

const at = (code: Hex | undefined) => ({ getCode: async () => code });
const S: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

describe("assertSignerHasNoCode", () => {
  it("accepts a plain EOA", async () => {
    await expect(assertSignerHasNoCode(at(undefined), S)).resolves.toBeUndefined();
    await expect(assertSignerHasNoCode(at("0x"), S)).resolves.toBeUndefined();
  });
  it("refuses an EIP-7702 delegated EOA, naming the delegate (code seen on Base Sepolia, 2026-10-14)", async () => {
    await expect(assertSignerHasNoCode(at("0xef010091128fa0c92671265263548853eb875feded35b4"), S)).rejects.toThrow(
      /EIP-7702 delegation to 0x91128fa0c92671265263548853eb875feded35b4/,
    );
  });
  it("refuses a contract", async () => {
    await expect(assertSignerHasNoCode(at("0x6080604052"), S)).rejects.toThrow(/contract code/);
  });
});
