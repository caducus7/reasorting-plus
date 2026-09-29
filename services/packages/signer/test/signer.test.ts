// The KMS account signs transactions that recover to the KMS key's address (low-s, correct parity),
// using the same DER path as the quote signer. The fake KMS signs with a known key, DER-encoded,
// including high-s signatures, as a real KMS may return.
import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseTransaction, recoverTransactionAddress, serializeTransaction, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { kmsAccount, localAccount, type KmsClient } from "../src/index.js";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const priv = Buffer.from(PK.slice(2), "hex");
const N = secp256k1.Point.CURVE().n;

function fakeKms(forceHighS: boolean): KmsClient {
  const pub = secp256k1.getPublicKey(priv, false);
  const spki = new Uint8Array([...Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex"), ...pub]);
  return {
    getPublicKey: async () => spki,
    signDigest: async (_k, digest) => {
      const sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, priv, { prehash: false, format: "compact" }), "compact");
      const s = forceHighS && sig.s <= N / 2n ? N - sig.s : sig.s;
      return new secp256k1.Signature(sig.r, s).toBytes("der");
    },
  };
}

describe("kmsAccount", () => {
  for (const highS of [false, true]) {
    it(`signs an EIP-1559 transaction that recovers to the key (${highS ? "high-s from KMS" : "low-s"})`, async () => {
      const acct = await kmsAccount(fakeKms(highS), "k");
      expect(acct.address).toBe(privateKeyToAccount(PK).address);
      const tx = { chainId: 31337, type: "eip1559" as const, nonce: 7, to: acct.address, value: 0n, gas: 21_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, data: "0x" as Hex };
      const raw = await acct.signTransaction(tx);
      expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(acct.address);
      const parsed = parseTransaction(raw);
      expect(BigInt(parsed.s!) <= N / 2n).toBe(true);
      // Byte-identical to the same key signing locally (RFC 6979 is deterministic).
      expect(raw).toBe(await privateKeyToAccount(PK).signTransaction(tx));
      expect(serializeTransaction(tx).length).toBeGreaterThan(0);
    });
  }
  it("local keys are refused in production", () => {
    expect(() => localAccount(PK, "production")).toThrow(/refused/);
    expect(localAccount(PK, "test").address).toBe(privateKeyToAccount(PK).address);
  });
});
export { toHex };
