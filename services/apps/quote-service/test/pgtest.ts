// Throwaway Postgres databases for tests. Needs a server reachable at TEST_PG_URL (default: the local
// `chain` role on 127.0.0.1:5432, which has CREATEDB). Each call creates a fresh, migrated database.

import { randomBytes } from "node:crypto";
import pg from "pg";
import { connect, migrate, type Db } from "../src/db.js";

export const TEST_PG_URL = process.env.TEST_PG_URL ?? "postgres://chain:chain@127.0.0.1:5432/postgres";

export async function freshDb(): Promise<{ db: Db; url: string; drop: () => Promise<void> }> {
  const name = `qs_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: TEST_PG_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = TEST_PG_URL.replace(/\/[^/]*$/, `/${name}`);
  const db = connect(url);
  await migrate(db);
  return {
    db,
    url,
    drop: async () => {
      await db.end();
      const a = new pg.Client({ connectionString: TEST_PG_URL });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
