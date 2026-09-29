import { readFileSync } from "node:fs";
import type pg from "pg";
import { migrate as migrateIndexerOps } from "@chain/indexer/ops";

/** Shared tables (calendar_blocks, channel_feeds, indexer_ops.alerts) first, then C7's own. */
export async function migrate(pool: pg.Pool) {
  await migrateIndexerOps(pool);
  for (const f of ["001_ical.sql", "002_mass_removal.sql"]) await pool.query(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
}
