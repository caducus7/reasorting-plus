// Rebalancer executor: one cycle per escrow. Snapshot -> decide (src/policy.ts) -> pre-check by
// simulation -> sign -> write-ahead -> broadcast, with:
//   - one transaction in flight per escrow (DB row, written before the broadcast, so a crash
//     rebroadcasts the same signed transaction instead of creating a second one);
//   - a stuck transaction replaced at the SAME nonce with fees bumped >= 12.5% (geth/erigon replace
//     rule): if the decision still holds, the same call; if not, a 0-value self-transfer that cancels
//     it. A replacement can never add a second deploy, because only one can mine at that nonce;
//   - a revert (pre-check or on-chain) puts that kind:reason on a doubling cooldown: no loops;
//   - dry run: decide and log only.
// Every cycle writes a decision row with the full snapshot and the checks behind it.
import type pg from "pg";
import { decide, DEFAULTS, type Config, type Decision, type Snapshot } from "./policy.js";

export type TxKind = "deploy" | "redeem" | "cancel";
export type SignRequest = { kind: TxKind; amount: bigint; nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
export type Sent = { raw: string };

/** Everything the executor needs from the chain; viem implementation in src/chain.ts. */
export interface ChainPort {
  chainId: number;
  escrow: string;
  sender: string;
  snapshot(): Promise<{ snapshot: Snapshot; block: bigint; rebalancer: string }>;
  simulate(kind: "deploy" | "redeem", amount: bigint): Promise<{ ok: true } | { ok: false; error: string }>;
  nonce(): Promise<number>; // mined transaction count of the sender
  fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  sign(req: SignRequest): Promise<{ raw: string; hash: string }>;
  send(raw: string): Promise<void>;
  receipt(hash: string): Promise<{ status: "success" | "reverted" } | null>;
}

export type ExecutorDeps = {
  pool: pg.Pool;
  chain: ChainPort;
  dryRun: boolean;
  now?: () => Date;
  stuckAfterSec?: number; // replace after this long unmined (default 180 s ≈ 90 Base blocks)
  cooldownSec?: number; // first cooldown after a revert (default 600 s), doubling
  maxCooldownSec?: number; // cap (default 6 h)
  policy?: Config;
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const bump = (x: bigint) => (x * 1125n + 999n) / 1000n; // +12.5%, rounded up

export function createExecutor(d: ExecutorDeps) {
  const c = d.chain;
  const now = d.now ?? (() => new Date());
  const esc = c.escrow.toLowerCase();

  async function log(
    x: { snapshot?: Snapshot; block?: bigint; decision?: Decision },
    kind: string,
    reason: string,
    outcome: string,
    extra: { amount?: bigint; tx?: string; detail?: string } = {},
  ): Promise<number> {
    const r = await d.pool.query(
      `INSERT INTO rebalancer.decisions (chain_id, escrow, at, block, snapshot, checks, kind, reason, amount, dry_run, outcome, tx_hash, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [c.chainId, esc, now(), x.block ?? null, json(x.snapshot ?? {}), json(x.decision?.checks ?? []), kind, reason,
        extra.amount?.toString() ?? null, d.dryRun, outcome, extra.tx ?? null, extra.detail ?? null],
    );
    return Number(r.rows[0].id);
  }

  async function coolingDown(key: string) {
    const r = await d.pool.query("SELECT until FROM rebalancer.cooldowns WHERE chain_id = $1 AND escrow = $2 AND key = $3", [c.chainId, esc, key]);
    return r.rowCount ? new Date(r.rows[0].until) > now() : false;
  }
  async function strike(key: string) {
    const cur = await d.pool.query("SELECT strikes FROM rebalancer.cooldowns WHERE chain_id = $1 AND escrow = $2 AND key = $3", [c.chainId, esc, key]);
    const strikes = (cur.rows[0]?.strikes ?? 0) + 1;
    const sec = Math.min((d.cooldownSec ?? 600) * 2 ** (strikes - 1), d.maxCooldownSec ?? 21_600);
    await d.pool.query(
      `INSERT INTO rebalancer.cooldowns (chain_id, escrow, key, strikes, until) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chain_id, escrow, key) DO UPDATE SET strikes = EXCLUDED.strikes, until = EXCLUDED.until`,
      [c.chainId, esc, key, strikes, new Date(now().getTime() + sec * 1000)],
    );
  }
  const clear = (key: string) => d.pool.query("DELETE FROM rebalancer.cooldowns WHERE chain_id = $1 AND escrow = $2 AND key = $3", [c.chainId, esc, key]);

  async function broadcast(raw: string) {
    await c.send(raw);
    await d.pool.query("UPDATE rebalancer.pending_tx SET broadcast = true WHERE chain_id = $1 AND escrow = $2", [c.chainId, esc]);
  }

  /** A transaction is in flight: settle it, rebroadcast it, replace it, or wait. */
  async function handlePending(p: Record<string, any>) {
    for (const h of p.hashes as string[]) {
      const r = await c.receipt(h);
      if (!r) continue;
      await d.pool.query("DELETE FROM rebalancer.pending_tx WHERE chain_id = $1 AND escrow = $2", [c.chainId, esc]);
      const reason = (await d.pool.query("SELECT reason FROM rebalancer.decisions WHERE id = $1", [p.decision_id])).rows[0]?.reason ?? "";
      const key = `${p.kind}:${reason}`;
      if (r.status === "success") {
        await log({}, p.kind, "receipt", "mined", { amount: BigInt(p.amount), tx: h });
        await d.pool.query("DELETE FROM rebalancer.cooldowns WHERE chain_id = $1 AND escrow = $2 AND key LIKE $3", [c.chainId, esc, `${p.kind}:%`]);
      } else {
        await log({}, p.kind, "receipt", "reverted", { amount: BigInt(p.amount), tx: h });
        await strike(key);
      }
      return;
    }
    if ((await c.nonce()) > Number(p.nonce)) {
      // Our nonce was used by a transaction we did not record (another sender with this key).
      await d.pool.query("DELETE FROM rebalancer.pending_tx WHERE chain_id = $1 AND escrow = $2", [c.chainId, esc]);
      await log({}, p.kind, "nonce", "nonce_consumed", { detail: `nonce ${p.nonce} used by an unknown transaction` });
      return;
    }
    if (!p.broadcast) {
      await broadcast(p.raw); // crashed between the write-ahead row and the broadcast
      return;
    }
    if (now().getTime() - new Date(p.last_sent_at).getTime() < (d.stuckAfterSec ?? 180) * 1000) return;

    // Stuck: re-decide. Same call if it still holds, else cancel. Same nonce either way.
    const s = await c.snapshot();
    const dec = decide(s.snapshot, d.policy ?? DEFAULTS);
    const same = p.kind !== "cancel" && dec.kind === p.kind && dec.kind !== "hold" && dec.amount === BigInt(p.amount);
    const cur = await c.fees();
    const maxFeePerGas = [bump(BigInt(p.max_fee)), cur.maxFeePerGas].reduce((a, b) => (b > a ? b : a));
    const maxPriorityFeePerGas = [bump(BigInt(p.priority_fee)), cur.maxPriorityFeePerGas].reduce((a, b) => (b > a ? b : a));
    const kind: TxKind = same ? (p.kind as TxKind) : "cancel";
    const amount = same ? BigInt(p.amount) : 0n;
    const signed = await c.sign({ kind, amount, nonce: Number(p.nonce), maxFeePerGas, maxPriorityFeePerGas });
    await d.pool.query(
      `UPDATE rebalancer.pending_tx SET kind = $3, amount = $4, hashes = array_append(hashes, $5), raw = $6, broadcast = false,
         max_fee = $7, priority_fee = $8, last_sent_at = $9 WHERE chain_id = $1 AND escrow = $2`,
      [c.chainId, esc, kind, amount.toString(), signed.hash, signed.raw, maxFeePerGas.toString(), maxPriorityFeePerGas.toString(), now()],
    );
    await log({ snapshot: s.snapshot, block: s.block, decision: dec }, same ? "replace" : "cancel", same ? "stuck" : `decision_changed:${dec.kind}:${dec.reason}`, "sent", {
      amount,
      tx: signed.hash,
      detail: `nonce ${p.nonce}, maxFee ${maxFeePerGas}, tip ${maxPriorityFeePerGas}`,
    });
    await broadcast(signed.raw);
  }

  async function cycle() {
    const pending = (await d.pool.query("SELECT * FROM rebalancer.pending_tx WHERE chain_id = $1 AND escrow = $2", [c.chainId, esc])).rows[0];
    if (pending) return handlePending(pending);

    const s = await c.snapshot();
    const dec = decide(s.snapshot, d.policy ?? DEFAULTS);
    await d.pool.query(
      `INSERT INTO rebalancer.required_liquid (chain_id, escrow, block, required, computed_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (chain_id, escrow) DO UPDATE SET block = EXCLUDED.block, required = EXCLUDED.required, computed_at = EXCLUDED.computed_at`,
      [c.chainId, esc, s.block, s.snapshot.required.toString(), now()],
    );
    const ctx = { snapshot: s.snapshot, block: s.block, decision: dec };
    if (dec.kind === "hold") return void (await log(ctx, "hold", dec.reason, "logged"));
    if (s.rebalancer.toLowerCase() !== c.sender.toLowerCase()) {
      return void (await log(ctx, dec.kind, dec.reason, "not_rebalancer", { amount: dec.amount, detail: `escrow rebalancer is ${s.rebalancer}` }));
    }
    const key = `${dec.kind}:${dec.reason}`;
    if (await coolingDown(key)) return void (await log(ctx, dec.kind, dec.reason, "cooldown", { amount: dec.amount }));
    const sim = await c.simulate(dec.kind, dec.amount);
    if (!sim.ok) {
      await strike(key);
      return void (await log(ctx, dec.kind, dec.reason, "precheck_reverted", { amount: dec.amount, detail: sim.error }));
    }
    if (d.dryRun) return void (await log(ctx, dec.kind, dec.reason, "dry_run", { amount: dec.amount }));

    const fees = await c.fees();
    const nonce = await c.nonce();
    const signed = await c.sign({ kind: dec.kind, amount: dec.amount, nonce, ...fees });
    const id = await log(ctx, dec.kind, dec.reason, "sent", { amount: dec.amount, tx: signed.hash, detail: `nonce ${nonce}` });
    await d.pool.query(
      `INSERT INTO rebalancer.pending_tx (chain_id, escrow, sender, nonce, kind, amount, hashes, raw, max_fee, priority_fee, decision_id, first_sent_at, last_sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$7], $8, $9, $10, $11, $12, $12)`,
      [c.chainId, esc, c.sender.toLowerCase(), nonce, dec.kind, dec.amount.toString(), signed.hash, signed.raw, fees.maxFeePerGas.toString(), fees.maxPriorityFeePerGas.toString(), id, now()],
    );
    await broadcast(signed.raw);
  }

  return { cycle };
}
