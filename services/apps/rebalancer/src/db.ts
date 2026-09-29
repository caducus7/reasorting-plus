import { readFileSync } from "node:fs";
import type pg from "pg";

export async function migrate(pool: pg.Pool) {
  await pool.query(readFileSync(new URL("../migrations/001_rebalancer.sql", import.meta.url), "utf8"));
}
