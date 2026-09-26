import { beforeAll, describe, expect, it } from "vitest";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { jwtAuth, owns, type GuestAuth } from "../src/auth.js";

const GUEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
let priv: CryptoKey;
let auth: GuestAuth;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256");
  priv = kp.privateKey;
  auth = await jwtAuth({ issuer: "checkout", audience: "booking-api", publicKeyPem: await exportSPKI(kp.publicKey) });
});

function token(claims: Record<string, unknown>, opts: { iss?: string; aud?: string; exp?: string; iatOffset?: number; key?: CryptoKey } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(opts.iss ?? "checkout")
    .setAudience(opts.aud ?? "booking-api")
    .setIssuedAt(Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0))
    .setExpirationTime(opts.exp ?? "10m")
    .sign(opts.key ?? priv);
}

describe("guest JWT (D7)", () => {
  it("accepts an address token and an email token", async () => {
    expect(await auth.verify(await token({ addr: GUEST }))).toEqual({ addr: GUEST });
    expect(await auth.verify(await token({ email: "Guest@Example.com" }))).toEqual({ email: "guest@example.com" });
  });

  it.each([
    ["wrong issuer", () => token({ addr: GUEST }, { iss: "someone" })],
    ["wrong audience", () => token({ addr: GUEST }, { aud: "other" })],
    ["expired", () => token({ addr: GUEST }, { exp: "-1m" })],
    ["older than 1 hour", () => token({ addr: GUEST }, { iatOffset: -7200, exp: "1h" })],
    ["no identity", () => token({})],
    ["both identities", () => token({ addr: GUEST, email: "a@b.c" })],
    ["bad address", () => token({ addr: "0x123" })],
  ])("rejects %s", async (_n, make) => {
    await expect(auth.verify(await make())).rejects.toThrow();
  });

  it("rejects a token signed by another key", async () => {
    const other = await generateKeyPair("ES256");
    await expect(auth.verify(await token({ addr: GUEST }, { key: other.privateKey }))).rejects.toThrow();
  });

  it("ownership: address must be the guest; email must be the stored booking email", () => {
    expect(owns({ addr: GUEST }, GUEST.toLowerCase() as never, null)).toBe(true);
    expect(owns({ addr: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" }, GUEST, null)).toBe(false);
    expect(owns({ email: "g@x.com" }, GUEST, "G@x.com")).toBe(true);
    expect(owns({ email: "g@x.com" }, GUEST, null)).toBe(false);
    expect(owns({ email: "g@x.com" }, GUEST, "other@x.com")).toBe(false);
  });
});
