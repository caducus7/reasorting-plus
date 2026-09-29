// C8 rebalancer: one loop per escrow (spec 6.7). Dry run unless DRY_RUN=false.
//   pnpm build && pnpm start   (env: see .env.example)
import pg from "pg";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { awsKmsClient, kmsAccount, localAccount } from "@chain/signer";
import { Env } from "./config.js";
import { migrate } from "./db.js";
import { createExecutor } from "./executor.js";
import { AlertOutbox, LogNotifier } from "@chain/indexer/alerts";
import { projectionSource, viemChain } from "./chain.js";
import { aaveLiquidity, mockVaultLiquidity } from "./liquidity.js";
import { chainlinkPrice, fixedPrice } from "./price.js";

async function main() {
  const env = Env.parse(process.env);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  await migrate(pool);
  const client = createPublicClient({ transport: http(env.RPC_URL), cacheTime: 0 }) as PublicClient;
  if ((await client.getChainId()) !== env.CHAIN_ID) throw new Error("RPC chain id does not match CHAIN_ID");
  const account = env.SIGNER === "kms" ? await kmsAccount(await awsKmsClient(env.AWS_REGION!), env.KMS_KEY_ID!) : localAccount(env.LOCAL_SIGNER_PK as `0x${string}`);
  const price =
    env.PRICE_SOURCE === "fixed"
      ? fixedPrice(env.CHAIN_ID)
      : await chainlinkPrice(client, { feed: env.PRICE_FEED!, sequencerFeed: env.SEQUENCER_FEED });
  const projection = projectionSource(pool, env.PONDER_SCHEMA);

  // One process per signer: a nonce sequence belongs to the key, not to an escrow (review 0005 R1).
  const signerLock = await pool.connect();
  const own = (await signerLock.query("SELECT pg_try_advisory_lock(hashtext('c8.rebalancer.signer:' || $1)) AS ok", [account.address.toLowerCase()])).rows[0].ok;
  if (!own) throw new Error(`another rebalancer process uses signer ${account.address}`);
  const loops = [];
  for (const escrow of env.ESCROWS) {
    // One writer per escrow: a second rebalancer on the same escrow would fight over nonces.
    const lock = await pool.connect();
    const got = (await lock.query("SELECT pg_try_advisory_lock(hashtext('c8.rebalancer:' || $1)) AS ok", [escrow.toLowerCase()])).rows[0].ok;
    if (!got) throw new Error(`another rebalancer is running for ${escrow}`);
    const usdc = (await client.readContract({ address: escrow, abi: [{ type: "function", name: "usdc", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" }], functionName: "usdc" })) as Address;
    const chain = viemChain({
      client,
      account,
      chainId: env.CHAIN_ID,
      escrow,
      price,
      liquidity: (vault) => (env.LIQUIDITY_SOURCE === "aave" ? aaveLiquidity(client, env.AAVE_POOL!, usdc) : mockVaultLiquidity(client, vault)),
      projection,
    });
    const alerts = new AlertOutbox(pool, env.CHAIN_ID, [new LogNotifier()]);
    loops.push(createExecutor({ pool, chain, dryRun: env.DRY_RUN, stuckAfterSec: env.STUCK_AFTER_SEC, policy: env.policy, alerts }));
    console.log(`rebalancer ${account.address} for ${escrow}: ${env.DRY_RUN ? "DRY RUN" : "LIVE"}`);
  }
  for (;;) {
    for (const ex of loops) await ex.cycle().catch((e) => console.error("cycle failed", e));
    await new Promise((r) => setTimeout(r, env.CYCLE_SEC * 1000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
