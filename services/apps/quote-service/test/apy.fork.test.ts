// Live read of the Aave Base USDC supply rate (skipped without BASE_RPC_URL):
//   BASE_RPC_URL=https://mainnet.base.org pnpm vitest run test/apy.fork.test.ts
import { createPublicClient, http, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { aaveSupplyRate, aprRayToApyBps } from "../src/apy.js";

const rpc = process.env.BASE_RPC_URL;
describe.skipIf(!rpc)("Aave V3 Base USDC supply rate (live)", () => {
  it("reads a plausible supply APY from Pool.getReserveData", async () => {
    const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
    // aave-address-book AaveV3Base.POOL and AaveV3BaseAssets.USDC_UNDERLYING.
    const r = await aaveSupplyRate(client, "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")();
    const bps = aprRayToApyBps(r.aprRay);
    console.log(`live Aave Base USDC supply APY: ${bps} bps at ${new Date(r.asOf * 1000).toISOString()}`);
    expect(bps).toBeGreaterThan(0);
    expect(bps).toBeLessThan(5_000);
    expect(Math.abs(r.asOf - Date.now() / 1000)).toBeLessThan(600);
  }, 30_000);
});
