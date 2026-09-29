import { readFileSync } from "node:fs";
import type pg from "pg";
import { migrate as migrateIndexerOps } from "@chain/indexer/ops";

/** The alert outbox (indexer_ops.alerts) first: the rebalancer pages through it. */
export async function migrate(pool: pg.Pool) {
  await migrateIndexerOps(pool);
  await pool.query(readFileSync(new URL("../migrations/001_rebalancer.sql", import.meta.url), "utf8"));
}
