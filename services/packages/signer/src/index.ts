// KMS-backed secp256k1 signing shared by the quote service (C5: EIP-712 quotes) and the rebalancer
// (C8: transactions). One path for both: the digest is signed in the KMS, the DER signature is
// normalised to low-s and its recovery bit found by recovering to the key's own address
// (docs/adr/0012). Local private keys are for Anvil and tests only.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  hashMessage,
  hashTypedData,
  keccak256,
  parseSignature,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount, publicKeyToAddress as viemPublicKeyToAddress, toAccount, type LocalAccount } from "viem/accounts";

/** Minimal KMS surface: raw-digest ECDSA over secp256k1, and the key's public key. */
export interface KmsClient {
  /** DER-encoded SubjectPublicKeyInfo of the secp256k1 key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER-encoded ECDSA-Sig-Value over a 32-byte digest (no further hashing). */
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

const SECP256K1_N = secp256k1.Point.CURVE().n;

/** Extracts the uncompressed point (65 bytes, 0x04 || X || Y) from a secp256k1 SPKI. */
export function spkiToPublicKey(spki: Uint8Array): Uint8Array {
  // secp256k1 SPKI is fixed at 88 bytes: 23-byte header + 0x00 unused-bits + 65-byte point.
  if (spki.length !== 88 || spki[23] !== 0x04) throw new Error("not a secp256k1 uncompressed SPKI");
  return spki.slice(23);
}

/** EIP-55 checksummed address of an uncompressed public key (viem's implementation). */
export function publicKeyToAddress(pub: Uint8Array): Address {
  return viemPublicKeyToAddress(toHex(pub));
}

/** Converts a DER signature over `digest` into a 65-byte Ethereum signature (low-s, v 27/28). */
export async function derToEthSignature(der: Uint8Array, digest: Hex, expected: Address): Promise<Hex> {
  const sig = secp256k1.Signature.fromBytes(der, "der");
  // Ethereum (and OpenZeppelin ECDSA) reject high-s signatures: normalise to s <= n/2.
  const s = sig.s > SECP256K1_N / 2n ? SECP256K1_N - sig.s : sig.s;
  const r = toHex(sig.r, { size: 32 });
  const sHex = toHex(s, { size: 32 });
  for (const yParity of [0, 1] as const) {
    const candidate = serializeSignature({ r, s: sHex, yParity });
    const who = await recoverAddress({ hash: digest, signature: candidate });
    if (who.toLowerCase() === expected.toLowerCase()) return candidate;
  }
  throw new Error("KMS signature does not recover to the KMS key's address");
}

/** AWS KMS adapter (key spec ECC_SECG_P256K1, usage SIGN_VERIFY). Loaded lazily so local runs do
 * not need the SDK configured. */
export async function awsKmsClient(region: string): Promise<KmsClient> {
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import("@aws-sdk/client-kms");
  const client = new KMSClient({ region });
  return {
    async getPublicKey(keyId) {
      const out = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (out.KeySpec !== "ECC_SECG_P256K1") throw new Error(`KMS key ${keyId} is ${out.KeySpec}, not ECC_SECG_P256K1`);
      if (!out.PublicKey) throw new Error("KMS returned no public key");
      return out.PublicKey;
    },
    async signDigest(keyId, digest) {
      const out = await client.send(
        new SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
      );
      if (!out.Signature) throw new Error("KMS returned no signature");
      return out.Signature;
    },
  };
}

/** A viem account whose every signature (transactions, messages, typed data) is made in the KMS. */
export async function kmsAccount(kms: KmsClient, keyId: string): Promise<LocalAccount> {
  const address = publicKeyToAddress(spkiToPublicKey(await kms.getPublicKey(keyId)));
  const sign = async (digest: Hex) => derToEthSignature(await kms.signDigest(keyId, Buffer.from(digest.slice(2), "hex")), digest, address);
  return toAccount({
    address,
    async sign({ hash }) {
      return sign(hash);
    },
    async signMessage({ message }) {
      return sign(hashMessage(message));
    },
    async signTypedData(def) {
      return sign(hashTypedData(def as never));
    },
    async signTransaction(tx, opts) {
      const serializer = opts?.serializer ?? serializeTransaction;
      const signature = parseSignature(await sign(keccak256(await serializer(tx))));
      return serializer(tx, signature);
    },
  }) as LocalAccount;
}

/** Anvil and tests only. */
export function localAccount(privateKey: Hex, env = process.env.NODE_ENV): LocalAccount {
  if (env === "production") throw new Error("local keys are refused in production; use KMS");
  return privateKeyToAccount(privateKey);
}
