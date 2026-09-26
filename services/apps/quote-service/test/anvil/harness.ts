// Local Anvil + the C1 contracts, deployed with contracts/script/DeployLocal.s.sol. Anvil's public
// dev keys only (CLAUDE.md section 9); nothing here can touch a real chain.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const CONTRACTS = fileURLToPath(new URL("../../../../../contracts", import.meta.url));

export const KEYS = {
  admin: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  signer: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  guest: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // account 6
  relayer: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // account 7
} as const satisfies Record<string, Hex>;

export type Deployment = {
  chainId: number;
  usdc: Address;
  factory: Address;
  escrow: Address;
  owner: Address;
  quoteSigner: Address;
  admin: Address;
  arbitrator: Address;
  feeRecipient: Address;
  batchWallet: Address;
};

export const mockUsdcAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
export const batchWalletAbi = parseAbi(["function execute((address to, bytes data)[] calls)"]);

export async function startAnvil(genesisUnix: number) {
  const port = 18_545 + Math.floor(Math.random() * 1_000);
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn("anvil", ["--port", String(port), "--timestamp", String(genesisUnix), "--silent"], {
    stdio: "ignore",
  });
  const client = createPublicClient({ chain: foundry, transport: http(url) }) as PublicClient;
  for (let i = 0; ; i++) {
    try {
      await client.getChainId();
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  execFileSync("forge", ["script", "script/DeployLocal.s.sol", "--rpc-url", url, "--broadcast"], {
    cwd: CONTRACTS,
    stdio: "pipe",
  });
  const dep = JSON.parse(readFileSync(`${CONTRACTS}/deployments/local.json`, "utf8")) as Deployment;
  const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(url) });
  const wallet = (key: Hex) => createWalletClient({ chain: foundry, transport: http(url), account: privateKeyToAccount(key) });

  /** Mine the next transaction at exactly `unix` (chain time is strictly increasing). */
  const at = (unix: number) => test.setNextBlockTimestamp({ timestamp: BigInt(unix) });
  const now = async () => Number((await client.getBlock()).timestamp);
  const mineAt = async (unix: number) => {
    await at(unix);
    await test.mine({ blocks: 1 });
  };

  async function send(key: Hex, req: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
    const hash = await wallet(key).writeContract({ ...req, chain: foundry } as never);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${req.functionName} reverted`);
    return receipt;
  }

  return {
    url,
    client,
    test,
    dep,
    wallet,
    send,
    at,
    now,
    mineAt,
    stop: () => void proc.kill("SIGKILL"),
  };
}

export type Anvil = Awaited<ReturnType<typeof startAnvil>>;
