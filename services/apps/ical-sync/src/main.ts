// C7 service: polls channel feeds (every POLL_INTERVAL_SEC, per-feed back-off) and serves the export
// feeds. Needs the C6 indexer (projection views, head milestones) in the same database.
//   pnpm build && pnpm start   (env: see .env.example)
import { serve } from "@hono/node-server";
import pg from "pg";
import { LogNotifier } from "@chain/indexer/alerts";
import { Env, loadFeeds, loadProperties } from "./config.js";
import { migrate } from "./db.js";
import { createExportApp } from "./export.js";
import { createSync } from "./importer.js";
import { escrowedSource, exportableSource } from "./sources.js";

async function main() {
  const env = Env.parse(process.env);
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  await migrate(pool);
  const feeds = loadFeeds(env.FEEDS_FILE);
  const { zones, names } = loadProperties(env.PROPERTIES_FILE);
  const sync = createSync({
    pool,
    chainId: env.CHAIN_ID,
    feeds,
    zones,
    escrowed: escrowedSource(pool, env.PONDER_SCHEMA),
    notifiers: [new LogNotifier()],
    fetchOptions: env.ALLOW_LOCAL_FEEDS === "1" ? { requireHttps: false, allowAddress: (ip) => ip === "127.0.0.1" || ip === "::1" } : {},
    pollIntervalSec: env.POLL_INTERVAL_SEC,
    maxBackoffSec: env.MAX_BACKOFF_SEC,
    staleAlertSec: env.STALE_ALERT_SEC,
  });
  await sync.syncConfig();

  const pairs = [...new Map(feeds.map((f) => [`${f.resourceId}:${f.channel}`, { resourceId: f.resourceId, channel: f.channel }])).values()];
  const app = createExportApp({ secret: env.EXPORT_TOKEN_SECRET, pairs, zones, names, exportable: exportableSource(pool, env.PONDER_SCHEMA, env.CHAIN_ID) });
  serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST });
  // Export URLs are bearer secrets for the channels: never logged (OWASP Logging Cheat Sheet; review
  // 0005 R5). The owner prints them on demand with `pnpm export-urls`.
  console.log(`ical-sync: ${feeds.length} feeds, ${pairs.length} export feeds (pnpm export-urls prints their URLs)`);

  for (;;) {
    try {
      await sync.pollDue();
      await sync.checkStaleness();
    } catch (e) {
      console.error("ical-sync tick failed", e);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
