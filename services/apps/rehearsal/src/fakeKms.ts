// A loopback stand-in for AWS KMS (rehearsal only). It speaks the two KMS operations the services
// use, GetPublicKey and Sign (AWS JSON 1.1, X-Amz-Target: TrentService.*), so the quote service and
// the rebalancer run their production signer path (`SIGNER=kms`, @chain/signer kmsAccount: SPKI
// parsing, DER decoding, low-s normalisation, recovery-bit search) via AWS_ENDPOINT_URL_KMS.
// Keys are Anvil's public dev keys. Like real KMS, it returns high-s signatures as often as low-s.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Hex } from "viem";

const SPKI_HEADER = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");
const N = secp256k1.Point.CURVE().n;

export type FakeKms = { url: string; calls: { op: string; keyId: string }[]; highS: number; close: () => Promise<void> };

export async function startFakeKms(keys: Record<string, Hex>): Promise<FakeKms> {
  const calls: FakeKms["calls"] = [];
  let highS = 0;
  const priv = (id: string) => {
    const k = keys[id.replace(/^.*key\//, "")];
    return k ? Buffer.from(k.slice(2), "hex") : null;
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const target = String(req.headers["x-amz-target"] ?? "");
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/x-amz-json-1.1" }).end(JSON.stringify(obj));
      };
      let input: { KeyId?: string; Message?: string; MessageType?: string; SigningAlgorithm?: string };
      try {
        input = JSON.parse(body || "{}");
      } catch {
        return send(400, { __type: "SerializationException", message: "bad json" });
      }
      const keyId = input.KeyId ?? "";
      const k = priv(keyId);
      if (!k) return send(400, { __type: "NotFoundException", message: `key ${keyId} not found` });
      const op = target.split(".")[1] ?? "";
      calls.push({ op, keyId });
      if (op === "GetPublicKey") {
        const pub = secp256k1.getPublicKey(k, false);
        return send(200, {
          KeyId: keyId,
          KeySpec: "ECC_SECG_P256K1",
          KeyUsage: "SIGN_VERIFY",
          SigningAlgorithms: ["ECDSA_SHA_256"],
          PublicKey: Buffer.concat([SPKI_HEADER, Buffer.from(pub)]).toString("base64"),
        });
      }
      if (op === "Sign") {
        if (input.MessageType !== "DIGEST" || input.SigningAlgorithm !== "ECDSA_SHA_256") {
          return send(400, { __type: "ValidationException", message: "rehearsal KMS signs raw digests only" });
        }
        const digest = Buffer.from(input.Message ?? "", "base64");
        if (digest.length !== 32) return send(400, { __type: "ValidationException", message: "digest must be 32 bytes" });
        let sig = secp256k1.Signature.fromBytes(secp256k1.sign(digest, k, { prehash: false, lowS: true }), "compact");
        if (calls.length % 2 === 0) {
          sig = new secp256k1.Signature(sig.r, N - sig.s); // real KMS does not normalise s
          highS++;
        }
        return send(200, { KeyId: keyId, SigningAlgorithm: "ECDSA_SHA_256", Signature: Buffer.from(sig.toBytes("der")).toString("base64") });
      }
      return send(400, { __type: "UnsupportedOperationException", message: target });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    get highS() {
      return highS;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
