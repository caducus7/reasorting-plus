// Per-booking head milestones (spec 10.2): received at unsafe + N, safe, finalized; reverted when a
// deposit that had a milestone leaves the chain. Outbox rows + NOTIFY booking_milestone.
import type pg from "pg";
import type { PublicClient } from "viem";
import { RESPONSE, type Breach } from "../core/invariants.js";
import type { Heads } from "./heads.js";
import type { Snapshot } from "./projection.js";

type Milestone = "received" | "safe" | "finalized" | "reverted";

export async function updateMilestones(
  pool: pg.Pool,
  client: PublicClient,
  chainId: number,
  heads: Heads,
  snap: Snapshot,
  confirmations: number,
): Promise<{ inserted: number; breaches: Breach[] }> {
  const rows = (
    await pool.query("SELECT escrow, booking_id, deposit_hash, deposit_block, milestone FROM indexer_ops.booking_milestones WHERE chain_id = $1", [chainId])
  ).rows as { escrow: string; booking_id: string; deposit_hash: string; deposit_block: string; milestone: Milestone }[];
  const have = new Map<string, Set<Milestone>>();
  for (const r of rows) {
    const k = `${r.escrow}:${r.booking_id}:${r.deposit_hash}`;
    (have.get(k) ?? have.set(k, new Set()).get(k)!).add(r.milestone);
  }
  const canonical = new Map<bigint, string>();
  const isCanonical = async (n: bigint, hash: string) => {
    if (!canonical.has(n)) canonical.set(n, (await client.getBlock({ blockNumber: n })).hash!);
    return canonical.get(n) === hash;
  };

  let inserted = 0;
  const insert = async (escrow: string, bookingId: string, hash: string, block: bigint, m: Milestone, head: bigint) => {
    const r = await pool.query(
      `INSERT INTO indexer_ops.booking_milestones (chain_id, escrow, booking_id, milestone, deposit_block, deposit_hash, head_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [chainId, escrow, bookingId, m, block.toString(), hash, head.toString()],
    );
    if (r.rowCount) {
      inserted++;
      await pool.query("SELECT pg_notify('booking_milestone', $1)", [
        JSON.stringify({ chainId, escrow, bookingId, milestone: m, depositBlock: block.toString(), depositHash: hash }),
      ]);
    }
  };

  const live = new Set<string>();
  for (const b of snap.bookings) {
    const escrow = b.escrow.toLowerCase();
    const hash = b.depositBlockHash.toLowerCase();
    const k = `${escrow}:${b.bookingId}:${hash}`;
    live.add(k);
    const got = have.get(k) ?? new Set();
    if (!got.has("received") && heads.latest.number >= b.depositBlock + BigInt(confirmations)) {
      await insert(escrow, b.bookingId, hash, b.depositBlock, "received", heads.latest.number);
    }
    for (const tag of ["safe", "finalized"] as const) {
      if (got.has(tag) || heads[tag].number < b.depositBlock) continue;
      // Only a deposit that is canonical at that height reaches the tag; if Ponder has not rolled a
      // reorg back yet, wait for it.
      if (await isCanonical(b.depositBlock, hash)) await insert(escrow, b.bookingId, hash, b.depositBlock, tag, heads[tag].number);
    }
  }

  const breaches: Breach[] = [];
  for (const [k, got] of have) {
    if (live.has(k) || got.has("reverted")) continue;
    const [escrow, bookingId, hash] = k.split(":") as [string, string, string];
    const block = BigInt(rows.find((r) => `${r.escrow}:${r.booking_id}:${r.deposit_hash}` === k)!.deposit_block);
    await insert(escrow, bookingId, hash, block, "reverted", heads.latest.number);
    if (got.has("safe") || got.has("finalized")) {
      breaches.push({
        invariant: "DEEP_REORG",
        severity: "page",
        key: `DEEP_REORG:booking:${bookingId}:${hash}`,
        escrow,
        message: `booking ${bookingId} reached safe and then left the chain; its calendar slot stays blocked`,
        response: RESPONSE.DEEP_REORG!,
      });
    }
  }
  return { inserted, breaches };
}
