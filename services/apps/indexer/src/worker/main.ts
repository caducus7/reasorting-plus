// C6 worker: head tracker, booking milestones, calendar sync and invariant monitors. Runs beside
// `ponder start`; reads Ponder's tables through the views schema (docs/adr/0014).
//   node --experimental-strip-types src/worker/main.ts   (env: see .env.example)
import { readFileSync } from "node:fs";
import pg from "pg";
import { createPublicClient, http, type PublicClient } from "viem";
import { Env, loadZones } from "./config.js";
import { pruneHeadEvents, readHeads, recordHeads } from "./heads.js";
import { updateMilestones } from "./milestones.js";
import { syncCalendar } from "./calendar.js";
import { runMonitors } from "./monitors.js";
import { AlertOutbox, LogNotifier, type Notifier } from "./notifier.js";
import { readSnapshot } from "./projection.js";
import { lag } from "../core/invariants.js";

export async function migrate(pool: pg.Pool) {
  await pool.query(readFileSync(new URL("../../migrations/001_ops.sql", import.meta.url), "utf8"));
}

export type Worker = { tick: (opts?: { monitors?: boolean }) => Promise<void>; outbox: AlertOutbox };

export function createWorker(env: Env, pool: pg.Pool, client: PublicClient, adapters: Notifier[]): Worker {
  const zones = loadZones(env.PROPERTIES_FILE);
  const outbox = new AlertOutbox(pool, env.CHAIN_ID, adapters);
  let lastPrune = 0;
  return {
    outbox,
    async tick(opts = {}) {
      const heads = await readHeads(client);
      await outbox.sync("DEEP_REORG:head", await recordHeads(pool, client, env.CHAIN_ID, heads), { autoResolve: false });
      const snap = await readSnapshot(pool, env.PONDER_SCHEMA);
      const l = lag(snap.block, heads.latest.number, BigInt(env.MAX_LAG_BLOCKS));
      await outbox.sync("LAG", l ? [l] : []);
      const m = await updateMilestones(pool, client, env.CHAIN_ID, heads, snap, env.RECEIVED_CONFIRMATIONS);
      await outbox.sync("DEEP_REORG:booking", m.breaches, { autoResolve: false });
      const cal = await syncCalendar(pool, env.CHAIN_ID, snap, heads, zones);
      await outbox.sync("CALENDAR", cal.breaches);
      if (opts.monitors) await runMonitors(pool, client, snap, zones, outbox);
      if (Date.now() - lastPrune > 3_600_000) {
        await pruneHeadEvents(pool, 7);
        lastPrune = Date.now();
      }
    },
  };
}

async function main() {
  const env = Env.parse(process.env);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  await migrate(pool);
  const client = createPublicClient({ transport: http(env.RPC_URL), cacheTime: 0 }) as PublicClient;
  const w = createWorker(env, pool, client, [new LogNotifier()]);
  let lastMonitor = 0;
  for (;;) {
    const now = Date.now();
    const monitors = now - lastMonitor >= env.MONITOR_EVERY_MS;
    try {
      await w.tick({ monitors });
      if (monitors) lastMonitor = now;
    } catch (e) {
      console.error("worker tick failed", e);
    }
    await new Promise((r) => setTimeout(r, env.POLL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
