// The executor's ChainPort on viem, and the snapshot the policy decides on. All escrow and vault
// reads are pinned to one block; the finalized-head reads make "only finalised deposits count" and
// the conservative required amount (spec 6.7, 10.2).
import type pg from "pg";
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  erc20Abi,
  erc4626Abi,
  keccak256,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { escrowAbi } from "@chain/abi";
import { requiredLiquid, type LedgerFields } from "@chain/indexer/invariants";
import type { ChainPort } from "./executor.js";
import type { Snapshot } from "./policy.js";
import type { PriceSource } from "./price.js";
import type { LiquiditySource } from "./liquidity.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Open bookings (for the 14-day window) and the projection's checkpoint, from C6's views. */
export function projectionSource(pool: pg.Pool, schema: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("bad schema");
  return {
    async openBookings(escrow: Address) {
      const r = await pool.query(
        `SELECT status, check_in_utc, principal_atomic FROM "${schema}".booking WHERE escrow = $1 AND status IN ('ESCROWED', 'FROZEN')`,
        [escrow.toLowerCase()],
      );
      return r.rows.map((x) => ({ status: x.status, checkInUtc: BigInt(x.check_in_utc), principalAtomic: BigInt(x.principal_atomic) }));
    },
    async checkpointBlock() {
      const r = await pool.query(`SELECT latest_checkpoint FROM "${schema}"._ponder_checkpoint`);
      return r.rows[0] ? BigInt((r.rows[0].latest_checkpoint as string).slice(26, 42)) : 0n;
    },
  };
}
export type Projection = ReturnType<typeof projectionSource>;

