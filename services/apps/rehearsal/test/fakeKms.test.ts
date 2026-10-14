// The KMS stand-in drives @chain/signer's production path, through the real AWS SDK client.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awsKmsClient, kmsAccount } from "@chain/signer";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { startFakeKms, type FakeKms } from "../src/fakeKms.js";

const KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // Anvil account 2
let kms: FakeKms;
beforeAll(async () => {
  kms = await startFakeKms({ quote: KEY });
  process.env.AWS_ENDPOINT_URL_KMS = kms.url;
  process.env.AWS_ACCESS_KEY_ID = "rehearsal";
  process.env.AWS_SECRET_ACCESS_KEY = "rehearsal";
});
afterAll(() => kms.close());

describe("fake KMS through the AWS SDK and kmsAccount", () => {
  it("yields the key's address and valid low-s signatures, including from high-s DER", async () => {
    const acct = await kmsAccount(await awsKmsClient("eu-west-1"), "arn:aws:kms:eu-west-1:000000000000:key/quote");
    expect(acct.address).toBe(privateKeyToAccount(KEY).address);
    for (let i = 0; i < 4; i++) {
      const message = `rehearsal ${i}`;
      const sig = await acct.signMessage({ message });
      expect(await recoverMessageAddress({ message, signature: sig })).toBe(acct.address);
      expect(BigInt(`0x${sig.slice(66, 130)}`) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n).toBe(true);
    }
    expect(kms.highS).toBeGreaterThan(0);
    expect(kms.calls.map((c) => c.op)).toContain("GetPublicKey");
  });
});
