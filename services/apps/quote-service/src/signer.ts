// Quote signing (chain-spec.md 4.1, C5 brief). The escrow verifies quotes with OpenZeppelin
// SignatureChecker against its `quoteSigner`. Two implementations behind one interface:
//   - local key: development and tests only; refused when NODE_ENV=production
//   - KMS: a secp256k1 key held in a KMS (AWS KMS ECC_SECG_P256K1 by default, docs/adr/0012)
// The KMS primitives live in @chain/signer, shared with the rebalancer (C8).
// The KMS signer must never be EIP-7702 delegated (ADR 0009 §6): SignatureChecker would then route
// verification to the delegate's ERC-1271 and every quote would fail.

import { hashTypedData, type Address, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { derToEthSignature, publicKeyToAddress, spkiToPublicKey, type KmsClient } from "@chain/signer";

export { awsKmsClient, derToEthSignature, publicKeyToAddress, spkiToPublicKey, type KmsClient } from "@chain/signer";

export interface QuoteSigner {
  readonly address: Address;
  signTypedData(def: TypedDataDefinition): Promise<Hex>;
}

export function localSigner(privateKey: Hex, env = process.env.NODE_ENV): QuoteSigner {
  if (env === "production") throw new Error("local quote signer is refused in production; use KMS");
  const account = privateKeyToAccount(privateKey);
  return { address: account.address, signTypedData: (def) => account.signTypedData(def as never) };
}

export async function kmsSigner(kms: KmsClient, keyId: string): Promise<QuoteSigner> {
  const address = publicKeyToAddress(spkiToPublicKey(await kms.getPublicKey(keyId)));
  return {
    address,
    async signTypedData(def) {
      const digest = hashTypedData(def);
      const der = await kms.signDigest(keyId, Buffer.from(digest.slice(2), "hex"));
      return derToEthSignature(der, digest, address);
    },
  };
}
