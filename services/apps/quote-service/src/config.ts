// Environment for the quote service. Secrets come from the environment only (CLAUDE.md section 9);
// see .env.example. A local private-key signer is refused unless the chain is Anvil (31337).

import { readFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { Property } from "./property.js";

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a) as Address);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const Env = z
  .object({
    PORT: int(1, 65_535).default(8080),
    HOST: z.string().default("0.0.0.0"),
    DATABASE_URL: z.string().min(1),
    RPC_URL: z.url(),
    CHAIN_ID: int(1, 2 ** 31),
    ESCROW: addr,
    /** Block the interim read model scans events from (the escrow's creation block). */
    ESCROW_FROM_BLOCK: z.coerce.bigint().default(0n),
    PROPERTIES_FILE: z.string().min(1),
    SIGNER: z.enum(["kms", "local"]).default("kms"),
    KMS_KEY_ID: z.string().optional(),
    AWS_REGION: z.string().optional(),
    LOCAL_SIGNER_PK: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1),
    JWT_PUBLIC_KEY_PEM: z.string().optional(),
    JWT_JWKS_URL: z.url().optional(),
    OFFER_LOCK_SEC: int(60, 3_600).default(1_500), // spec 5.2: 25 minutes
    QUOTE_TTL_SEC: int(60, 3_600).default(900),
    FEED_MAX_AGE_SEC: int(60, 86_400).default(900),
    HOLD_GRACE_SEC: int(60, 3_600).default(600),
    MAX_CLOCK_SKEW_SEC: int(5, 600).default(120),
    APY_ESTIMATE_BPS: int(0, 10_000).default(400),
    YIELD_PROTOCOL: z.string().default("Aave V3 USDC on Base"),
  })
  .superRefine((e, ctx) => {
    if (e.SIGNER === "kms" && (!e.KMS_KEY_ID || !e.AWS_REGION)) {
      ctx.addIssue({ code: "custom", message: "SIGNER=kms needs KMS_KEY_ID and AWS_REGION" });
    }
    if (e.SIGNER === "local" && (!e.LOCAL_SIGNER_PK || e.CHAIN_ID !== 31_337)) {
      ctx.addIssue({ code: "custom", message: "SIGNER=local needs LOCAL_SIGNER_PK and is Anvil-only (CHAIN_ID=31337)" });
    }
    if (!e.JWT_PUBLIC_KEY_PEM === !e.JWT_JWKS_URL) {
      ctx.addIssue({ code: "custom", message: "set exactly one of JWT_PUBLIC_KEY_PEM or JWT_JWKS_URL" });
    }
  });
export type Env = z.infer<typeof Env>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  return Env.parse(env);
}

export function loadProperties(file: string): Property[] {
  return z.array(Property).min(1).parse(JSON.parse(readFileSync(file, "utf8")));
}

export type { Hex };
