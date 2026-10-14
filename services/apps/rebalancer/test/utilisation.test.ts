// Utilisation monitor (spec 6.7: monitoring and alerting only, never a gate).
import { describe, expect, it } from "vitest";
import { utilisationAction, utilisationBps, utilisationMonitor, type Utilisation } from "../src/utilisation.js";

describe("utilisationBps", () => {
  it("Aave's definition, rounded down", () => {
    // Live Base USDC reading, 2026-10-14: debt 164,832,710.754324, available 18,375,470.867709.
    expect(utilisationBps(164_832_710_754_324n, 18_375_470_867_709n)).toBe(8_997n);
    expect(utilisationBps(0n, 0n)).toBe(0n);
    expect(utilisationBps(1n, 0n)).toBe(10_000n);
  });
});

describe("utilisationAction (hysteresis around the kink)", () => {
  const at = (utilBps: bigint, optimalBps = 9_000n) => utilisationAction({ utilBps, optimalBps });
  it.each([
    [8_999n, "resolve"],
    [9_000n, "resolve"],
    [9_001n, "keep"],
    [9_499n, "keep"],
    [9_500n, "raise"],
    [10_000n, "raise"],
  ])("%s bps at a 90%% kink -> %s", (u, want) => expect(at(u)).toBe(want));
  it("follows the on-chain kink", () => {
    expect(at(9_000n, 8_000n)).toBe("raise"); // 80% kink -> raise at 90%
    expect(at(8_999n, 8_000n)).toBe("keep");
  });
});

describe("utilisationMonitor", () => {
  const reading = (utilBps: bigint): Utilisation => ({ debt: utilBps, available: 10_000n - utilBps, utilBps, optimalBps: 9_000n, blockNumber: 1n });
  function harness() {
    const opened: string[] = [];
    const resolved: string[] = [];
    const lines: string[] = [];
    let next: Utilisation | Error = reading(8_000n);
    const check = utilisationMonitor(
      async () => {
        if (next instanceof Error) throw next;
        return next;
      },
      { open: async (b) => (opened.push(...b.map((x) => x.key)), []), resolve: async (k) => void resolved.push(...k) },
      { market: "aave-v3-base-usdc", log: (l) => lines.push(l) },
    );
    return { opened, resolved, lines, check, set: (n: Utilisation | Error) => (next = n) };
  }

  it("raises above the threshold, keeps it in the band, resolves at the kink; logs every reading", async () => {
    const h = harness();
    h.set(reading(9_600n));
    expect(await h.check()).toBe("raise");
    h.set(reading(9_200n));
    expect(await h.check()).toBe("keep");
    h.set(reading(8_900n));
    expect(await h.check()).toBe("resolve");
    expect(h.opened).toEqual(["UTILISATION:aave-v3-base-usdc"]);
    expect(h.resolved).toEqual(["UTILISATION:aave-v3-base-usdc"]);
    expect(h.lines).toHaveLength(3);
    expect(JSON.parse(h.lines[0]!)).toMatchObject({ utilisation: "9600", optimal: "9000", action: "raise" });
  });

  it("a failed read is logged and changes no alert", async () => {
    const h = harness();
    h.set(new Error("rpc down"));
    expect(await h.check()).toBe("read_failed");
    expect(h.opened).toEqual([]);
    expect(h.resolved).toEqual([]);
    expect(h.lines[0]).toContain("read_failed");
  });
});

// Live read (skipped without BASE_RPC_URL): BASE_RPC_URL=https://mainnet.base.org pnpm vitest run test/utilisation.test.ts
import { createPublicClient, http, type PublicClient } from "viem";
import { aaveUtilisation } from "../src/utilisation.js";
describe.skipIf(!process.env.BASE_RPC_URL)("Aave V3 Base USDC utilisation (live)", () => {
  it("reads debt, available liquidity and the strategy's kink", async () => {
    const client = createPublicClient({ transport: http(process.env.BASE_RPC_URL) }) as PublicClient;
    // aave-address-book AaveV3Base.POOL and AaveV3BaseAssets.USDC_UNDERLYING.
    const u = await aaveUtilisation(client, "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")();
    console.log(`live utilisation ${u.utilBps} bps, kink ${u.optimalBps} bps, available ${u.available}`);
    expect(u.optimalBps).toBeGreaterThan(5_000n);
    expect(u.optimalBps).toBeLessThanOrEqual(10_000n);
    expect(u.utilBps).toBeLessThanOrEqual(10_000n);
    expect(u.available).toBeGreaterThan(0n);
  }, 30_000);
});
