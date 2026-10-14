// Deployment rehearsal on a local Anvil fork of Base Sepolia (milestones I1 and I4 in rehearsal form;
// the real runs wait for the owner's testnet wallet). Run:
//   pnpm -r build && pnpm --filter @chain/rehearsal rehearse
// Needs anvil + forge, Postgres (TEST_PG_URL), and a Base Sepolia RPC (BASE_SEPOLIA_RPC_URL, default
// the public https://sepolia.base.org) for reading fork state only. Every transaction stays in Anvil.
//
// What is real: the Sepolia state at the pinned block (Circle USDC, FiatToken permit/approve), the
// deploy scripts (DeployBaseSepolia, DeployTestnetVault) with their chain guards, chain id 84532,
// every service as its own process with its production entry point and SIGNER=kms (a loopback KMS
// stand-in, src/fakeKms.ts), the indexer's bearer token, ical-sync's SSRF guard.
// What is not: keys (fresh throwaway keys per run), time warps for yield and settlement, the KMS service.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { decodeEventLog, encodeEventTopics, getAddress, type Address, type Hex, type TransactionReceipt } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi, escrowFactoryAbi } from "@chain/abi";
import { startFakeKms, type FakeKms } from "../src/fakeKms.js";
import { ESCROW_GAS_HEADROOM, KEYS, addr, redactKeys, estimateShortfalls, SEPOLIA_USDC, startFork, usdcAbi, YIELD_ACCRUED_TOPIC, type Fork } from "../src/fork.js";
import { startProc, until, type Proc } from "../src/procs.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const FORK_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const PG = process.env.TEST_PG_URL ?? "postgres://chain:chain@127.0.0.1:5432/postgres";
const U = 1_000_000n;
const DAY = 86_400;
const TOKEN = `rehearsal-${"t".repeat(40)}`;
const VILLA = {
  resourceId: `0x${"5a".repeat(32)}`,
  name: "Villa (rehearsal)",
  tz: "Europe/Athens",
  maxGuests: 8,
  checkInTime: "15:00",
  checkOutTime: "11:00",
  nightlyAtomic: "800000000",
  policy: {
    id: "pol_standard_v1",
    rendered: "Full refund until 18:00 30 days before arrival; 50% until 14 days; 25% until 7 days.",
    rules: [
      { daysBefore: 30, time: "18:00", refundBps: 10_000 },
      { daysBefore: 14, time: "18:00", refundBps: 5_000 },
      { daysBefore: 7, time: "18:00", refundBps: 2_500 },
    ],
    finalBps: 0,
  },
};

type Step = { name: string; ok: boolean; detail: string };
const steps: Step[] = [];
const gas: { step: string; gasUsed: bigint; tx: string }[] = [];
const record = (name: string, detail: string) => steps.push({ name, ok: true, detail });
const trackGas = (step: string, r: TransactionReceipt) => gas.push({ step, gasUsed: r.gasUsed, tx: r.transactionHash });

let fork: Fork;
let kms: FakeKms;
let runDir: string;
let pool: pg.Pool;
let dbName: string;
let dbUrl: string;
let pinBlock: bigint;
const procs: Proc[] = [];
const d = {} as { factory: Address; impl: Address; vault: Address; escrow: Address; deployBlock: bigint; quoteSigner: Address; rebalancer: Address };
const ports = { ponder: 0, quote: 0, ical: 0 };
let jwtKey: CryptoKey;
let jwtPem: string;
let failure: string | null = null;

