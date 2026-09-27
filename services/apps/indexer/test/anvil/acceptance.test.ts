// Brief C6 acceptance on Anvil (the Base Sepolia run needs the owner's testnet wallet; see the
// handoff): a mixed history of 65 bookings, then
//   - the projection reconciles with the contract and no invariant alerts,
//   - the read API agrees with the contract's own views for every booking,
//   - a full replay into a separate schema diffs clean, and a tampered replay does not,
//   - read API latency p95 < 100 ms locally.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address, Hex, PublicClient } from "viem";
import { escrowAbi } from "@chain/abi";
import { createWorker, migrate, type Worker } from "../../src/worker/main.js";
import type { Alert, Notifier } from "../../src/worker/notifier.js";
import { diffSchemas, clean } from "../../src/replay/diff.js";
import { runReplay } from "../../src/replay/nightly.js";
import { freshDb, propertiesFile, startAnvil, startPonder, type Anvil, type Ponder } from "./harness.js";
import { runScenario } from "./scenario.js";

const GENESIS = Date.parse("2026-06-01T09:00:00Z") / 1000;
const STATES = ["NONE", "ESCROWED", "DELIVERED", "FROZEN", "DISPUTED", "SETTLED"];

let a: Anvil;
let db: Awaited<ReturnType<typeof freshDb>>;
let ponder: Ponder;
let worker: Worker;
let scenario: Awaited<ReturnType<typeof runScenario>>;
const alerts: Alert[] = [];
const capture: Notifier = { notify: async (x) => void alerts.push(x) };

beforeAll(async () => {
  db = await freshDb();
  a = await startAnvil(GENESIS);
  await migrate(db.pool);
  ponder = await startPonder({ dbUrl: db.url, rpcUrl: a.url, factory: a.dep.factory, schema: "live", viewsSchema: "indexer" });
  worker = createWorker(
    { DATABASE_URL: db.url, RPC_URL: a.url, CHAIN_ID: 31337, PONDER_SCHEMA: "indexer", PROPERTIES_FILE: propertiesFile(), POLL_MS: 200, MONITOR_EVERY_MS: 1_000, RECEIVED_CONFIRMATIONS: 2, MAX_LAG_BLOCKS: 60 },
    db.pool,
    a.client as PublicClient,
    [capture],
  );
  scenario = await runScenario(a);
  await ponder.indexed(await a.client.getBlockNumber());
  await worker.tick({ monitors: true });
}, 600_000);

afterAll(async () => {
  ponder?.stop();
  a?.stop();
  await db?.drop();
});

const read = <T>(fn: string, args: unknown[] = []) =>
  a.client.readContract({ address: a.dep.escrow, abi: escrowAbi, functionName: fn as never, args: args as never }) as Promise<T>;
