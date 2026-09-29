// Anvil + the real contracts (contracts/script/DeployLocal.s.sol) + a real `ponder start` process
// + a throwaway Postgres database. Anvil's public dev keys only (CLAUDE.md section 9).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { escrowAbi } from "@chain/abi";
import { quoteTypedData } from "@chain/shared/eip712";
import type { v1 } from "@chain/shared";

const CONTRACTS = fileURLToPath(new URL("../../../../../contracts", import.meta.url));
const APP = fileURLToPath(new URL("../..", import.meta.url));
export const TEST_PG_URL = process.env.TEST_PG_URL ?? "postgres://chain:chain@127.0.0.1:5432/postgres";

export const KEYS = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  signer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  guardian: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // account 3
  arbitrator: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // account 4
  feeRecipient: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // account 5
  guest: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // account 6
  relayer: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // account 7
} as const satisfies Record<string, Hex>;

export const RESOURCE = `0x${"a1".repeat(32)}` as Hex;
export const TZ = "Europe/Athens";

export const mockUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export type Deployment = { chainId: number; usdc: Address; factory: Address; escrow: Address };

export async function startAnvil(genesisUnix: number) {
  const port = 19_545 + Math.floor(Math.random() * 1_000);
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--timestamp", String(genesisUnix), "--silent"], { stdio: "ignore" });
  // cacheTime 0: viem caches eth_blockNumber for 4 s by default, which hides freshly mined blocks.
  const client = createPublicClient({ chain: foundry, transport: http(url), cacheTime: 0 }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  execFileSync("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", url, "--broadcast"], { cwd: CONTRACTS, stdio: "pipe" });
  const dep = JSON.parse(readFileSync(`${CONTRACTS}/deployments/local.json`, "utf8")) as Deployment;
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(url) });
  const wallet = (key: Hex) => createWalletClient({ chain: foundry, transport: http(url), account: privateKeyToAccount(key) });
  async function send(key: Hex, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
    const hash = await wallet(key).writeContract({ ...req, chain: foundry } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${req.functionName} reverted`);
    return receipt;
  }
  const now = async () => Number((await client.getBlock()).timestamp);
  return { url, client, test, dep, wallet, send, now, stop: () => void proc.kill("SIGKILL") };
}
export type Anvil = Awaited<ReturnType<typeof startAnvil>>;

/** Signs a quote with the local dev signer and deposits it as `guestKey` (funded here). */
export async function book(
  a: Anvil,
  o: { guestKey?: Hex; checkInUtc: number; nights: number; priceAtomic: bigint; cutoffs?: { cutoffUtc: number; refundBps: number }[]; finalBps?: number; escrow?: Address },
) {
  const guestKey = o.guestKey ?? KEYS.guest;
  const guest = privateKeyToAccount(guestKey).address;
  const escrow = o.escrow ?? a.dep.escrow;
  const read = (fn: string) => a.client.readContract({ address: escrow, abi: escrowAbi, functionName: fn as never }) as Promise<number>;
  const q: v1.Quote = {
    resourceId: RESOURCE,
    checkInUtc: o.checkInUtc,
    checkOutUtc: o.checkInUtc + o.nights * 86_400,
    priceAtomic: o.priceAtomic.toString(),
    feeBps: Number(await read("effectiveFeeBps")),
    guestYieldBps: Number(await read("guestYieldBps")),
    policyHash: `0x${"11".repeat(32)}`,
    cutoffs: o.cutoffs ?? [{ cutoffUtc: o.checkInUtc - 7 * 86_400, refundBps: 10_000 }],
    finalBps: o.finalBps ?? 0,
    guest,
    expiresAt: (await a.now()) + 3_600,
    salt: toHex(randomBytes(32)),
  };
  const td = quoteTypedData(q, a.dep.chainId, escrow);
  const sig = await privateKeyToAccount(KEYS.signer).signTypedData(td as never);
  await a.test.setBalance({ address: guest, value: 10n ** 20n });
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [guest, o.priceAtomic] });
  await a.send(guestKey, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "approve", args: [escrow, o.priceAtomic] });
  const receipt = await a.send(guestKey, { address: escrow, abi: escrowAbi, functionName: "deposit", args: [td.message, sig] });
  const bookingId = receipt.logs.find((l) => l.address.toLowerCase() === escrow.toLowerCase() && l.topics.length === 4)!.topics[1]!;
  return { bookingId: bookingId.toLowerCase() as Hex, block: receipt.blockNumber, guest, quote: q };
}

export async function freshDb() {
  const name = `idx_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = TEST_PG_URL.replace(/\/[^/]*$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url });
  return {
    url,
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: TEST_PG_URL });
      await a.connect();
      try {
        for (let i = 0; i < 100; i++) {
          try {
            await a.query(`DROP DATABASE IF EXISTS ${name}`);
            return;
          } catch (e) {
            if ((e as { code?: string }).code !== "55006") throw e;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

export function propertiesFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "c6-"));
  const f = join(dir, "properties.json");
  writeFileSync(f, JSON.stringify([{ resourceId: RESOURCE, tz: TZ }]));
  return f;
}

