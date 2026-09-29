import { serve } from "@hono/node-server";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { createApp } from "./app.js";
import { jwtAuth } from "./auth.js";
import { readDomain, readUsdcAddress } from "./chain.js";
import { escrowReader } from "./chain.js";
import { loadEnv, loadProperties } from "./config.js";
import { connect, migrate, pgCalendar } from "./db.js";
import { chainReadModel, indexerReadModel, withFallback } from "./readModel.js";
import { awsKmsClient, kmsSigner, localSigner, type QuoteSigner } from "./signer.js";
import { ESCROW_EIP712_NAME, ESCROW_EIP712_VERSION } from "@chain/shared/eip712";

const env = loadEnv();
const client = createPublicClient({ transport: http(env.RPC_URL) }) as PublicClient;

// Fail at boot, not at the first prepare, if the chain or the escrow is not what we were told.
const chainId = await client.getChainId();
if (chainId !== env.CHAIN_ID) throw new Error(`RPC is chain ${chainId}, CHAIN_ID says ${env.CHAIN_ID}`);
const domain = await readDomain(client, env.ESCROW);
if (domain.name !== ESCROW_EIP712_NAME || domain.version !== ESCROW_EIP712_VERSION || Number(domain.chainId) !== chainId) {
  throw new Error(`escrow EIP-712 domain ${JSON.stringify(domain, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} is unexpected`);
}
const usdc = await readUsdcAddress(client, env.ESCROW);

const signer: QuoteSigner =
  env.SIGNER === "kms"
    ? await kmsSigner(await awsKmsClient(env.AWS_REGION!), env.KMS_KEY_ID!)
    : localSigner(env.LOCAL_SIGNER_PK as Hex);

const db = connect(env.DATABASE_URL);
await migrate(db);
const chain = escrowReader(client, env.ESCROW);
const terms = await chain.liveTerms();
if (terms.quoteSigner.toLowerCase() !== signer.address.toLowerCase()) {
  throw new Error(`escrow quoteSigner ${terms.quoteSigner} is not this service's signer ${signer.address}`);
}

const app = createApp({
  db,
  calendar: pgCalendar(db),
  chain,
  signer,
  bookings: env.INDEXER_URL
    ? withFallback(indexerReadModel(env.INDEXER_URL, env.ESCROW, { token: env.INDEXER_API_TOKEN }), chainReadModel(client, env.ESCROW, env.ESCROW_FROM_BLOCK))
    : chainReadModel(client, env.ESCROW, env.ESCROW_FROM_BLOCK),
  auth: await jwtAuth({
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    publicKeyPem: env.JWT_PUBLIC_KEY_PEM,
    jwksUrl: env.JWT_JWKS_URL,
  }),
  properties: loadProperties(env.PROPERTIES_FILE),
  settings: {
    chainId,
    escrow: env.ESCROW,
    usdc,
    offerLockSec: env.OFFER_LOCK_SEC,
    quoteTtlSec: env.QUOTE_TTL_SEC,
    feedMaxAgeSec: env.FEED_MAX_AGE_SEC,
    maxClockSkewSec: env.MAX_CLOCK_SKEW_SEC,
    apyEstimateBps: env.APY_ESTIMATE_BPS,
    yieldProtocol: env.YIELD_PROTOCOL,
  },
});

serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`quote-service on http://${env.HOST}:${info.port}/v1, escrow ${env.ESCROW}, signer ${signer.address}`);
});
