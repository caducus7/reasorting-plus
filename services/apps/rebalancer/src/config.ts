import { getAddress, type Address } from "viem";
import { z } from "zod";
import { DEFAULTS } from "./policy.js";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a) as Address);

/** Base mainnet addresses, each verified on-chain (docs/adr/0019):
 *  - AAVE_POOL: bgd-labs/aave-address-book AaveV3Base.POOL
 *  - USDC_USD: Chainlink "USDC / USD", 8 decimals; aave-address-book ChainlinkBase.USDC__USD
 *  - SEQUENCER: Chainlink "L2 Sequencer Uptime Status Feed"; smartcontractkit/documentation
 *    l2-sequencer-feeds.mdx and aave-address-book ChainlinkBase.L2_Sequencer_Uptime_Status_Feed */
export const BASE = {
  AAVE_POOL: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  USDC_USD: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
  SEQUENCER: "0xBCF85224fc0756B9Fa45aA7892530B47e10b6433",
} as const;

export const Env = z
  .object({
    DATABASE_URL: z.string().min(1),
    RPC_URL: z.url(),
    CHAIN_ID: int(1, 2 ** 31),
    PONDER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("indexer"),
    ESCROWS: z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(addr).min(1)),
    /** Dry run is the default everywhere; only the exact string "false" sends transactions. */
    DRY_RUN: z.string().default("true").transform((s) => s !== "false"),
    SIGNER: z.enum(["kms", "local"]).default("kms"),
    KMS_KEY_ID: z.string().optional(),
    AWS_REGION: z.string().optional(),
    LOCAL_SIGNER_PK: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
    CYCLE_SEC: int(10, 3_600).default(60),
    STUCK_AFTER_SEC: int(30, 3_600).default(180),
    LIQUIDITY_SOURCE: z.enum(["aave", "mock-vault"]).default("aave"),
    AAVE_POOL: addr.optional(),
    PRICE_SOURCE: z.enum(["chainlink", "fixed"]).default("chainlink"),
    PRICE_FEED: addr.optional(),
    SEQUENCER_FEED: addr.optional(),
    // Policy thresholds (spec 6.7 defaults; config per the brief).
    MIN_MOVE_ATOMIC: z.coerce.bigint().default(DEFAULTS.minMoveAtomic),
    DEPLOY_LIQUIDITY_X: z.coerce.bigint().default(DEFAULTS.deployLiquidityX),
    EXIT_LIQUIDITY_X: z.coerce.bigint().default(DEFAULTS.exitLiquidityX),
    PRICE_BAND_BPS: z.coerce.bigint().default(DEFAULTS.priceBandBps),
    MAX_PRICE_AGE_SEC: z.coerce.bigint().default(DEFAULTS.maxPriceAgeSec),
    MAX_PROJECTION_LAG_BLOCKS: z.coerce.bigint().default(DEFAULTS.maxProjectionLagBlocks),
  })
  .superRefine((e, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (e.SIGNER === "kms" && (!e.KMS_KEY_ID || !e.AWS_REGION)) fail("SIGNER=kms needs KMS_KEY_ID and AWS_REGION");
    if (e.SIGNER === "local" && (!e.LOCAL_SIGNER_PK || e.CHAIN_ID !== 31_337)) fail("SIGNER=local is Anvil-only (CHAIN_ID=31337)");
    if (e.PRICE_SOURCE === "fixed" && e.CHAIN_ID === 8_453) fail("PRICE_SOURCE=fixed is refused on Base mainnet");
    if (e.LIQUIDITY_SOURCE === "mock-vault" && e.CHAIN_ID === 8_453) fail("LIQUIDITY_SOURCE=mock-vault is refused on Base mainnet");
    if (e.DEPLOY_LIQUIDITY_X <= e.EXIT_LIQUIDITY_X) fail("DEPLOY_LIQUIDITY_X must exceed EXIT_LIQUIDITY_X");
  })
  .transform((e) => ({
    ...e,
    AAVE_POOL: e.AAVE_POOL ?? (e.CHAIN_ID === 8_453 ? (BASE.AAVE_POOL as Address) : undefined),
    PRICE_FEED: e.PRICE_FEED ?? (e.CHAIN_ID === 8_453 ? (BASE.USDC_USD as Address) : undefined),
    SEQUENCER_FEED: e.SEQUENCER_FEED ?? (e.CHAIN_ID === 8_453 ? (BASE.SEQUENCER as Address) : undefined),
    policy: {
      minMoveAtomic: e.MIN_MOVE_ATOMIC,
      deployLiquidityX: e.DEPLOY_LIQUIDITY_X,
      exitLiquidityX: e.EXIT_LIQUIDITY_X,
      priceBandBps: e.PRICE_BAND_BPS,
      maxPriceAgeSec: e.MAX_PRICE_AGE_SEC,
      maxProjectionLagBlocks: e.MAX_PROJECTION_LAG_BLOCKS,
    },
  }));
export type Env = z.infer<typeof Env>;
