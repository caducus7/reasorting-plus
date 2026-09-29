// Brief C8 test 2, on Anvil with the MockYieldVault, the real contracts, Ponder, the C6 worker and the
// rebalancer sending real transactions: a booking entering the 14-day window is fully redeemed before
// check-in - 14 days + one cycle. Also: the rebalancer never produces a transaction the caps would
// reject (a lowered maxDeployBps makes it hold, not send), and every decision is in the log.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeEventLog, erc20Abi, erc4626Abi, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi, escrowFactoryAbi } from "@chain/abi";
import { localAccount } from "@chain/signer";
import { createWorker, type Worker } from "@chain/indexer/ops";
import { book, freshDb, KEYS, mockUsdcAbi, propertiesFile, startAnvil, startPonder, type Anvil, type Ponder } from "../../../indexer/test/anvil/harness.js";
import { migrate } from "../../src/db.js";
import { createExecutor } from "../../src/executor.js";
import { projectionSource, viemChain } from "../../src/chain.js";
import { mockVaultLiquidity } from "../../src/liquidity.js";
import { fixedPrice } from "../../src/price.js";

const GENESIS = Date.parse("2026-09-01T09:00:00Z") / 1000;
const DAY = 86_400;
const U = 1_000_000n;
const OWNER2 = "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97" as Hex; // Anvil account 8
const REBALANCER = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" as Hex; // Anvil account 9
const VAULT_ART = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../contracts/out/MockYieldVault.sol/MockYieldVault.json", import.meta.url)), "utf8"));

let a: Anvil;
let db: Awaited<ReturnType<typeof freshDb>>;
let ponder: Ponder;
let worker: Worker;
let escrow: Address;
let vault: Address;
let ex: ReturnType<typeof createExecutor>;
let checkIn: number;

const vaultAbi = parseAbi(["function deposit(uint256,address) returns (uint256)", "function setWithdrawLimit(uint256)"]);

async function mineTo(t: number) {
  await a.test.setNextBlockTimestamp({ timestamp: BigInt(t) });
  await a.test.mine({ blocks: 1 });
}
async function cycle() {
  await ponder.indexed(await a.client.getBlockNumber());
  await ex.cycle();
}
const idle = () => a.client.readContract({ address: a.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [escrow] });
const position = async () =>
  a.client.readContract({ address: vault, abi: erc4626Abi, functionName: "previewRedeem", args: [await a.client.readContract({ address: vault, abi: erc4626Abi, functionName: "balanceOf", args: [escrow] })] });
const log = async () => (await db.pool.query("SELECT kind, reason, outcome, amount::text AS amount, block FROM rebalancer.decisions ORDER BY id")).rows;

beforeAll(async () => {
  db = await freshDb();
  a = await startAnvil(GENESIS);
  const { migrate: migrateOps } = await import("@chain/indexer/ops");
  await migrateOps(db.pool);
  await migrate(db.pool);
  const owner2 = privateKeyToAccount(OWNER2).address;
  const admin = privateKeyToAccount(KEYS.admin).address;

  // MockYieldVault (5% APY), seeded to 0xdEaD (ADR 0013 §1), with a yield budget.
  const hash = await a.wallet(KEYS.admin).deployContract({ abi: VAULT_ART.abi, bytecode: VAULT_ART.bytecode.object, args: [a.dep.usdc, admin, 500n], chain: undefined } as never);
  vault = (await a.client.waitForTransactionReceipt({ hash })).contractAddress!;
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [admin, 1n + 100n * U] });
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "approve", args: [vault, 1n] });
  await a.send(KEYS.admin, { address: vault, abi: vaultAbi, functionName: "deposit", args: [1n, "0x000000000000000000000000000000000000dEaD"] });
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: erc20Abi, functionName: "transfer", args: [vault, 100n * U] });

  // A second escrow with that vault; this key is its rebalancer; 1 USDC reserve floor.
  await a.send(KEYS.admin, { address: a.dep.factory, abi: escrowFactoryAbi, functionName: "setDefaultVault", args: [vault] });
  await a.send(KEYS.admin, { address: a.dep.factory, abi: escrowFactoryAbi, functionName: "approveOwner", args: [owner2, 2_000, 500, 10_000_000n * U] });
  const r = await a.send(OWNER2, { address: a.dep.factory, abi: escrowFactoryAbi, functionName: "createEscrow", args: [owner2, privateKeyToAccount(KEYS.signer).address, 100n * U] });
  const created = r.logs.map((l) => { try { return decodeEventLog({ abi: escrowFactoryAbi, ...l }); } catch { return null; } }).find((e) => e?.eventName === "EscrowCreated");
  escrow = (created!.args as { escrow: Address }).escrow;
  await a.send(OWNER2, { address: escrow, abi: escrowAbi, functionName: "setRebalancer", args: [privateKeyToAccount(REBALANCER).address] });
  await a.send(KEYS.admin, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [owner2, U] });
  await a.send(OWNER2, { address: a.dep.usdc, abi: mockUsdcAbi, functionName: "approve", args: [escrow, U] });
  await a.send(OWNER2, { address: escrow, abi: escrowAbi, functionName: "fundReserve", args: [U] });

  ponder = await startPonder({ dbUrl: db.url, rpcUrl: a.url, factory: a.dep.factory, schema: "live_1", viewsSchema: "indexer" });
  worker = createWorker(
    { DATABASE_URL: db.url, RPC_URL: a.url, CHAIN_ID: 31337, PONDER_SCHEMA: "indexer", PROPERTIES_FILE: propertiesFile(), POLL_MS: 200, MONITOR_EVERY_MS: 1_000, RECEIVED_CONFIRMATIONS: 2, MAX_LAG_BLOCKS: 60 },
    db.pool,
    a.client as PublicClient,
    [],
  );
  const chain = viemChain({
    client: a.client as PublicClient,
    account: localAccount(REBALANCER, "test"),
    chainId: 31337,
    escrow,
    price: fixedPrice(31337),
    liquidity: (v) => mockVaultLiquidity(a.client as PublicClient, v),
    projection: projectionSource(db.pool, "indexer"),
  });
  ex = createExecutor({ pool: db.pool, chain, dryRun: false });
}, 300_000);

