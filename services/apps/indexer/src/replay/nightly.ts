// Nightly replay (spec 10.3) and the deep-reorg recovery build (docs/adr/0014 gap 2): a fresh
// `ponder start` into a new schema, then a diff against production. Clean: drop the replay schema.
// Different: page and keep it for forensics.
//   node --experimental-strip-types src/replay/nightly.ts   (env as the worker, plus FACTORY_ADDRESS)
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { RESPONSE } from "../core/invariants.js";
import { AlertOutbox, LogNotifier, type Notifier } from "../worker/notifier.js";
import { checkpoint, clean, diffSchemas, type DiffResult } from "./diff.js";

const APP = fileURLToPath(new URL("../..", import.meta.url));

export type ReplayOpts = {
  pool: pg.Pool;
  env: Record<string, string>; // DATABASE_URL, CHAIN_ID, RPC_URL, FACTORY_ADDRESS, ...
  prodSchema: string; // Ponder's live schema (not the views schema)
  replaySchema?: string;
  timeoutMs?: number;
  outbox?: AlertOutbox;
  /** Keep the replay schema even when clean (tests). */
  keepSchema?: boolean;
};

export async function runReplay(o: ReplayOpts): Promise<{ schema: string; upTo: bigint; results: DiffResult[]; clean: boolean }> {
  const schema = o.replaySchema ?? `replay_${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const target = await checkpoint(o.pool, o.prodSchema);
  const port = String(44_000 + Math.floor(Math.random() * 2_000));
  const proc = spawn("npx", ["ponder", "start", "--schema", schema, "--port", port], {
    cwd: APP,
    env: { ...process.env, ...o.env },
    stdio: "ignore",
    detached: true,
  });
  try {
    const t0 = Date.now();
    for (;;) {
      const cp = await checkpoint(o.pool, schema).catch(() => -1n);
      if (cp >= target) break;
      if (Date.now() - t0 > (o.timeoutMs ?? 3_600_000)) throw new Error(`replay did not reach block ${target}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    try {
      process.kill(-proc.pid!, "SIGKILL");
    } catch {}
  }
  const [a, b] = [await checkpoint(o.pool, o.prodSchema), await checkpoint(o.pool, schema)];
  const upTo = a < b ? a : b;
  const results = await diffSchemas(o.pool, o.prodSchema, schema, upTo);
  const ok = clean(results);
  if (ok && !o.keepSchema) {
    await o.pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await o.outbox?.sync(
    "REPLAY",
    ok
      ? []
      : [
          {
            invariant: "REPLAY",
            severity: "page",
            key: `REPLAY:${schema}`,
            message: `replay ${schema} differs from ${o.prodSchema} up to block ${upTo}`,
            details: Object.fromEntries(results.filter((r) => r.onlyInA || r.onlyInB).map((r) => [r.check, `${r.onlyInA}/${r.onlyInB}`])),
            response: RESPONSE.RECONCILE!,
          },
        ],
    { autoResolve: false },
  );
  return { schema, upTo, results, clean: ok };
}

async function main() {
  const env = process.env as Record<string, string>;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
  const adapters: Notifier[] = [new LogNotifier()];
  const outbox = new AlertOutbox(pool, Number(env.CHAIN_ID), adapters);
  const r = await runReplay({ pool, env, prodSchema: env.PONDER_LIVE_SCHEMA ?? "live", outbox });
  console.log(JSON.stringify({ schema: r.schema, upTo: r.upTo.toString(), clean: r.clean, results: r.results }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  await pool.end();
  process.exit(r.clean ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
