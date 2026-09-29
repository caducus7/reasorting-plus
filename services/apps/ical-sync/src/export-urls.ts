// Prints the export URL for every configured (resource, channel), for the owner to paste into each
// channel (runbook: Channel sync). On demand only, never at service start (review 0005 R5).
//   pnpm build && pnpm export-urls
import { z } from "zod";
import { loadFeeds } from "./config.js";
import { exportToken } from "./export.js";

export function exportUrls(baseUrl: string, secret: string, feeds: { resourceId: string; channel: string }[]) {
  const pairs = [...new Map(feeds.map((f) => [`${f.resourceId.toLowerCase()}:${f.channel}`, f])).values()];
  return pairs.map((p) => ({ resourceId: p.resourceId.toLowerCase(), channel: p.channel, url: `${baseUrl.replace(/\/$/, "")}/ical/${exportToken(secret, p.resourceId, p.channel)}.ics` }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = z.object({ FEEDS_FILE: z.string(), EXPORT_TOKEN_SECRET: z.string().min(43), PUBLIC_BASE_URL: z.url() }).parse(process.env);
  for (const u of exportUrls(env.PUBLIC_BASE_URL, env.EXPORT_TOKEN_SECRET, loadFeeds(env.FEEDS_FILE))) console.log(`${u.channel}\t${u.resourceId}\t${u.url}`);
}