const kmsArn = (name: string) => `arn:aws:kms:eu-west-1:000000000000:key/${name}`;
const kmsEnv = () => ({ AWS_ENDPOINT_URL_KMS: kms.url, AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "rehearsal", AWS_SECRET_ACCESS_KEY: "rehearsal" });
const port = () => 30_000 + Math.floor(Math.random() * 10_000);
const ponderBase = () => `http://127.0.0.1:${ports.ponder}`;
const quoteBase = () => `http://127.0.0.1:${ports.quote}`;
const readEscrow = <T>(functionName: string, args: unknown[] = []) =>
  fork.client.readContract({ address: d.escrow, abi: escrowAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
const usdcOf = (who: Address) => fork.client.readContract({ address: SEPOLIA_USDC, abi: usdcAbi, functionName: "balanceOf", args: [who] });

async function guestJwt(guest: Address) {
  return new SignJWT({ addr: guest }).setProtectedHeader({ alg: "ES256" }).setIssuer("checkout").setAudience("booking-api").setIssuedAt().setExpirationTime("1h").sign(jwtKey);
}
async function api(path: string, init: { method?: string; body?: unknown; jwt?: string } = {}) {
  const r = await fetch(`${quoteBase()}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { "content-type": "application/json", ...(init.jwt ? { authorization: `Bearer ${init.jwt}` } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
async function indexerGet(path: string) {
  const r = await fetch(`${ponderBase()}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
/** Sends the service-built calls from a guest key, in order. */
async function execCalls(keyIndex: number, calls: { to: string; data: string }[], label: string, headroom = ESCROW_GAS_HEADROOM) {
  for (const [n, c] of calls.entries()) {
    const step = calls.length > 1 ? `${label} [${n + 1}/${calls.length}]` : label;
    const account = privateKeyToAccount(KEYS[keyIndex]!);
    const estimate = await fork.client.estimateGas({ account, to: c.to as Address, data: c.data as Hex });
    const hash = await fork.wallet(keyIndex).sendTransaction({ to: c.to as Address, data: c.data as Hex, gas: estimate + headroom, chain: fork.client.chain } as never);
    const r = await fork.client.waitForTransactionReceipt({ hash });
    if (r.gasUsed > estimate) estimateShortfalls.push({ fn: step, estimate, used: r.gasUsed, yieldAccrued: r.logs.some((l) => l.topics[0] === YIELD_ACCRUED_TOPIC) });
    if (r.status !== "success") throw new Error(`${step}: call to ${c.to} reverted (${hash}): ${await fork.revertCause(hash, r.gasUsed)}`);
    trackGas(step, r);
  }
}
async function indexedThrough(block: bigint) {
  await until(`indexer through block ${block}`, async () => {
    const r = await pool.query(`SELECT latest_checkpoint FROM "live"._ponder_checkpoint`);
    return r.rows[0] ? BigInt((r.rows[0].latest_checkpoint as string).slice(26, 42)) >= block : false;
  }, { procs, ms: 180_000 });
}
async function offerAndPrepare(checkIn: string, checkOut: string, guest: Address) {
  const o = await api("/v1/offers", { body: { resourceId: VILLA.resourceId, checkIn, checkOut, guests: 2, locale: "en" } });
  if (o.status !== 200) return { offer: o, prepare: null };
  const p = await api(`/v1/offers/${o.body.offerId as string}/prepare`, { body: { guestAddress: guest, email: "guest@example.com" } });
  return { offer: o, prepare: p };
}

beforeAll(async () => {
  runDir = mkdtempSync(join(tmpdir(), "rehearsal-"));
  mkdirSync(join(runDir, "broadcast"));
  const head = BigInt(execFileSync("cast", ["block-number", "--rpc-url", FORK_URL], { encoding: "utf8" }).trim());
  pinBlock = BigInt(process.env.REHEARSAL_PIN_BLOCK ?? head - 5n);
  fork = await startFork({ forkUrl: FORK_URL, pinBlock, blockTimeSec: 2 });
  kms = await startFakeKms({ "quote-signer": KEYS[2]!, rebalancer: KEYS[5]! });
  dbName = `rehearsal_${Date.now()}`;
  const admin = new pg.Client({ connectionString: PG });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  dbUrl = PG.replace(/\/[^/]*$/, `/${dbName}`);
  pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  const kp = await generateKeyPair("ES256");
  jwtKey = kp.privateKey;
  jwtPem = await exportSPKI(kp.publicKey);
  writeFileSync(join(runDir, "properties.json"), JSON.stringify([VILLA]));
}, 300_000);

afterAll(async () => {
  for (const p of procs.reverse()) p.stop();
  await new Promise((r) => setTimeout(r, 1_000));
  const alerts = pool ? (await pool.query("SELECT invariant, severity, dedupe_key, message, opened_at, resolved_at FROM indexer_ops.alerts ORDER BY id").catch(() => ({ rows: [] }))).rows : [];
  const decisions = pool ? (await pool.query("SELECT kind, reason, outcome, amount::text, tx_hash FROM rebalancer.decisions WHERE kind <> 'hold' OR outcome <> 'logged' ORDER BY id").catch(() => ({ rows: [] }))).rows : [];
  writeReport(alerts, decisions);
  await pool?.end();
  await kms?.close();
  fork?.stop();
  if (dbName && !process.env.REHEARSAL_KEEP_DB) {
    const admin = new pg.Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
}, 120_000);

describe.sequential("Base Sepolia fork rehearsal", () => {
  it("0. fork: chain 84532, real Circle USDC at the pinned block", async () => {
    try {
      expect(encodeEventTopics({ abi: escrowAbi, eventName: "YieldAccrued" })[0]).toBe(YIELD_ACCRUED_TOPIC);
      expect(await fork.client.getChainId()).toBe(84_532);
      expect(await fork.client.readContract({ address: SEPOLIA_USDC, abi: usdcAbi, functionName: "symbol" })).toBe("USDC");
      record("fork", `Base Sepolia pinned at block ${pinBlock} (${FORK_URL}); USDC ${SEPOLIA_USDC} symbol USDC, 6 decimals`);
    } catch (e) {
      failure = `0: ${(e as Error).message}`;
      throw e;
    }
  });

  it("1. deploy with the real scripts, then the owner and admin setup", async () => {
    try {
      await fork.fundUsdc(addr(0), 10_000n * U); // vault seed (1 unit) + yield budget
      await fork.fundUsdc(addr(1), 10n * U); // owner reserve
      await fork.fundUsdc(addr(6), 20_000n * U); // guest A
      await fork.fundUsdc(addr(7), 20_000n * U); // guest B

      const s1 = fork.forgeScript("script/DeployBaseSepolia.s.sol", KEYS[0]!, { FACTORY_ADMIN: addr(0), FEE_RECIPIENT: addr(8), GUARDIAN: addr(3), ARBITRATOR: addr(4) }, join(runDir, "broadcast"));
      const created = (n: string) => getAddress(s1.run.transactions.find((t) => t.contractName === n && t.transactionType === "CREATE")!.contractAddress!);
      d.factory = created("EscrowFactory");
      d.impl = created("Escrow");
      for (const t of s1.run.transactions) {
        const r = s1.run.receipts.find((x) => x.transactionHash === t.hash)!;
        gas.push({ step: `DeployBaseSepolia: ${t.transactionType === "CREATE" ? `deploy ${t.contractName}` : `${t.contractName ?? ""} ${t.function ?? t.transactionType}`}`, gasUsed: BigInt(r.gasUsed), tx: t.hash });
      }
      const s2 = fork.forgeScript("script/DeployTestnetVault.s.sol", KEYS[0]!, { VAULT_OWNER: addr(0), VAULT_APY_BPS: "500", FACTORY: d.factory }, join(runDir, "broadcast"));
      d.vault = getAddress(s2.run.transactions.find((t) => t.contractName === "MockYieldVault" && t.transactionType === "CREATE")!.contractAddress!);
      for (const t of s2.run.transactions) {
        const r = s2.run.receipts.find((x) => x.transactionHash === t.hash)!;
        gas.push({ step: `DeployTestnetVault: ${t.transactionType === "CREATE" ? `deploy ${t.contractName}` : `${t.contractName ?? "USDC"} ${t.function ?? t.transactionType}`}`, gasUsed: BigInt(r.gasUsed), tx: t.hash });
      }
      d.quoteSigner = privateKeyToAccount(KEYS[2]!).address;
      d.rebalancer = privateKeyToAccount(KEYS[5]!).address;

      trackGas("admin setDefaultVault", await fork.send(0, { address: d.factory, abi: escrowFactoryAbi, functionName: "setDefaultVault", args: [d.vault] }));
      trackGas("admin approveOwner", await fork.send(0, { address: d.factory, abi: escrowFactoryAbi, functionName: "approveOwner", args: [addr(1), 2_000, 500, 1_000_000n * U] }));
      const rc = await fork.send(1, { address: d.factory, abi: escrowFactoryAbi, functionName: "createEscrow", args: [addr(9), d.quoteSigner, 100n * U] });
      trackGas("owner createEscrow", rc);
      for (const l of rc.logs) {
        try {
          const ev = decodeEventLog({ abi: escrowFactoryAbi, ...l });
          if (ev.eventName === "EscrowCreated") d.escrow = (ev.args as { escrow: Address }).escrow;
        } catch {}
      }
      d.deployBlock = s1.run.receipts.reduce((m, r) => (BigInt(r.blockNumber) < m ? BigInt(r.blockNumber) : m), BigInt(s1.run.receipts[0]!.blockNumber));
      trackGas("owner approve reserve", await fork.send(1, { address: SEPOLIA_USDC, abi: usdcAbi, functionName: "approve", args: [d.escrow, 1n * U] }));
      trackGas("owner fundReserve", await fork.send(1, { address: d.escrow, abi: escrowAbi, functionName: "fundReserve", args: [1n * U] }));
      trackGas("owner setRebalancer", await fork.send(1, { address: d.escrow, abi: escrowAbi, functionName: "setRebalancer", args: [d.rebalancer] }));
      trackGas("vault owner: yield budget", await fork.send(0, { address: SEPOLIA_USDC, abi: usdcAbi, functionName: "transfer", args: [d.vault, 5_000n * U] }));

      expect(await readEscrow<Address>("vault")).toBe(d.vault);
      expect((await readEscrow<Address>("quoteSigner")).toLowerCase()).toBe(d.quoteSigner.toLowerCase());
      expect((await readEscrow<Address>("usdc")).toLowerCase()).toBe(SEPOLIA_USDC.toLowerCase());
      record("deploy", `factory ${d.factory}, implementation ${d.impl}, MockYieldVault ${d.vault} (seed burned to 0xdEaD), escrow ${d.escrow}`);
    } catch (e) {
      failure = `1: ${(e as Error).message}`;
      throw e;
    }
  });

  it("2. services start as processes: indexer, worker, quote service (KMS), rebalancer (KMS, live)", async () => {
    try {
      const fromBlock = d.deployBlock; // the factory's deployment block, from the broadcast receipts
      ports.ponder = port();
      ports.quote = port();
      const props = join(runDir, "properties.json");
      const common = { DATABASE_URL: dbUrl, CHAIN_ID: "84532", RPC_URL: fork.url, PONDER_SCHEMA: "indexer" };
      procs.push(
        startProc("ponder", "indexer", "start", { ...common, FACTORY_ADDRESS: d.factory, FACTORY_START_BLOCK: String(fromBlock), POLLING_INTERVAL_MS: "500", PONDER_LIVE_SCHEMA: "live", PONDER_HOST: "127.0.0.1", PORT: String(ports.ponder), INDEXER_API_TOKEN: TOKEN }, runDir),
      );
      await until("ponder ready", async () => (await fetch(`${ponderBase()}/ready`)).status === 200, { procs, ms: 240_000 });
      procs.push(startProc("worker", "indexer", "worker", { ...common, PROPERTIES_FILE: props, POLL_MS: "500", MONITOR_EVERY_MS: "5000", RECEIVED_CONFIRMATIONS: "2", MAX_LAG_BLOCKS: "60" }, runDir));
      procs.push(
        startProc("quote", "quote-service", "start", {
          ...common, ...kmsEnv(), PORT: String(ports.quote), HOST: "127.0.0.1", ESCROW: d.escrow, ESCROW_FROM_BLOCK: String(fromBlock),
          INDEXER_URL: ponderBase(), INDEXER_API_TOKEN: TOKEN, PROPERTIES_FILE: props, SIGNER: "kms", KMS_KEY_ID: kmsArn("quote-signer"),
          JWT_ISSUER: "checkout", JWT_AUDIENCE: "booking-api", JWT_PUBLIC_KEY_PEM: jwtPem, APY_ESTIMATE_BPS: "500", YIELD_PROTOCOL: "MockYieldVault (testnet)",
        }, runDir),
      );
      await until("quote service up", async () => (await fetch(`${quoteBase()}/v1/openapi.json`)).status === 200, { procs, ms: 120_000 });
      procs.push(
        startProc("rebalancer", "rebalancer", "start", {
          ...common, ...kmsEnv(), ESCROWS: d.escrow, DRY_RUN: "false", SIGNER: "kms", KMS_KEY_ID: kmsArn("rebalancer"), CYCLE_SEC: "10", STUCK_AFTER_SEC: "180",
          LIQUIDITY_SOURCE: "mock-vault", PRICE_SOURCE: "fixed",
        }, runDir),
      );
      await until("rebalancer first decision", async () => (await pool.query("SELECT 1 FROM rebalancer.decisions LIMIT 1")).rowCount! > 0, { procs, ms: 120_000 });
      expect(kms.calls.filter((c) => c.op === "GetPublicKey").length).toBeGreaterThanOrEqual(2);
      record("services", `ponder :${ports.ponder} (loopback, bearer token), worker, quote service :${ports.quote} (SIGNER=kms), rebalancer (SIGNER=kms, DRY_RUN=false, mock-vault, fixed price)`);
    } catch (e) {
      failure = `2: ${(e as Error).message}`;
      throw e;
    }
  });

  let bookingA: Hex;
  it("3. I1: guest A books through the API, sees the booking, cancels and is refunded", async () => {
    try {
      const guest = addr(6);
      const { offer, prepare } = await offerAndPrepare("2026-12-01", "2026-12-05", guest);
      expect(offer.status).toBe(200);
      expect(prepare?.status).toBe(200);
      const p = prepare!.body as { bookingId: Hex; calls: { to: string; data: string }[]; quote: { priceAtomic: string } };
      bookingA = p.bookingId;
      const before = await usdcOf(guest);
      await execCalls(6, p.calls, "guest A approve + deposit");
      expect(await usdcOf(guest)).toBe(before - BigInt(p.quote.priceAtomic));
      const jwt = await guestJwt(guest);
      await indexedThrough(await fork.client.getBlockNumber());
      const view = await api(`/v1/bookings/${bookingA}`, { jwt });
      expect(view.status).toBe(200);
      expect(view.body.state).toBe("ESCROWED");
      expect(view.body.priceAtomic).toBe(p.quote.priceAtomic);
      const other = await api(`/v1/bookings/${bookingA}`, { jwt: await guestJwt(addr(7)) });
      expect(other.status).toBe(403);

      const preview = await api(`/v1/bookings/${bookingA}/cancel-preview`, { method: "POST", jwt });
      expect(preview.status).toBe(200);
      expect(preview.body.refundBps).toBe(10_000);
      await execCalls(6, preview.body.calls as { to: string; data: string }[], "guest A cancel + claim");
      expect(await usdcOf(guest)).toBe(before);
      await indexedThrough(await fork.client.getBlockNumber());
      const after = await api(`/v1/bookings/${bookingA}`, { jwt });
      expect(after.body.state).not.toBe("ESCROWED");
      record("I1 book, status, cancel, refund", `booking ${bookingA}: ${p.quote.priceAtomic} atomic deposited, ESCROWED via /v1/bookings (indexer read model), another guest gets 403, cancel-preview 100% then cancel + claim refunded in full; state ${String(after.body.state)}, outcome ${String(after.body.outcome)}`);
    } catch (e) {
      failure = `3: ${(e as Error).message}`;
      throw e;
    }
  });

  let bookingB: Hex;
  let priceB: bigint;
  let bookingC: Hex;
  let priceC: bigint;
  it("4. guest B books a 7-night stay; guest A books a March stay (C)", async () => {
    try {
      const { prepare } = await offerAndPrepare("2026-12-10", "2026-12-17", addr(7));
      expect(prepare?.status).toBe(200);
      const p = prepare!.body as { bookingId: Hex; calls: { to: string; data: string }[]; quote: { priceAtomic: string } };
      bookingB = p.bookingId;
      priceB = BigInt(p.quote.priceAtomic);
      await execCalls(7, p.calls, "guest B approve + deposit");
      expect((await readEscrow<{ principalAtomic: bigint }>("getBooking", [bookingB])).principalAtomic).toBe(priceB);
      const c = await offerAndPrepare("2027-03-01", "2027-03-04", addr(6));
      expect(c.prepare?.status).toBe(200);
      const pc = c.prepare!.body as { bookingId: Hex; calls: { to: string; data: string }[]; quote: { priceAtomic: string } };
      bookingC = pc.bookingId;
      priceC = BigInt(pc.quote.priceAtomic);
      await execCalls(6, pc.calls, "guest A approve + deposit (booking C)");
      record("bookings B and C", `B ${bookingB}: ${priceB} atomic (7 nights at 800 USDC); C ${bookingC}: ${priceC} atomic (3 nights, guest A, March 2027)`);
    } catch (e) {
      failure = `4: ${(e as Error).message}`;
      throw e;
    }
  });

  it("5. channel sync on 84532: a loopback feed is refused, prepare fails closed, the export serves our nights at safe", async () => {
    try {
      ports.ical = port();
      const feedsFile = join(runDir, "feeds.json");
      writeFileSync(feedsFile, JSON.stringify([{ feedId: "airbnb-villa", resourceId: VILLA.resourceId, channel: "airbnb", url: "http://127.0.0.1:9/villa.ics" }]));
      const secret = "r".repeat(48);
      const env = { DATABASE_URL: dbUrl, CHAIN_ID: "84532", PONDER_SCHEMA: "indexer", FEEDS_FILE: feedsFile, PROPERTIES_FILE: join(runDir, "properties.json"), EXPORT_TOKEN_SECRET: secret, PUBLIC_BASE_URL: `http://127.0.0.1:${ports.ical}`, PORT: String(ports.ical), HOST: "127.0.0.1", POLL_INTERVAL_SEC: "60", STALE_ALERT_SEC: "60" };
      procs.push(startProc("ical", "ical-sync", "start", env, runDir));
      await until("feed attempt recorded", async () => (await pool.query("SELECT last_error FROM ical_sync.feed_state WHERE last_error IS NOT NULL")).rowCount! > 0, { procs, ms: 120_000 });
      const st = (await pool.query("SELECT last_status, last_error FROM ical_sync.feed_state")).rows[0];
      expect(st.last_status).toBe("fetch");
      const prep = await offerAndPrepare("2027-01-10", "2027-01-12", addr(6));
      expect(prep.prepare?.status ?? prep.offer.status).toBe(409);

      const urls = execFileSync("pnpm", ["run", "--silent", "export-urls"], { cwd: fileURLToPath(new URL("../../ical-sync", import.meta.url)), env: { ...process.env, ...env }, encoding: "utf8" });
      const url = urls.trim().split("\t").pop()!;
      await until("booking B in the export (safe head)", async () => (await (await fetch(url)).text()).includes("DTSTART;VALUE=DATE:20261210"), { procs, ms: 240_000 });
      const ics = await (await fetch(url)).text();
      expect(ics).not.toContain("20261201"); // the cancelled booking A is not exported
      record("channel sync", `feed fetch refused (${String(st.last_error).slice(0, 80)}); prepare for the villa then 409 (fails closed while the feed has never imported); export feed carries booking B (2026-12-10 to 12-17) once safe and not the cancelled A`);
    } catch (e) {
      failure = `5: ${(e as Error).message}`;
      throw e;
    }
  });

  it("6. rebalancer deploys finalised idle to the MockYieldVault through KMS-signed transactions", async () => {
    try {
      await fork.test.mine({ blocks: 70, interval: 2 }); // past Anvil's finalized tag (latest - 64)
      await until("a mined deploy", async () => (await pool.query("SELECT 1 FROM rebalancer.decisions WHERE kind = 'deploy' AND outcome = 'mined'")).rowCount! > 0, { procs, ms: 240_000 });
      const row = (await pool.query("SELECT amount::text, tx_hash FROM rebalancer.decisions WHERE kind = 'deploy' AND outcome = 'mined' ORDER BY id LIMIT 1")).rows[0];
      const shares = await fork.client.readContract({ address: d.vault, abi: [{ type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }] as const, functionName: "balanceOf", args: [d.escrow] });
      expect(shares).toBeGreaterThan(0n);
      const r = await fork.client.getTransactionReceipt({ hash: row.tx_hash as Hex });
      expect(r.from.toLowerCase()).toBe(d.rebalancer.toLowerCase());
      trackGas("rebalancer deploy", r);
      record("rebalancer deploy", `deployed ${row.amount} atomic in ${row.tx_hash}, signed via the KMS path (${kms.highS} high-s signatures normalised so far)`);
    } catch (e) {
      failure = `6: ${(e as Error).message}`;
      throw e;
    }
  });

  it("7. I4: accrual is visible through /v1/bookings and the indexer summary", async () => {
    try {
      await fork.test.increaseTime({ seconds: 30 * DAY });
      await fork.test.mine({ blocks: 1 });
      trackGas("keeper observeShortfall (accrue)", await fork.send(0, { address: d.escrow, abi: escrowAbi, functionName: "observeShortfall" }));
      await indexedThrough(await fork.client.getBlockNumber());
      const view = await api(`/v1/bookings/${bookingB}`, { jwt: await guestJwt(addr(7)) });
      expect(view.status).toBe(200);
      const accrued = BigInt(view.body.accruedYieldAtomic as string);
      expect(accrued).toBeGreaterThan(0n);
      const summary = await indexerGet(`/v1/indexer/escrows/${d.escrow}/summary`);
      expect(summary.status).toBe(200);
      const terms = await api(`/v1/yield/terms?bookingId=${bookingB}`);
      record("I4 accrual visible", `after 30 days at the mock's 5% APY: guest B's accruedYieldAtomic ${accrued} via /v1/bookings; indexer summary ${JSON.stringify(summary.body).slice(0, 300)}…; yield terms apyEstimateBps ${String(terms.body?.apyEstimateBps)}`);
    } catch (e) {
      failure = `7: ${(e as Error).message}`;
      throw e;
    }
  });

  it("7b. cancel and claim while funds are deployed: raw estimate vs headroom (the cancel-preview flow, one call at a time)", async () => {
    try {
      const jwt = await guestJwt(addr(6));
      const preview = await api(`/v1/bookings/${bookingC}/cancel-preview`, { method: "POST", jwt });
      expect(preview.status).toBe(200);
      expect(preview.body.refundBps).toBe(10_000);
      const [cancel, claim] = preview.body.calls as { to: string; data: string }[];
      const before = await usdcOf(addr(6));
      await execCalls(6, [cancel!], "guest A cancel (booking C)");
      // As an unbuffered wallet: gas = eth_estimateGas, estimated right after the cancel was mined.
      let raw = "mined";
      try {
        await execCalls(6, [claim!], "guest A claim, raw estimate", 0n);
      } catch (e) {
        raw = (e as Error).message.includes("out of gas") ? "reverted out of gas" : `reverted: ${(e as Error).message.slice(0, 120)}`;
      }
      if (raw !== "mined") await execCalls(6, [claim!], "guest A claim, estimate + headroom");
      expect(await usdcOf(addr(6))).toBe(before + priceC);
      record("cancel + claim with funds deployed", `refund ${priceC} paid in full. Claim sent with the bare estimate (no headroom): ${raw}${raw === "mined" ? "" : `; resent with estimate + ${ESCROW_GAS_HEADROOM} gas: mined`}`);
    } catch (e) {
      failure = `7b: ${(e as Error).message}`;
      throw e;
    }
  });

  it("8. stay delivered: settle, then guest, owner and fee recipient claim; books reconcile", async () => {
    try {
      const b = await readEscrow<{ checkOutUtc: number }>("getBooking", [bookingB]);
      const now = Number((await fork.client.getBlock()).timestamp);
      await fork.test.increaseTime({ seconds: Number(b.checkOutUtc) + 72 * 3_600 + 60 - now });
      await fork.test.mine({ blocks: 1 });
      trackGas("keeper settle", await fork.send(0, { address: d.escrow, abi: escrowAbi, functionName: "settle", args: [bookingB] }));
      const claim = async (i: number, label: string) => {
        const before = await usdcOf(addr(i));
        const owed = await readEscrow<bigint>("claimableOf", [addr(i)]);
        trackGas(label, await fork.send(i, { address: d.escrow, abi: escrowAbi, functionName: "claim" }));
        const got = (await usdcOf(addr(i))) - before;
        return { owed, got };
      };
      const g = await claim(7, "guest B claim (yield share)");
      const o = await claim(9, "payout claim");
      const f = await claim(8, "fee recipient claim");
      expect(o.owed).toBeGreaterThan(0n);
      expect(f.got).toBe((priceB * 500n) / 10_000n);
      expect(g.got).toBe(g.owed);
      expect(o.got).toBe(o.owed);
      await indexedThrough(await fork.client.getBlockNumber());
      record("settle and claims", `guest B yield ${g.got}, payout ${o.got} of ${o.owed}, fee ${f.got} (5% of ${priceB})`);
    } catch (e) {
      failure = `8: ${(e as Error).message}`;
      throw e;
    }
  });

  it("9. reconciliation: no invariant alert, replay diff clean", async () => {
    try {
      // The time warps jump a booking inside the 14-day liquid window while its principal is
      // deployed; INV-5 (idle below required liquid) may fire until the rebalancer redeems. That is
      // the liquidity monitor working. Accounting invariants must never fire, and nothing may stay open.
      const accounting = "invariant IN ('INV-1', 'INV-2', 'INV-3', 'INV-4', 'READ_FAILED', 'RECONCILE', 'ANOMALY', 'REPLAY')";
      await until("no open invariant alert", async () => (await pool.query("SELECT 1 FROM indexer_ops.alerts WHERE resolved_at IS NULL AND (invariant LIKE 'INV-%' OR invariant = 'READ_FAILED')")).rowCount === 0, { procs, ms: 180_000 });
      await new Promise((r) => setTimeout(r, 12_000)); // two more monitor rounds on the final state
      expect((await pool.query(`SELECT invariant, dedupe_key, message FROM indexer_ops.alerts WHERE ${accounting}`)).rows).toEqual([]);
      expect((await pool.query("SELECT 1 FROM indexer_ops.alerts WHERE resolved_at IS NULL AND (invariant LIKE 'INV-%' OR invariant = 'READ_FAILED')")).rowCount).toBe(0);
      const liq = (await pool.query("SELECT count(*)::int AS n FROM indexer_ops.alerts WHERE invariant = 'INV-5'")).rows[0].n as number;
      const out = execFileSync("pnpm", ["run", "--silent", "replay"], {
        cwd: fileURLToPath(new URL("../../indexer", import.meta.url)),
        env: { ...process.env, DATABASE_URL: dbUrl, CHAIN_ID: "84532", RPC_URL: fork.url, FACTORY_ADDRESS: d.factory, FACTORY_START_BLOCK: String(d.deployBlock), POLLING_INTERVAL_MS: "500", PONDER_LIVE_SCHEMA: "live", INDEXER_API_TOKEN: TOKEN },
        encoding: "utf8",
        timeout: 600_000,
      });
      const last = JSON.parse(out.trim().split("\n").pop()!) as { clean: boolean; upTo: string };
      expect(last.clean).toBe(true);
      record("reconciliation", `no accounting invariant alert (INV-1 to INV-4, READ_FAILED, RECONCILE, ANOMALY) at any point; ${liq} INV-5 liquidity alert(s) during the time warps (a warp jumps past the window in which the rebalancer would have redeemed), all resolved before the end: claims pull from the vault best-effort and the rebalancer redeems what remains required; nightly replay into a fresh schema diffs clean up to block ${last.upTo}`);
    } catch (e) {
      failure = `9: ${(e as Error).message}`;
      throw e;
    }
  });
});

function writeReport(alerts: Record<string, unknown>[], decisions: Record<string, unknown>[]) {
  const date = new Date().toISOString().slice(0, 10);
  const tools = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: "utf8" }).trim().split("\n")[0];
    } catch {
      return "unknown";
    }
  };
  const lines = [
    `# Rehearsal: Base Sepolia fork, ${date}`,
    "",
    `**Result:** ${failure ? `FAILED at step ${failure}` : `all ${steps.length} steps passed`}.`,
    "",
    "Generated by `pnpm --filter @chain/rehearsal rehearse` (services/apps/rehearsal). Local Anvil fork of Base",
    `Sepolia at block ${pinBlock}; nothing was sent to a real chain. Fresh throwaway keys; KMS via the loopback stand-in.`,
    `Tools: ${tools("forge", ["--version"])}; ${tools("anvil", ["--version"])}; node ${process.version}.`,
    "",
    "## Steps",
    "",
    "| Step | Detail |",
    "|---|---|",
    ...steps.map((s) => `| ${s.name} | ${s.detail.replaceAll("|", "\\|")} |`),
    "",
    "## Gas used (deployment and setup are what the real Sepolia run will pay)",
    "",
    "| Step | Gas | Tx |",
    "|---|---|---|",
    ...gas.map((g) => `| ${g.step} | ${g.gasUsed.toLocaleString("en-US")} | \`${g.tx.slice(0, 18)}…\` |`),
    `| **Total** | **${gas.reduce((a, g) => a + g.gasUsed, 0n).toLocaleString("en-US")}** | |`,
    "",
    `## Gas estimates that fell short (sent with estimate + ${ESCROW_GAS_HEADROOM} gas, so they mined)`,
    "",
    ...(estimateShortfalls.length
      ? estimateShortfalls.map((x) => `- ${x.fn}: estimate ${x.estimate.toLocaleString("en-US")}, used ${x.used.toLocaleString("en-US")} (+${(((Number(x.used) - Number(x.estimate)) / Number(x.estimate)) * 100).toFixed(1)}%)${x.yieldAccrued ? ", booked a yield gain the estimate did not see" : ""}`)
      : ["- none"]),
    "",
    "## Rebalancer actions",
    "",
    ...(decisions.length ? decisions.map((r) => `- ${r.kind} ${r.reason}: ${r.outcome}${r.amount ? `, ${r.amount} atomic` : ""}${r.tx_hash ? `, \`${String(r.tx_hash).slice(0, 18)}…\`` : ""}`) : ["- none"]),
    "",
    "## Alerts raised during the run",
    "",
    ...(alerts.length ? alerts.map((a) => `- ${a.invariant} (${a.severity}) \`${a.dedupe_key}\`${a.resolved_at ? ", resolved" : ", open at the end"}: ${String(a.message).slice(0, 200)}`) : ["- none"]),
    "",
  ];
  const dir = join(REPO, "docs", "rehearsals");
  mkdirSync(dir, { recursive: true });
  const text = redactKeys(lines.join("\n"));
  writeFileSync(join(dir, `${date}-base-sepolia-fork.md`), text);
  writeFileSync(join(runDir, "report.md"), text);
  console.log(`report: docs/rehearsals/${date}-base-sepolia-fork.md; logs: ${runDir}`);
}
