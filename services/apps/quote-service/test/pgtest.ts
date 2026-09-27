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
      // pg-pool's end() resolves once its client list is empty, before the sockets have closed, so
      // backends can outlive it briefly. DROP ... WITH (FORCE) would kill them and the closing client
      // raises an uncaught 57P01. A plain DROP refuses (55006) while any connection remains, so retry
      // it until they are gone; FORCE only as a last resort.
      await db.end();
      const a = new pg.Client({ connectionString: TEST_PG_URL });
      await a.connect();
      try {
        for (let i = 0; ; i++) {
          try {
            await a.query(`DROP DATABASE IF EXISTS ${name}`);
            return;
          } catch (e) {
            if ((e as { code?: string }).code !== "55006") throw e;
            if (i >= 50) {
              await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
              return;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
        }
      } finally {
        await a.end();
      }
    },
  };
}