const get = async (path: string) => {
  const r = await fetch(`${ponder.base}${path}`);
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("C6 acceptance on Anvil", () => {
  it("covers a mixed history of at least 50 bookings", () => {
    const c = scenario.counts;
    console.log("scenario", JSON.stringify(c));
    expect(c.bookings).toBeGreaterThanOrEqual(50);
    expect(c.guestCancels).toBeGreaterThan(0);
    expect(c.propertyCancels).toBeGreaterThan(0);
    expect(c.disputes).toBeGreaterThan(0);
    expect(c.resolved + c.defaulted).toBe(c.disputes);
    expect(c.settled).toBeGreaterThan(0);
  });

  it("reconciles with the contract and raises no alert", async () => {
    expect(alerts).toEqual([]);
    const outcomes = (await db.pool.query("SELECT outcome, count(*)::int AS n FROM indexer.booking GROUP BY outcome ORDER BY outcome")).rows;
    console.log("outcomes", JSON.stringify(outcomes));
    expect((await db.pool.query("SELECT count(*)::int AS n FROM indexer.booking")).rows[0].n).toBe(scenario.counts.bookings);
    // Escrow rows in the shared calendar: exactly the non-cancelled bookings (cancellations are safe here? Anvil safe = latest - 32).
    const cal = (await db.pool.query("SELECT count(*)::int AS n FROM calendar_blocks WHERE source = 'escrow'")).rows[0].n;
    const expected = (await db.pool.query("SELECT count(*)::int AS n FROM indexer.booking WHERE coalesce(outcome, '') NOT IN ('CANCELLED_BY_GUEST', 'CANCELLED_BY_PROPERTY')")).rows[0].n;
    expect(cal).toBe(expected);
  });

  it("read API agrees with the contract's own views for every booking", async () => {
    for (const b of scenario.all) {
      const { status, body } = await get(`/v1/indexer/bookings/${a.dep.escrow}/${b.bookingId}`);
      expect(status).toBe(200);
      expect(body.state).toBe(STATES[await read<number>("bookingState", [b.bookingId])]);
      expect(body.claimableAtomic).toBe((await read<bigint>("claimableOf", [b.guest])).toString());
      if (body.state === "ESCROWED") {
        expect(body.refundBps).toBe(Number(await read<number>("refundBpsNow", [b.bookingId])));
      }
    }
    const s = await get(`/v1/indexer/escrows/${a.dep.escrow}/summary`);
    const L = s.body.ledger as Record<string, string>;
    for (const f of ["totalOpenPrincipal", "totalClaimable", "totalPendingYield", "reserve", "lastAssets", "yieldUnallocated", "accYieldPerUnit"]) {
      expect(L[f], f).toBe((await read<bigint>(f)).toString());
    }
    expect(s.body.effectiveFeeBps).toBe(Number(await read<number>("effectiveFeeBps")));
    const fin = await get(`/v1/indexer/escrows/${a.dep.escrow}/summary?head=finalized`);
    expect(fin.status).toBe(200);
    expect(BigInt(fin.body.asOf ? (fin.body.asOf as { block: string }).block : 0)).toBeLessThan(await a.client.getBlockNumber());
  });

  it("read API latency p95 < 100 ms", async () => {
    const paths = scenario.all.map((b) => `/v1/indexer/bookings/${a.dep.escrow}/${b.bookingId}`);
    paths.push(`/v1/indexer/escrows/${a.dep.escrow}/summary`);
    const ms: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      const t = performance.now();
      const r = await fetch(`${ponder.base}${paths[i % paths.length]}`);
      await r.arrayBuffer();
      ms.push(performance.now() - t);
    }
    ms.sort((x, y) => x - y);
    const p95 = ms[Math.floor(ms.length * 0.95)]!;
    console.log(`read API latency: p50 ${ms[500]!.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${ms[ms.length - 1]!.toFixed(1)} ms`);
    expect(p95).toBeLessThan(100);
  });

  it("a full replay into a separate schema diffs clean; a tampered one does not", async () => {
    const env = { DATABASE_URL: db.url, CHAIN_ID: "31337", RPC_URL: a.url, FACTORY_ADDRESS: a.dep.factory as Address, FACTORY_START_BLOCK: "0", POLLING_INTERVAL_MS: "200" };
    const r = await runReplay({ pool: db.pool, env, prodSchema: "live", replaySchema: "replay_test", keepSchema: true, timeoutMs: 120_000 });
    console.log("replay", JSON.stringify(r.results.map((x) => [x.check, x.onlyInA, x.onlyInB])), "upTo", r.upTo.toString());
    expect(r.clean).toBe(true);
    expect(r.upTo).toBeGreaterThanOrEqual(await a.client.getBlockNumber());
    const rows = (await db.pool.query("SELECT count(*)::int AS n FROM replay_test.journal")).rows[0].n;
    expect(rows).toBeGreaterThan(300);

    // Ponder's live-query trigger needs its own session state; tamper with user triggers off.
    await db.pool.query("ALTER TABLE replay_test.journal DISABLE TRIGGER USER");
    await db.pool.query("UPDATE replay_test.journal SET amount = amount + 1 WHERE id = (SELECT id FROM replay_test.journal ORDER BY id LIMIT 1)");
    const tampered = await diffSchemas(db.pool, "live", "replay_test", r.upTo);
    expect(clean(tampered)).toBe(false);
    expect(tampered.find((x) => x.check === "journal")!.onlyInA).toBe(1);
    expect(tampered.find((x) => x.check.startsWith("balance_vs_journal") && x.check.includes("replay_test"))!.onlyInA).toBeGreaterThan(0);
  }, 300_000);
});

export type { Hex };
