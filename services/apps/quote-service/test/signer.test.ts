import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hashTypedData, recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { derToEthSignature, kmsSigner, localSigner, publicKeyToAddress, spkiToPublicKey, type KmsClient } from "../src/signer.js";

const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex; // Anvil #2

const TYPED = {
  domain: { name: "BookingEscrow", version: "1", chainId: 31337, verifyingContract: "0x3B02fF1e626Ed7a8fd6eC5299e2C54e1421B626B" },
  types: { Ping: [{ name: "n", type: "uint256" }] },
  primaryType: "Ping",
  message: { n: 42n },
} as const;

/** SPKI prefix for an uncompressed secp256k1 public key (id-ecPublicKey, secp256k1). */
const SPKI_PREFIX = Uint8Array.from([
  0x30, 0x56, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00,
  0x0a, 0x03, 0x42, 0x00,
]);

/** A fake KMS backed by a local key that can be told to return high-s signatures, as real KMS
 * does about half the time. */
function fakeKms(priv: Hex, forceHighS: boolean): KmsClient {
  const sk = Buffer.from(priv.slice(2), "hex");
  return {
    async getPublicKey() {
      const pub = secp256k1.getPublicKey(sk, false);
      return Uint8Array.from([...SPKI_PREFIX, ...pub]);
    },
    async signDigest(_id, digest) {
      let sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, sk, { prehash: false }), "compact");
      const n = secp256k1.Point.CURVE().n;
      if (forceHighS && sig.s <= n / 2n) sig = new secp256k1.Signature(sig.r, n - sig.s);
      return sig.toBytes("der");
    },
  };
}

describe("local signer", () => {
  it("signs typed data recoverable to its address", async () => {
    const s = localSigner(KEY, "test");
    const sig = await s.signTypedData(TYPED);
    expect(await recoverTypedDataAddress({ ...TYPED, signature: sig })).toBe(s.address);
  });

  it("is refused in production", () => {
    expect(() => localSigner(KEY, "production")).toThrow(/refused in production/);
  });
});

describe("KMS signer", () => {
  it.each([false, true])("produces a low-s signature recovering to the key (KMS high-s=%s)", async (highS) => {
    const signer = await kmsSigner(fakeKms(KEY, highS), "key-1");
    expect(signer.address).toBe(privateKeyToAccount(KEY).address);
    const sig = await signer.signTypedData(TYPED);
    expect(await recoverTypedDataAddress({ ...TYPED, signature: sig })).toBe(signer.address);
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    expect(s <= secp256k1.Point.CURVE().n / 2n).toBe(true);
    // Identical to what the local key would sign (RFC 6979 deterministic nonce, same message).
    expect(sig).toBe(await localSigner(KEY, "test").signTypedData(TYPED));
  });

  it("rejects a signature from the wrong key", async () => {
    const other = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
    const digest = hashTypedData(TYPED);
    const der = await fakeKms(other, false).signDigest("k", Buffer.from(digest.slice(2), "hex"));
    await expect(derToEthSignature(der, digest, privateKeyToAccount(KEY).address)).rejects.toThrow(/does not recover/);
  });

  it("rejects a non-secp256k1 SPKI", () => {
    expect(() => spkiToPublicKey(new Uint8Array(91))).toThrow(/secp256k1/);
    const pub = secp256k1.getPublicKey(Buffer.from(KEY.slice(2), "hex"), false);
    expect(publicKeyToAddress(pub)).toBe(privateKeyToAccount(KEY).address); // EIP-55 checksummed
    expect(toHex(spkiToPublicKey(Uint8Array.from([...SPKI_PREFIX, ...pub])))).toBe(toHex(pub));
  });
});
