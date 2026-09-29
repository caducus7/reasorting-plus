// Review 0005 R8: head_events keeps 7 days; milestones and alerts are records and are kept.
import { afterAll, beforeAll, expect, it } from "vitest";
import { pruneHeadEvents } from "../../src/worker/heads.js";
import { migrate } from "../../src/worker/main.js";
import { freshDb } from "../anvil/harness.js";

let db: Awaited<ReturnType<typeof freshDb>>;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool);
});
afterAll(async () => db.drop());

it("prunes head events older than the retention window only", async () => {
  await db.pool.query(
    `INSERT INTO indexer_ops.head_events (chain_id, tag, number, hash, ts, created_at) VALUES
     (1, 'latest', 1, '0x1', 1, now() - interval '8 days'), (1, 'latest', 2, '0x2', 2, now() - interval '6 days'), (1, 'safe', 3, '0x3', 3, now())`,
  );
  expect(await pruneHeadEvents(db.pool, 7)).toBe(1);
  expect((await db.pool.query("SELECT number FROM indexer_ops.head_events ORDER BY number")).rows.map((r) => r.number)).toEqual(["2", "3"]);
});
