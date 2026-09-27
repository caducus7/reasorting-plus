// Replay diff (spec 10.3): a full rebuild in a separate schema compared with production. Journal
// entries, processed events and anomalies are immutable facts per block and must match exactly up to
// a common block; booking and escrow rows are compared where neither side changed them after it.
// Each schema's balance table must also equal the sum of its own journal.
import type pg from "pg";
import { checkpointBlock } from "../worker/projection.js";

export type DiffResult = { check: string; onlyInA: number; onlyInB: number; sample: unknown[] };
const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad schema name ${s}`);
  return `"${s}"`;
};

export async function checkpoint(pool: pg.Pool, schema: string): Promise<bigint> {
  const r = await pool.query(`SELECT latest_checkpoint FROM ${ident(schema)}._ponder_checkpoint`);
  return r.rows[0] ? checkpointBlock(r.rows[0].latest_checkpoint as string) : -1n;
}

async function except(pool: pg.Pool, qa: string, qb: string, args: unknown[]) {
  const a = await pool.query(`(${qa}) EXCEPT ALL (${qb})`, args);
  const b = await pool.query(`(${qb}) EXCEPT ALL (${qa})`, args);
  return { onlyInA: a.rowCount ?? 0, onlyInB: b.rowCount ?? 0, sample: [...a.rows.slice(0, 3), ...b.rows.slice(0, 3)] };
}

export async function diffSchemas(pool: pg.Pool, schemaA: string, schemaB: string, upTo: bigint): Promise<DiffResult[]> {
  const [A, B] = [ident(schemaA), ident(schemaB)];
  const n = [upTo.toString()];
  const out: DiffResult[] = [];
  for (const t of ["journal", "processed_event", "anomaly"]) {
    // Whole rows as JSON text: plain json columns have no equality operator for EXCEPT.
    const q = (s: string) => `SELECT row_to_json(x)::text AS r FROM ${s}.${t} x WHERE x.block_number <= $1`;
    out.push({ check: t, ...(await except(pool, q(A), q(B), n)) });
  }
  for (const t of ["booking", "escrow"]) {
    // Only rows that neither side has touched after upTo: both are then the state as of upTo.
    const q = (s: string, o: string) =>
      `SELECT row_to_json(x)::text AS r FROM ${s}.${t} x WHERE x.updated_block <= $1 AND NOT EXISTS (SELECT 1 FROM ${o}.${t} y WHERE y.id = x.id AND y.updated_block > $1)`;
    out.push({ check: t, ...(await except(pool, q(A, B), q(B, A), n)) });
  }
  for (const s of [A, B]) {
    const bal = `SELECT escrow, account, amount FROM ${s}.balance WHERE amount <> 0`;
    const fromJournal = `SELECT escrow, account,
        CASE WHEN account IN ('idle', 'deployed', 'loss_debt') THEN sum(amount) ELSE -sum(amount) END::numeric(78,0) AS amount
      FROM ${s}.journal GROUP BY escrow, account HAVING sum(amount) <> 0`;
    const r = await except(pool, `SELECT escrow, account, amount::numeric(78,0) FROM (${bal}) z`, fromJournal, []);
    out.push({ check: `balance_vs_journal:${s}`, ...r });
  }
  return out;
}

export const clean = (r: DiffResult[]) => r.every((x) => x.onlyInA === 0 && x.onlyInB === 0);
