import { timingSafeEqual } from "node:crypto";

/** Read-API authorisation (review 0005 R6): bearer token, constant-time; fail closed without a token
 * except on Anvil (chain 31337). */
export function authorize(header: string | undefined, token: string, chainId: string | undefined): 200 | 401 | 503 {
  if (chainId === "31337" && token === "") return 200;
  if (token.length < 32) return 503;
  const got = Buffer.from((header ?? "").replace(/^Bearer /, ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want) ? 200 : 401;
}
