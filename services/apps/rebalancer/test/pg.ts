// Throwaway Postgres databases (same pattern as the quote service and indexer tests).
import { randomBytes } from "node:crypto";
import pg from "pg";

export const TEST_PG_URL = process.env.TEST_PG_URL ?? "postgres://chain:chain@127.0.0.1:5432/postgres";

export async function freshDb() {
  const name = `reb_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = TEST_PG_URL.replace(/\/[^/]*$/, `/${name}`);
  const pool = new pg.Pool({ connectionString: url });
  return {
    url,
    pool,
    drop: async () => {
      await pool.end();
      const a = new pg.Client({ connectionString: TEST_PG_URL });
      await a.connect();
      try {
        for (let i = 0; i < 100; i++) {
          try {
            await a.query(`DROP DATABASE IF EXISTS ${name}`);
            return;
          } catch (e) {
            if ((e as { code?: string }).code !== "55006") throw e;
            await new Promise((r) => setTimeout(r, 100));
          }
        }
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