/** A `ponder start` process on a fresh schema, exposing its views under `viewsSchema`. */
export async function startPonder(o: { dbUrl: string; rpcUrl: string; factory: Address; schema: string; viewsSchema?: string; env?: Record<string, string> }) {
  const port = 43_000 + Math.floor(Math.random() * 2_000);
  const args = ["ponder", "start", "--schema", o.schema, "--port", String(port), "--hostname", "127.0.0.1"];
  if (process.env.DEBUG_PONDER) args.push("--log-level", "debug");
  if (o.viewsSchema) args.push("--views-schema", o.viewsSchema);
  let log = "";
  let exited: number | null = null;
  const proc = spawn("npx", args, {
    cwd: APP,
    env: {
      ...process.env,
      DATABASE_URL: o.dbUrl,
      CHAIN_ID: "31337",
      RPC_URL: o.rpcUrl,
      FACTORY_ADDRESS: o.factory,
      FACTORY_START_BLOCK: "0",
      POLLING_INTERVAL_MS: "200",
      ...o.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  proc.stdout!.on("data", (d) => (log += d));
  proc.stderr!.on("data", (d) => (log += d));
  proc.on("exit", (c) => (exited = c ?? -1));
  const base = `http://127.0.0.1:${port}`;
  // Ponder's /status reports the block it has synced; indexing can lag it. Wait on the indexing
  // checkpoint itself (the same value the worker's snapshot uses).
  const pool = new pg.Pool({ connectionString: o.dbUrl, max: 1 });
  const indexedBlock = async () => {
    const r = await pool.query(`SELECT latest_checkpoint FROM "${o.schema}"._ponder_checkpoint`);
    return r.rows[0] ? BigInt((r.rows[0].latest_checkpoint as string).slice(26, 42)) : -1n;
  };
  const until = async (cond: () => Promise<boolean>, what: string, ms = 60_000) => {
    const t = Date.now();
    for (;;) {
      if (exited !== null) throw new Error(`ponder exited (${exited}) while waiting for ${what}\n${log.slice(-3000)}`);
      try {
        if (await cond()) return;
      } catch {}
      if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}\n${log.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  await until(async () => (await fetch(`${base}/ready`)).status === 200, "ready", 120_000);
  return {
    base,
    get log() {
      return log;
    },
    get exited() {
      return exited;
    },
    /** Waits until Ponder has indexed through `block`. */
    indexed: (block: bigint) => until(async () => (await indexedBlock()) >= block, `block ${block}`),
    until,
    stop: () => {
      try {
        process.kill(-proc.pid!, "SIGKILL");
      } catch {}
      void pool.end();
    },
  };
}
export type Ponder = Awaited<ReturnType<typeof startPonder>>;
