import { describe, expect, it } from "vitest";
import { decodeFunctionData } from "viem";
import { v1 } from "@chain/shared";
import { createApp } from "../src/app.js";
import { ESCROW_ABI } from "../src/chain.js";
import { SCENARIOS } from "../src/scenario.js";
import { AUTH, BOOKING_ID, STAY, call, makeApp, offerBody, offerThenPrepare } from "./helpers.js";

const booking = (app: ReturnType<typeof makeApp>["app"], scenario: string) =>
  call(app, `/v1/bookings/${BOOKING_ID}`, { headers: AUTH, scenario });

describe("x-stub-scenario", () => {
  it("covers every scenario named in the brief", () => {
    expect([...SCENARIOS].sort()).toEqual(
      ["cancelled", "error", "settled", "slow", "terms_changed", "unavailable", "yield_zero"].sort(),
    );
  });

  it("unavailable: prepare returns 409 unavailable", async () => {
    const { app } = makeApp();
    const { prep } = await offerThenPrepare(app, "unavailable");
    expect(prep.status).toBe(409);
    expect(v1.PrepareConflict.parse(prep.body)).toEqual({ error: "unavailable" });
  });

  it("terms_changed: prepare returns 409 terms_changed", async () => {
    const { app } = makeApp();
    const { prep } = await offerThenPrepare(app, "terms_changed");
    expect(prep.status).toBe(409);
    expect(v1.PrepareConflict.parse(prep.body)).toEqual({ error: "terms_changed" });
  });

  it("slow: waits 2s, then answers normally", async () => {
    const { app, delay } = makeApp();
    const r = await call(app, `/v1/availability?checkIn=${STAY.checkIn}&checkOut=${STAY.checkOut}&guests=2`, { scenario: "slow" });
    expect(delay).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(r.status).toBe(200);
  });

  it("slow: real latency with the default delay", async () => {
    const app = createApp({ now: () => new Date("2026-09-26T12:00:00Z") });
    const t0 = performance.now();
    const res = await app.request("/v1/yield/terms?bookingId=" + BOOKING_ID, { headers: { "x-stub-scenario": "slow" } });
    expect(res.status).toBe(200);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(1_990);
  }, 5_000);

  it("error: every endpoint returns 500", async () => {
    const { app } = makeApp();
    const offer = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    const requests: [string, Parameters<typeof call>[2]][] = [
      [`/v1/availability?checkIn=${STAY.checkIn}&checkOut=${STAY.checkOut}&guests=2`, {}],
      ["/v1/offers", { method: "POST", body: offerBody() }],
      [`/v1/offers/${offer.body.offerId}/prepare`, { method: "POST", body: { guestAddress: `0x${"11".repeat(20)}`, email: "a@example.com" } }],
      [`/v1/bookings/${BOOKING_ID}`, { headers: AUTH }],
      [`/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH }],
      [`/v1/yield/terms?bookingId=${BOOKING_ID}`, {}],
    ];
    for (const [path, r] of requests) {
      const res = await call(app, path, { ...r, scenario: "error" });
      expect([path, res.status, res.body]).toEqual([path, 500, { error: "internal_error" }]);
    }
  });

  it("cancelled: SETTLED by guest cancellation, refund claimable, yield forfeited", async () => {
    const { app } = makeApp();
    const r = await booking(app, "cancelled");
    const b = v1.BookingResponse.parse(r.body);
    expect(b).toMatchObject({
      state: "SETTLED",
      outcome: "CANCELLED_BY_GUEST",
      refundIfCancelledNowAtomic: "0",
      accruedYieldAtomic: "0",
      claimableAtomic: "2800000000",
    });
    expect(b.claimCalls.map((c) => decodeFunctionData({ abi: ESCROW_ABI, data: c.data as `0x${string}` }).functionName)).toEqual(["claim"]);
    const preview = await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH, scenario: "cancelled" });
    expect([preview.status, preview.body]).toEqual([409, { error: "not_cancellable" }]);
  });

  it("settled: SETTLED after a completed stay, vested yield claimable", async () => {
    const { app } = makeApp();
    const b = v1.BookingResponse.parse((await booking(app, "settled")).body);
    expect(b).toMatchObject({
      state: "SETTLED",
      outcome: "COMPLETED",
      accruedYieldAtomic: "11870000",
      claimableAtomic: "11870000",
    });
    expect(b.claimCalls).toHaveLength(1);
    const preview = await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH, scenario: "settled" });
    expect(preview.status).toBe(409);
  });

  it("yield_zero: no yield accrued, forfeited or claimable", async () => {
    const { app } = makeApp();
    expect((await booking(app, "yield_zero")).body.accruedYieldAtomic).toBe("0");
    const settled = v1.BookingResponse.parse((await booking(app, "settled,yield_zero")).body);
    expect(settled).toMatchObject({ accruedYieldAtomic: "0", claimableAtomic: "0", claimCalls: [] });
    const preview = await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH, scenario: "yield_zero" });
    expect(preview.body.guestYieldForfeitedAtomic).toBe("0");
  });

  it("combines comma-separated scenarios", async () => {
    const { app, delay } = makeApp();
    const r = await booking(app, "slow, cancelled");
    expect(delay).toHaveBeenCalledWith(2_000);
    expect(r.body.outcome).toBe("CANCELLED_BY_GUEST");
  });

  it.each(["nope", "cancelled,settled", "unavailable,terms_changed"])("400 invalid_scenario for %j", async (s) => {
    const { app } = makeApp();
    const r = await booking(app, s);
    expect([r.status, r.body]).toEqual([400, { error: "invalid_scenario" }]);
  });

  it("an empty header is the default scenario", async () => {
    const { app } = makeApp();
    expect((await booking(app, "")).body.state).toBe("ESCROWED");
  });
});
