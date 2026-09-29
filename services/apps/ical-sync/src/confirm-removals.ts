// Approves a feed's held mass removal (review 0006 G1; runbook: Channel sync). Approves exactly the
// set held now, so a removal that grows after the operator looked is judged again. Clears the
// conditional-GET validators so the next poll re-imports instead of answering 304.
//   pnpm build && pnpm confirm-removals <feedId>
import pg from "pg";
import { z } from "zod";

export async function confirmRemovals(pool: pg.Pool, feedId: string): Promise<string[]> {
  const r = await pool.query(
    `UPDATE ical_sync.feed_state SET approved_removals = held_removals, etag = NULL, last_modified = NULL, next_attempt_at = LEAST(next_attempt_at, now())
      WHERE feed_id = $1 AND cardinality(held_removals) > 0 RETURNING held_removals`,
    [feedId],
  );
  if (r.rowCount) return r.rows[0].held_removals as string[];
  const known = await pool.query("SELECT 1 FROM ical_sync.feed_state WHERE feed_id = $1", [feedId]);
  throw new Error(known.rowCount ? `nothing held for feed ${feedId}` : `unknown feed ${feedId}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = z.object({ DATABASE_URL: z.string().min(1) }).parse(process.env);
  const feedId = z.string().min(1).parse(process.argv[2]);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  confirmRemovals(pool, feedId)
    .then((refs) => console.log(`approved ${refs.length} held removals for ${feedId}; applied on the next poll`))
    .catch((e) => {
      console.error((e as Error).message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
