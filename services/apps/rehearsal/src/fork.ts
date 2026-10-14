// Local Anvil fork of Base Sepolia (chain id 84532 kept). Nothing here reaches the real chain: the
// fork RPC only reads Sepolia state up to the pinned block; every transaction stays in Anvil.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

export const CONTRACTS = fileURLToPath(new URL("../../../../contracts", import.meta.url));
/** Circle native USDC on Base Sepolia (same constant and on-chain checks as DeployBaseSepolia.s.sol). */
export const SEPOLIA_USDC: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
/** FiatTokenV2_2 `balanceAndBlacklistStates` mapping slot (bit 255 is the blacklist flag). */
const FIAT_TOKEN_BALANCE_SLOT = 9n;

/** Fresh throwaway keys per run, not Anvil's public dev keys: on Base Sepolia those addresses carry
 * EIP-7702 delegations set by strangers, and a delegated quote signer is rejected by the escrow
 * (SignatureChecker asks the code via ERC-1271). Fork-local only; funded with fork ETH at start.
 * Roles by index: 0 deployer / factory admin / vault owner, 1 escrow owner, 2 quote signer (KMS),
 * 3 guardian, 4 arbitrator, 5 rebalancer (KMS), 6 guest A, 7 guest B, 8 fee recipient, 9 payout. */
export const KEYS: readonly Hex[] = Array.from({ length: 10 }, () => generatePrivateKey());
export const addr = (i: number) => privateKeyToAccount(KEYS[i]!).address;

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function transfer(address, uint256) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/** keccak256("YieldAccrued(uint256,uint256,uint256)"), checked against the ABI in the rehearsal test. */
export const YIELD_ACCRUED_TOPIC = keccak256(toHex("YieldAccrued(uint256,uint256,uint256)"));
/** Absolute headroom over eth_estimateGas for escrow calls sent one at a time (rehearsal finding;
 * docs/rehearsals): the accrue() gain path costs up to 42,876 gas more than a no-gain estimate. */
export const ESCROW_GAS_HEADROOM = 60_000n;
/** Transactions whose gas used exceeded the node's estimate (sent with a margin, so they mined). */
export const estimateShortfalls: { fn: string; estimate: bigint; used: bigint; yieldAccrued: boolean }[] = [];

/** Replaces anything shaped like a private key (32-byte hex after --private-key, or a known key). */
export function redactKeys(text: string): string {
  let t = text.replace(/--private-key\s+0x[0-9a-fA-F]{64}/g, "--private-key <redacted>");
  for (const k of KEYS) t = t.replaceAll(k, "<redacted-key>");
  return t;
}

