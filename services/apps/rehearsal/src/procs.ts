// Runs each service as its own process with its production entry point (`pnpm start`, or the
// indexer worker), logging to files in the run directory.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const APPS = fileURLToPath(new URL("../../", import.meta.url));

export type Proc = { name: string; log: () => string; exited: () => number | null; stop: () => void };

export function startProc(name: string, app: string, script: string, env: Record<string, string>, runDir: string): Proc {
  let buf = "";
  let code: number | null = null;
  const file = createWriteStream(join(runDir, `${name}.log`));
  const p: ChildProcess = spawn("pnpm", ["run", "--silent", script], {
    cwd: join(APPS, app),
    env: { ...process.env, ...env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const take = (d: Buffer) => {
    buf = (buf + d.toString()).slice(-200_000);
    file.write(d);
  };
  p.stdout!.on("data", take);
  p.stderr!.on("data", take);
  p.on("exit", (c) => (code = c ?? -1));
  return {
    name,
    log: () => buf,
    exited: () => code,
    stop: () => {
      try {
        process.kill(-p.pid!, "SIGTERM");
      } catch {}
    },
  };
}

/** Polls `cond` until true; fails with the named process logs on timeout or exit. */
export async function until(what: string, cond: () => Promise<boolean>, o: { ms?: number; procs?: Proc[] } = {}) {
  const t = Date.now();
  let last: unknown;
  for (;;) {
    for (const p of o.procs ?? []) if (p.exited() !== null) throw new Error(`${p.name} exited (${p.exited()}) while waiting for ${what}\n${p.log().slice(-4000)}`);
    try {
      if (await cond()) return;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t > (o.ms ?? 120_000)) throw new Error(`timeout waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}
