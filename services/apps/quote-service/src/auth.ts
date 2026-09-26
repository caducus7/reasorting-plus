// Guest auth (chain-spec.md 5.3, decision D7). The checkout backend (agent workstream A3) issues a
// short-lived JWT after Sign-In with Ethereum for the booking's guest address, or after a magic link
// to the booking email. This service only verifies it (C5 brief: don't build issuance).
//
// Token contract (docs/adr/0012): signed ES256 or EdDSA; `iss` and `aud` as configured; `exp` and
// `iat` required, lifetime at most 1 hour; and exactly one of
//   `addr`  — the guest's wallet address (from SIWE), or
//   `email` — the verified booking email (from a magic link).

import { createRemoteJWKSet, importSPKI, jwtVerify, type JWTVerifyGetKey, type CryptoKey, type KeyObject } from "jose";
import { isAddress, type Address } from "viem";

export type GuestClaims = { addr: Address; email?: undefined } | { email: string; addr?: undefined };

export interface GuestAuth {
  /** Throws if the token is invalid, expired, or carries neither/both identities. */
  verify(token: string): Promise<GuestClaims>;
}

export type JwtAuthConfig = {
  issuer: string;
  audience: string;
  publicKeyPem?: string;
  jwksUrl?: string;
  algorithms?: string[];
};

export async function jwtAuth(cfg: JwtAuthConfig): Promise<GuestAuth> {
  const algorithms = cfg.algorithms ?? ["ES256", "EdDSA"];
  let key: CryptoKey | KeyObject | JWTVerifyGetKey;
  if (cfg.jwksUrl) key = createRemoteJWKSet(new URL(cfg.jwksUrl));
  else if (cfg.publicKeyPem) key = await importSPKI(cfg.publicKeyPem, algorithms[0]!);
  else throw new Error("guest auth needs JWT_PUBLIC_KEY_PEM or JWT_JWKS_URL");

  return {
    async verify(token) {
      const { payload } = await jwtVerify(token, key as never, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        algorithms,
        requiredClaims: ["exp", "iat"],
        maxTokenAge: "1h",
      });
      const addr = payload.addr;
      const email = payload.email;
      if (typeof addr === "string" && email === undefined && isAddress(addr)) return { addr: addr as Address };
      if (typeof email === "string" && addr === undefined && email.includes("@")) return { email: email.toLowerCase() };
      throw new Error("token must carry exactly one of addr or email");
    },
  };
}

/** Does this identity own the booking? Address matches the on-chain guest, or email matches the one
 * stored at prepare (spec 5.2). */
export function owns(claims: GuestClaims, guest: Address, storedEmail: string | null): boolean {
  if (claims.addr) return claims.addr.toLowerCase() === guest.toLowerCase();
  return storedEmail !== null && claims.email === storedEmail.toLowerCase();
}
