// Live APY (brief C5): conversion matches Aave's per-second compounding, rounds down, caches, and
// falls back to the configured estimate without ever failing.
import { describe, expect, it } from "vitest";
import { aprRayToApyBps, marketApy } from "../src/apy.js";

const RAY = 10n ** 27n;

describe("aprRayToApyBps", () => {
  it("matches Aave's per-second compounding on the live Base USDC rate, rounded down", () => {
    // currentLiquidityRate read from Pool 0xA238...d1c5 on Base, 2026-10-14. Reference values
    // (60-digit decimal): per-second 387.7507 bps, continuous 387.7507 bps.
    expect(aprRayToApyBps(38_042_198_441_127_846_366_263_304n)).toBe(387);
  });
  it("edge values", () => {
    expect(aprRayToApyBps(0n)).toBe(0);
    expect(aprRayToApyBps(RAY / 100n)).toBe(100); // 1% APR -> 1.00501...% -> 100 bps
    expect(aprRayToApyBps(RAY / 10n)).toBe(1051); // 10% APR -> 10.517% APY
    expect(() => aprRayToApyBps(-1n)).toThrow();
    expect(() => aprRayToApyBps(6n * RAY)).toThrow();
  });
});

describe("marketApy", () => {
  it("caches for the TTL, refreshes after it, and reports the block time as asOf", async () => {
    let t = 1_800_000_000;
    let reads = 0;
    let rate = RAY / 25n; // 4% APR
    const apy = marketApy(async () => (reads++, { aprRay: rate, asOf: t - 2 }), { fallbackBps: 400, now: () => new Date(t * 1000) });
    expect(await apy()).toEqual({ bps: 408, asOf: t - 2, source: "market" });
    t += 299;
    rate = RAY / 50n;
    expect((await apy()).bps).toBe(408);
    expect(reads).toBe(1);
    t += 1;
    expect((await apy()).bps).toBe(202);
    expect(reads).toBe(2);
  });

  it("concurrent callers share one read", async () => {
    let reads = 0;
    const apy = marketApy(async () => (reads++, await new Promise((r) => setTimeout(r, 10)), { aprRay: RAY / 25n, asOf: 1 }), { fallbackBps: 400 });
    await Promise.all([apy(), apy(), apy()]);
    expect(reads).toBe(1);
  });

  it("a failed read keeps the last good rate up to maxAge, then falls back to config; never throws", async () => {
    let t = 1_800_000_000;
    let fail = false;
    const logs: string[] = [];
    const apy = marketApy(
      async () => {
        if (fail) throw new Error("rpc down");
        return { aprRay: RAY / 25n, asOf: t };
      },
      { fallbackBps: 350, ttlSec: 300, maxAgeSec: 3_600, now: () => new Date(t * 1000), log: (m) => logs.push(m) },
    );
    const first = await apy();
    fail = true;
    t += 3_599;
    expect(await apy()).toEqual(first);
    t += 1;
    expect(await apy()).toEqual({ bps: 350, asOf: t, source: "config" });
    expect(logs.length).toBeGreaterThan(0);
  });

  it("with no read ever succeeding, serves config", async () => {
    const apy = marketApy(async () => Promise.reject(new Error("x")), { fallbackBps: 400, now: () => new Date(5_000), log: () => {} });
    expect(await apy()).toEqual({ bps: 400, asOf: 5, source: "config" });
  });
});