export async function startFork(o: { forkUrl: string; pinBlock: bigint; port?: number; blockTimeSec?: number }) {
  const port = o.port ?? 28_600 + Math.floor(Math.random() * 400);
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(
    "anvil",
    ["--fork-url", o.forkUrl, "--fork-block-number", String(o.pinBlock), "--retries", "10", "--timeout", "60000", "--fork-retry-backoff", "2000", "--port", String(port), "--block-time", String(o.blockTimeSec ?? 2), "--silent"],
    { stdio: "ignore" },
  );
  const chain = { ...baseSepolia, rpcUrls: { default: { http: [url] } } };
  const client = createPublicClient({ chain, transport: http(url), cacheTime: 0 }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 300) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if ((await client.getChainId()) !== 84_532) throw new Error("fork is not Base Sepolia");
  const test = createTestClient({ chain, mode: "anvil", transport: http(url) });
  for (let i = 0; i < KEYS.length; i++) {
    const a = addr(i);
    if (((await client.getCode({ address: a })) ?? "0x") !== "0x") throw new Error(`fresh key ${a} has code on Sepolia`);
    await test.setBalance({ address: a, value: 100n * 10n ** 18n });
  }
  const wallet = (i: number) => createWalletClient({ chain, transport: http(url), account: privateKeyToAccount(KEYS[i]!) });

  /** Sends and waits; returns the receipt (throws on revert). */
  async function send(i: number, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
    // Simulate first: a revert surfaces with its decoded custom error name, not just a status.
    const account = privateKeyToAccount(KEYS[i]!);
    await client.simulateContract({ ...req, account } as never);
    // Estimates run at the latest block's timestamp, but the vault grows every second: an escrow call
    // mined a block later can book a yield gain the estimate did not see (up to +42,876 gas measured).
    const estimate = await client.estimateContractGas({ ...req, account } as never);
    const hash = await wallet(i).writeContract({ ...req, chain, gas: estimate + ESCROW_GAS_HEADROOM } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.gasUsed > estimate) estimateShortfalls.push({ fn: req.functionName, estimate, used: receipt.gasUsed, yieldAccrued: receipt.logs.some((l) => l.topics[0] === YIELD_ACCRUED_TOPIC) });
    if (receipt.status !== "success") throw new Error(`${req.functionName} reverted (${hash}): ${await revertCause(hash, receipt.gasUsed)}`);
    return receipt;
  }

  /** Why a mined transaction reverted, from Anvil's call tracer (error, revert data, gas). */
  async function revertCause(hash: Hex, gasUsed: bigint): Promise<string> {
    try {
      const t = (await client.request({ method: "debug_traceTransaction" as never, params: [hash, { tracer: "callTracer" }] as never })) as {
        error?: string; revertReason?: string; output?: string; gas?: string; calls?: unknown[];
      };
      const tx = await client.getTransaction({ hash });
      const blk = await client.getBlock({ blockNumber: tx.blockNumber!, includeTransactions: true });
      const sameBlock = blk.transactions.filter((x) => typeof x !== "string" && x.hash !== hash).map((x) => (typeof x === "string" ? x : `${x.from}->${x.to}`));
      type Frame = { type?: string; to?: string; input?: string; gas?: string; gasUsed?: string; error?: string; output?: string; calls?: Frame[] };
      const flat: string[] = [];
      const walk = (f: Frame, depth: number) => {
        flat.push(`${"  ".repeat(depth)}${f.type} ${f.to} ${f.input?.slice(0, 10)} gas=${Number(f.gas)} used=${Number(f.gasUsed)}${f.error ? ` ERROR=${f.error}` : ""}${f.output && f.error ? ` out=${f.output.slice(0, 10)}` : ""}`);
        for (const c of f.calls ?? []) walk(c, depth + 1);
      };
      walk(t as Frame, 0);
      return JSON.stringify({ error: t.error, revertReason: t.revertReason, output: t.output?.slice(0, 10), gasLimit: tx.gas.toString(), gasUsed: gasUsed.toString(), indexInBlock: tx.transactionIndex, sameBlock }) + "\n" + flat.join("\n");
    } catch (e) {
      return `trace unavailable: ${(e as Error).message}`;
    }
  }

  /** Real Sepolia USDC credited by storage (Anvil only); verified through balanceOf. */
  async function fundUsdc(who: Address, amount: bigint) {
    if (amount >= 1n << 255n) throw new Error("amount collides with the blacklist bit");
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [who, FIAT_TOKEN_BALANCE_SLOT]));
    await test.setStorageAt({ address: SEPOLIA_USDC, index: slot, value: toHex(amount, { size: 32 }) });
    const got = await client.readContract({ address: SEPOLIA_USDC, abi: usdcAbi, functionName: "balanceOf", args: [who] });
    if (got !== amount) throw new Error(`USDC funding failed for ${who}: ${got}`);
  }

  /** Runs a forge script against the fork with an Anvil key; broadcast artifacts go to `outDir`. */
  function forgeScript(script: string, key: Hex, env: Record<string, string>, outDir: string) {
    let out: string;
    try {
      out = execFileSync("forge", ["script", script, "--rpc-url", url, "--broadcast", "--private-key", key, "--slow"], {
        cwd: CONTRACTS,
        env: { ...process.env, ...env, FOUNDRY_BROADCAST: outDir },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      // The command line carries the (throwaway) key: never let it reach a report or a log.
      const err = e as Error & { stderr?: string };
      throw new Error(redactKeys(`forge script ${script} failed: ${err.stderr ?? err.message}`));
    }
    const name = script.split("/").pop()!;
    const run = JSON.parse(readFileSync(join(outDir, name, "84532", "run-latest.json"), "utf8")) as {
      transactions: { contractName: string | null; contractAddress: string | null; transactionType: string; hash: string; function?: string | null }[];
      receipts: { transactionHash: string; gasUsed: string; status: string; blockNumber: string }[];
    };
    return { stdout: out, run };
  }

  return { url, port, client, test, wallet, send, revertCause, fundUsdc, forgeScript, stop: () => void proc.kill("SIGKILL") };
}
export type Fork = Awaited<ReturnType<typeof startFork>>;