afterAll(async () => {
  ponder?.stop();
  a?.stop();
  await db?.drop();
});

describe("rebalancer on Anvil (brief C8 test 2)", () => {
  it("deploys the excess of finalised deposits within the caps", async () => {
    checkIn = (await a.now()) + 30 * DAY;
    await book(a, { escrow, checkInUtc: checkIn, nights: 5, priceAtomic: 1_000n * U });
    await cycle(); // the deposit is not finalised yet: nothing to deploy
    expect((await log()).at(-1)).toMatchObject({ kind: "hold" });
    await a.test.mine({ blocks: 70 }); // Anvil finalized = latest - 64
    await worker.tick();
    await cycle(); // deploy: min(excess 901, buffer 901, cap 900, liquidity) = 900 USDC
    await cycle(); // receipt
    const l = await log();
    expect(l.find((r) => r.kind === "deploy" && r.outcome === "sent")?.amount).toBe(`${900n * U}`);
    expect(l.some((r) => r.outcome === "mined")).toBe(true);
    expect(await position()).toBeGreaterThanOrEqual(900n * U - 2n);
  });

  it("never sends what the caps would reject: a lowered maxDeployBps makes it hold", async () => {
    await a.send(OWNER2, { address: escrow, abi: escrowAbi, functionName: "setMaxDeployBps", args: [5_000] });
    const before = (await log()).length;
    await cycle();
    const last = (await log()).slice(before);
    expect(last.map((r) => r.kind)).toEqual(["hold"]);
    await a.send(OWNER2, { address: escrow, abi: escrowAbi, functionName: "setMaxDeployBps", args: [9_000] });
  });

  it("holds just before the booking's 14-day window, then fully redeems it within one cycle of entering it", async () => {
    const windowStart = checkIn - 14 * DAY;
    await mineTo(windowStart - 120);
    await cycle();
    expect((await log()).at(-1)).toMatchObject({ kind: "hold" });
    expect(await idle()).toBeLessThan(1_000n * U);

    await mineTo(windowStart + 1); // the booking is now inside the window
    await cycle(); // redeem the gap
    const sent = (await log()).at(-1)!;
    expect(sent).toMatchObject({ kind: "redeem", reason: "below_required", outcome: "sent" });
    await cycle(); // receipt
    expect(await idle()).toBeGreaterThanOrEqual(1_000n * U); // the whole principal is liquid
    expect(await a.now()).toBeLessThanOrEqual(windowStart + 60); // within one cycle (60 s)
    // Explainable from the log alone: the redeem row carries the inputs and checks.
    const row = (await db.pool.query("SELECT snapshot, checks FROM rebalancer.decisions WHERE kind = 'redeem' AND outcome = 'sent'")).rows[0];
    expect(BigInt(row.snapshot.required)).toBeGreaterThanOrEqual(1_000n * U);
    expect(row.checks.some((c: { name: string; ok: boolean }) => c.name === "idle >= required liquid" && !c.ok)).toBe(true);
  });

  it("a liquidity crunch (< 5x the position) redeems everything the vault lets out", async () => {
    await mineTo(checkIn + 10 * DAY);
    // Market liquidity = the position itself: 1x, below the 5x exit threshold. (A 1-unit limit would
    // round to 0 withdrawable through ERC-4626's shares round trip: then it holds with an alert.)
    const pos = await position();
    expect(pos > 0n).toBe(true);
    await a.send(KEYS.admin, { address: vault, abi: vaultAbi, functionName: "setWithdrawLimit", args: [pos] });
    await cycle();
    expect((await log()).at(-1)).toMatchObject({ kind: "redeem", reason: "liquidity_exit", outcome: "sent" });
    await cycle();
    expect(await position()).toBeLessThanOrEqual(2n); // ERC-4626 rounding dust at most
  });
});
