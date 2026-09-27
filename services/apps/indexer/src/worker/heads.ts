// Head tracker (docs/adr/0014 gap 1): the chain's own latest/safe/finalized tags with hashes.
// Every spec 10.2 action is gated on these, never on Ponder's latest-minus-N heuristic.
import type pg from "pg";
import type { Hex, PublicClient } from "viem";
import { RESPONSE, type Breach } from "../core/invariants.js";

export const TAGS = ["latest", "safe", "finalized"] as const;
export type Tag = (typeof TAGS)[number];
export type Head = { number: bigint; hash: Hex; ts: bigint };
export type Heads = Record<Tag, Head>;

export async function readHeads(client: PublicClient): Promise<Heads> {
  const get = async (blockTag: Tag): Promise<Head> => {
    const b = await client.getBlock({ blockTag });
    return { number: b.number!, hash: b.hash!, ts: b.timestamp };
  };
  const [latest, safe, finalized] = await Promise.all([get("latest"), get("safe"), get("finalized")]);
  return { latest, safe, finalized };
}

/**
 * Stores the heads and publishes each change (outbox row + NOTIFY chain_head). A safe or finalized
 * head that moves backwards, or whose previous block is no longer canonical, is a deep reorg: page
 * (docs/adr/0014 gap 2).
 */
export async function recordHeads(pool: pg.Pool, client: PublicClient, chainId: number, heads: Heads): Promise<Breach[]> {
  const breaches: Breach[] = [];
  for (const tag of TAGS) {
    const h = heads[tag];
    const prev = (await pool.query("SELECT number, hash FROM indexer_ops.chain_heads WHERE chain_id = $1 AND tag = $2", [chainId, tag]))
      .rows[0] as { number: string; hash: string } | undefined;
    if (prev && BigInt(prev.number) === h.number && prev.hash === h.hash) continue;
    if (prev && tag !== "latest") {
      const pn = BigInt(prev.number);
      const moved = h.number < pn || (h.number === pn && prev.hash !== h.hash);
      const stillCanonical = moved ? false : (await client.getBlock({ blockNumber: pn })).hash === prev.hash;
      if (!stillCanonical) {
        breaches.push({
          invariant: "DEEP_REORG",
          severity: "page",
          key: `DEEP_REORG:${tag}:${prev.number}:${prev.hash}`,
          message: `${tag} head ${prev.number} (${prev.hash}) left the canonical chain`,
          response: RESPONSE.DEEP_REORG!,
        });
      }
    }
    await pool.query(
      `INSERT INTO indexer_ops.chain_heads (chain_id, tag, number, hash, ts, updated_at) VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (chain_id, tag) DO UPDATE SET number = EXCLUDED.number, hash = EXCLUDED.hash, ts = EXCLUDED.ts, updated_at = now()`,
      [chainId, tag, h.number.toString(), h.hash, h.ts.toString()],
    );
    await pool.query("INSERT INTO indexer_ops.head_events (chain_id, tag, number, hash, ts) VALUES ($1, $2, $3, $4, $5)", [
      chainId, tag, h.number.toString(), h.hash, h.ts.toString(),
    ]);
    await pool.query("SELECT pg_notify('chain_head', $1)", [
      JSON.stringify({ chainId, tag, number: h.number.toString(), hash: h.hash, ts: h.ts.toString() }),
    ]);
  }
  return breaches;
}
