// Deposits one booking on the local Anvil escrow and prints bookingId and block number.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { bookingIdOf, quoteTypedData } from "@chain/shared/eip712";
import { escrowAbi } from "@chain/abi";

const url = process.env.RPC_URL;
const dep = JSON.parse(readFileSync("/home/user/reasorting-plus/contracts/deployments/local.json", "utf8"));
const t = http(url);
const pub = createPublicClient({ chain: foundry, transport: t });
const w = (k) => createWalletClient({ chain: foundry, transport: t, account: privateKeyToAccount(k) });
const admin = w("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const guest = w("0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e");
const signer = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const now = Number((await pub.getBlock()).timestamp);
const read = (fn) => pub.readContract({ address: dep.escrow, abi: escrowAbi, functionName: fn });
const q = {
  resourceId: `0x${"44".repeat(32)}`, checkInUtc: now + 30 * 86400, checkOutUtc: now + 33 * 86400,
  priceAtomic: "900000000", feeBps: Number(await read("effectiveFeeBps")), guestYieldBps: Number(await read("guestYieldBps")),
  policyHash: `0x${"11".repeat(32)}`, cutoffs: [{ cutoffUtc: now + 10 * 86400, refundBps: 10000 }], finalBps: 0,
  guest: guest.account.address, expiresAt: now + 900, salt: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const td = quoteTypedData(q, 31337, dep.escrow);
const sig = await signer.signTypedData(td);
const usdc = parseAbi(["function mint(address,uint256)", "function approve(address,uint256) returns (bool)"]);
const wait = (h) => pub.waitForTransactionReceipt({ hash: h });
await wait(await admin.writeContract({ address: dep.usdc, abi: usdc, functionName: "mint", args: [guest.account.address, 900000000n] }));
await wait(await guest.writeContract({ address: dep.usdc, abi: usdc, functionName: "approve", args: [dep.escrow, 900000000n] }));
const r = await wait(await guest.writeContract({ address: dep.escrow, abi: escrowAbi, functionName: "deposit", args: [td.message, sig] }));
console.log(JSON.stringify({ bookingId: bookingIdOf(q), block: Number(r.blockNumber), status: r.status }));
