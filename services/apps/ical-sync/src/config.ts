import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Feed } from "./importer.js";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const Env = z
  .object({
    DATABASE_URL: z.string().min(1),
    CHAIN_ID: int(1, 2 ** 31),
    PONDER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("indexer"),
    FEEDS_FILE: z.string().min(1),
    PROPERTIES_FILE: z.string().min(1),
    /** Signs export URLs and UIDs. >= 32 random bytes; from the secret store. Rotating it changes every URL. */
    EXPORT_TOKEN_SECRET: z.string().min(43),
    PUBLIC_BASE_URL: z.url(),
    PORT: int(1, 65_535).default(8090),
    HOST: z.string().default("0.0.0.0"),
    POLL_INTERVAL_SEC: int(60, 3_600).default(300), // spec 9: 5 minutes
    MAX_BACKOFF_SEC: int(60, 86_400).default(3_600),
    STALE_ALERT_SEC: int(60, 86_400).default(900), // = C5 FEED_MAX_AGE_SEC
    /** Anvil only: admit loopback feeds over http for local tests. */
    ALLOW_LOCAL_FEEDS: z.enum(["0", "1"]).default("0"),
  })
  .superRefine((e, ctx) => {
    if (e.ALLOW_LOCAL_FEEDS === "1" && e.CHAIN_ID !== 31_337) ctx.addIssue({ code: "custom", message: "ALLOW_LOCAL_FEEDS is Anvil-only (CHAIN_ID=31337)" });
  });
export type Env = z.infer<typeof Env>;

const FeedSchema = z.strictObject({
  feedId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).refine((s) => s !== "escrow", "feedId 'escrow' is reserved"),
  resourceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase()),
  channel: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  url: z.url(),
});

/** Channel feeds (secret: import URLs carry the channel's own token; keep the file out of git). */
export function loadFeeds(file: string): Feed[] {
  const feeds = z.array(FeedSchema).parse(JSON.parse(readFileSync(file, "utf8")));
  const ids = new Set<string>();
  for (const f of feeds) {
    if (ids.has(f.feedId)) throw new Error(`duplicate feedId ${f.feedId}`);
    ids.add(f.feedId);
  }
  return feeds;
}

const Property = z.object({ resourceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), tz: z.string().min(1), name: z.string().optional() }).loose();

export function loadProperties(file: string) {
  const list = z.array(Property).parse(JSON.parse(readFileSync(file, "utf8")));
  return {
    zones: new Map(list.map((p) => [p.resourceId.toLowerCase(), p.tz])),
    names: new Map(list.map((p) => [p.resourceId.toLowerCase(), p.name ?? "Calendar"])),
  };
}
