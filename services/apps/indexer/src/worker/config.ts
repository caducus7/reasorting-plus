import { readFileSync } from "node:fs";
import { z } from "zod";

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const Env = z.object({
  DATABASE_URL: z.string().min(1),
  RPC_URL: z.url(),
  CHAIN_ID: int(1, 2 ** 31),
  /** Schema holding Ponder's tables or its views (`ponder start --views-schema`). */
  PONDER_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("indexer"),
  PROPERTIES_FILE: z.string().min(1),
  POLL_MS: int(200, 60_000).default(2_000),
  MONITOR_EVERY_MS: int(1_000, 3_600_000).default(60_000),
  RECEIVED_CONFIRMATIONS: int(0, 64).default(2), // spec 10.2: unsafe + 2
  /** Page when the projection is this many blocks behind latest. Ponder stops indexing at once on an
   * unrecoverable reorg but only exits after up to 10 minutes of retries (sync-realtime
   * MAX_LATEST_BLOCK_ATTEMPT_MS), so a stall must be detected from outside. 60 blocks = 2 min on Base. */
  MAX_LAG_BLOCKS: int(1, 100_000).default(60),
});
export type Env = z.infer<typeof Env>;

/** Resource time zones from the same properties file the quote service reads (C5). */
const Property = z.object({ resourceId: z.string().regex(/^0x[0-9a-fA-F]{64}$/), tz: z.string().min(1) });

export function loadZones(file: string): Map<string, string> {
  const list = z.array(Property.loose()).parse(JSON.parse(readFileSync(file, "utf8")));
  return new Map(list.map((p) => [p.resourceId.toLowerCase(), p.tz]));
}