export function viemChain(o: {
  client: PublicClient;
  account: LocalAccount;
  chainId: number;
  escrow: Address;
  price: PriceSource;
  liquidity: (vault: Address) => LiquiditySource;
  projection: Projection;
}): ChainPort {
  const { client, account, escrow } = o;
  const read = <T>(functionName: string, blockNumber: bigint, args: unknown[] = []) =>
    client.readContract({ address: escrow, abi: escrowAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const fieldsAt = async (b: bigint) => {
    // An escrow younger than the finalized head has nothing finalized: zeros (the safe direction).
    if (!(await client.getCode({ address: escrow, blockNumber: b }))) return { open: 0n, disputed: 0n, pending: 0n, claimable: 0n };
    const [open, disputed, pending, claimable] = await Promise.all(
      ["totalOpenPrincipal", "totalDisputed", "totalPendingYield", "totalClaimable"].map((f) => read<bigint>(f, b)),
    );
    return { open: open!, disputed: disputed!, pending: pending!, claimable: claimable! };
  };

  async function snapshot() {
    const latest = await client.getBlock({ blockTag: "latest" });
    const fin = await client.getBlock({ blockTag: "finalized" });
    const B = latest.number!;
    const [vault, writtenOff, lossDebt, shortfallSince, reserve, maxDeployBps, rebalancer, usdc] = await Promise.all([
      read<Address>("vault", B),
      read<boolean>("vaultWrittenOff", B),
      read<bigint>("lossDebt", B).then(BigInt),
      read<number | bigint>("shortfallSince", B).then(BigInt), // uint40 decodes to a JS number
      read<bigint>("reserve", B).then(BigInt),
      read<number>("maxDeployBps", B),
      read<Address>("rebalancer", B),
      read<Address>("usdc", B),
    ]);
    const [now, atFin] = [await fieldsAt(B), await fieldsAt(fin.number!)];
    const idle = await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [escrow], blockNumber: B });
    const usdcAtFin = await client.getCode({ address: usdc, blockNumber: fin.number! });
    const idleFinalized = usdcAtFin ? await client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [escrow], blockNumber: fin.number! }) : 0n;
    const hasVault = vault !== ZERO;
    let vaultTotalSupply = 0n, position = 0n, maxWithdraw = 0n, marketAvailable = 0n;
    if (hasVault) {
      const v = (functionName: string, args: unknown[] = []) =>
        client.readContract({ address: vault, abi: erc4626Abi, functionName: functionName as never, args: args as never, blockNumber: B }) as Promise<bigint>;
      const shares = await v("balanceOf", [escrow]);
      [vaultTotalSupply, position, maxWithdraw, marketAvailable] = await Promise.all([
        v("totalSupply"),
        v("previewRedeem", [shares]),
        v("maxWithdraw", [escrow]),
        o.liquidity(vault)(B),
      ]);
    }
    // Required liquid (spec 6.7), conservative: each liability total at whichever of the latest and
    // finalized heads is larger; every open booking the projection knows, finalized or not.
    const f: LedgerFields = {
      totalOpenPrincipal: max(now.open, atFin.open),
      totalDisputed: max(now.disputed, atFin.disputed),
      totalPendingYield: max(now.pending, atFin.pending),
      totalClaimable: max(now.claimable, atFin.claimable),
      reserve, lossDebt, accYieldPerUnit: 0n, lastAssets: 0n, yieldUnallocated: 0n, ownerClaimable: 0n, pendingOwnerYield: 0n, shortfallSince,
    };
    const bookings = await o.projection.openBookings(escrow);
    const required = requiredLiquid(f, bookings as never, latest.timestamp);
    const snapshot: Snapshot = {
      now: latest.timestamp,
      hasVault,
      vaultWrittenOff: writtenOff,
      vaultTotalSupply,
      idle,
      idleFinalized,
      position,
      maxWithdraw,
      marketAvailable,
      lossDebt,
      shortfallSince,
      reserve,
      liabilities: now.open + now.disputed + now.pending + now.claimable, // on-chain, for the caps
      maxDeployBps: Number(maxDeployBps),
      required,
      price: await o.price(latest.timestamp),
      projectionLagBlocks: B - (await o.projection.checkpointBlock()),
    };
    return { snapshot, block: B, rebalancer };
  }

  const gasFor = new Map<string, bigint>();
  return {
    chainId: o.chainId,
    escrow,
    sender: account.address,
    snapshot,
    async simulate(kind, amount) {
      try {
        await client.simulateContract({ address: escrow, abi: escrowAbi, functionName: kind, args: [amount], account: account.address });
        return { ok: true };
      } catch (e) {
        const rev = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        const name = rev instanceof ContractFunctionRevertedError ? (rev.data?.errorName ?? rev.reason ?? "reverted") : (e as Error).message.slice(0, 160);
        return { ok: false, error: name };
      }
    },
    nonce: () => client.getTransactionCount({ address: account.address, blockTag: "latest" }),
    async fees() {
      const f = await client.estimateFeesPerGas();
      return { maxFeePerGas: f.maxFeePerGas!, maxPriorityFeePerGas: f.maxPriorityFeePerGas! };
    },
    async sign(req) {
      let to: Address = escrow, data: Hex = "0x", gas = 21_000n;
      if (req.kind !== "cancel") {
        data = encodeFunctionData({ abi: escrowAbi, functionName: req.kind, args: [req.amount] });
        const k = `${req.kind}:${req.amount}`;
        if (!gasFor.has(k)) gasFor.set(k, ((await client.estimateGas({ account: account.address, to: escrow, data })) * 13n) / 10n);
        gas = gasFor.get(k)!;
      } else to = account.address; // 0-value self-transfer: replaces whatever sits at this nonce
      const raw = await account.signTransaction({
        chainId: o.chainId, type: "eip1559", nonce: req.nonce, to, data, value: 0n, gas,
        maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas,
      });
      return { raw, hash: keccak256(raw) };
    },
    async send(raw) {
      try {
        await client.sendRawTransaction({ serializedTransaction: raw as Hex });
      } catch (e) {
        // Already in the pool, or its nonce already mined: the pending handler reconciles both.
        if (/already known|nonce too low|replacement transaction underpriced/i.test((e as Error).message)) return;
        throw e;
      }
    },
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash: hash as Hex });
        return { status: r.status };
      } catch (e) {
        if (e instanceof TransactionReceiptNotFoundError) return null;
        throw e;
      }
    },
  };
}
