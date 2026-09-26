import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import { v1 } from "@chain/shared";
import { ESCROW_ABI, bookingIdOf } from "../src/chain.js";
import { PROPERTY, STUB_ESCROW, STUB_QUOTE_SIG, STUB_USDC } from "../src/fixtures.js";
import { AUTH, BOOKING_ID, GUEST, NOW, STAY, call, makeApp, offerBody, offerThenPrepare } from "./helpers.js";

describe("GET /v1/availability", () => {
  it("returns the villa with price in atomic USDC", async () => {
    const { app } = makeApp();
    const r = await call(app, `/v1/availability?checkIn=${STAY.checkIn}&checkOut=${STAY.checkOut}&guests=4`);
    expect(r.status).toBe(200);
    const items = v1.AvailabilityResponse.parse(r.body);
    expect(items).toEqual([
      {
        resourceId: PROPERTY.resourceId,
        name: "Stub Villa (Crete)",
        nights: 7,
        priceAtomic: "5600000000",
        policyId: "pol_stub_standard_v1",
      },
    ]);
  });

  it("returns nothing when the party exceeds capacity", async () => {
    const { app } = makeApp();
    const r = await call(app, `/v1/availability?checkIn=${STAY.checkIn}&checkOut=${STAY.checkOut}&guests=9`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it.each([
    ["missing params", "/v1/availability"],
    ["bad date", "/v1/availability?checkIn=2026-13-01&checkOut=2026-12-02&guests=2"],
    ["zero guests", `/v1/availability?checkIn=${STAY.checkIn}&checkOut=${STAY.checkOut}&guests=0`],
  ])("400 on %s", async (_n, path) => {
    const { app } = makeApp();
    const r = await call(app, path);
    expect(r.status).toBe(400);
    expect(v1.ErrorBody.parse(r.body).error).toBe("invalid_request");
  });

  it.each([
    ["check-out before check-in", "2026-12-02", "2026-11-25"],
    ["check-in in the past", "2026-09-01", "2026-09-05"],
    ["more than 60 nights", "2026-11-01", "2027-01-15"],
  ])("400 invalid_stay on %s", async (_n, checkIn, checkOut) => {
    const { app } = makeApp();
    const r = await call(app, `/v1/availability?checkIn=${checkIn}&checkOut=${checkOut}&guests=2`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_stay" });
  });
});

describe("POST /v1/offers", () => {
  it("returns an unsigned offer with a three-cutoff curve in Europe/Athens local time", async () => {
    const { app } = makeApp();
    const r = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    expect(r.status).toBe(200);
    const o = v1.OfferResponse.parse(r.body);
    expect(o.priceAtomic).toBe("5600000000");
    expect(o.tz).toBe("Europe/Athens");
    expect(o.checkInLocal).toBe("2026-11-25T15:00:00+02:00");
    expect(o.checkOutLocal).toBe("2026-12-02T11:00:00+02:00");
    expect(o.refundCurve).toEqual([
      { untilLocal: "2026-10-26T18:00:00+02:00", refundBps: 10_000 },
      { untilLocal: "2026-11-11T18:00:00+02:00", refundBps: 5_000 },
      { untilLocal: "2026-11-18T18:00:00+02:00", refundBps: 2_500 },
      { untilLocal: "2026-12-02T11:00:00+02:00", refundBps: 0 },
    ]);
    expect(o.expiresAt).toBe("2026-09-26T12:25:00Z"); // 25-minute lock
  });

  it("is deterministic: same input, same offer", async () => {
    const { app } = makeApp();
    const a = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    const b = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    expect(a.body).toEqual(b.body);
  });

  it("materialises cutoffs across the Europe/Athens DST change", async () => {
    // DST starts 2027-03-28 03:00 local. Cutoffs before it are +02:00, check-in after it is +03:00.
    const { app } = makeApp();
    const r = await call(app, "/v1/offers", {
      method: "POST",
      body: offerBody({ checkIn: "2027-04-01", checkOut: "2027-04-04" }),
    });
    const o = v1.OfferResponse.parse(r.body);
    expect(o.checkInLocal).toBe("2027-04-01T15:00:00+03:00");
    expect(o.refundCurve.map((p) => p.untilLocal)).toEqual([
      "2027-03-02T18:00:00+02:00",
      "2027-03-18T18:00:00+02:00",
      "2027-03-25T18:00:00+02:00",
      "2027-04-04T11:00:00+03:00",
    ]);
  });

  it("404 on an unknown resource, 400 on bad body or too many guests", async () => {
    const { app } = makeApp();
    const unknown = await call(app, "/v1/offers", { method: "POST", body: offerBody({ resourceId: `0x${"00".repeat(32)}` }) });
    expect([unknown.status, unknown.body]).toEqual([404, { error: "resource_not_found" }]);
    const extra = await call(app, "/v1/offers", { method: "POST", body: { ...offerBody(), feeBps: 0 } });
    expect([extra.status, extra.body]).toEqual([400, { error: "invalid_request" }]);
    const crowd = await call(app, "/v1/offers", { method: "POST", body: offerBody({ guests: 9 }) });
    expect([crowd.status, crowd.body]).toEqual([400, { error: "invalid_stay" }]);
  });
});

describe("POST /v1/offers/{offerId}/prepare", () => {
  it("returns a quote bound to the guest, its bookingId, and approve + deposit calls flagged stub", async () => {
    const { app } = makeApp();
    const { prep } = await offerThenPrepare(app);
    expect(prep.status).toBe(200);
    const p = v1.PrepareResponse.parse(prep.body);

    expect(p.quote.guest).toBe(GUEST);
    expect(p.quote.priceAtomic).toBe("5600000000");
    expect(p.quote.feeBps).toBe(PROPERTY.feeBps);
    expect(p.quote.guestYieldBps).toBe(5_000);
    expect(p.quote.cutoffs).toHaveLength(3);
    expect(p.quote.expiresAt).toBe(Math.floor(NOW.getTime() / 1000) + 15 * 60);
    expect(p.bookingId).toBe(bookingIdOf(p.quote));
    expect(p.quoteSig).toBe(STUB_QUOTE_SIG);

    expect(p.calls).toHaveLength(2);
    expect(p.calls.every((c) => c.stub === true && c.value === "0")).toBe(true);

    const [approve, deposit] = p.calls;
    expect(approve!.to).toBe(STUB_USDC);
    const a = decodeFunctionData({ abi: erc20Abi, data: approve!.data as `0x${string}` });
    expect(a.functionName).toBe("approve");
    expect(a.args).toEqual([STUB_ESCROW, 5_600_000_000n]);

    expect(deposit!.to).toBe(STUB_ESCROW);
    const d = decodeFunctionData({ abi: ESCROW_ABI, data: deposit!.data as `0x${string}` });
    expect(d.functionName).toBe("deposit");
    const [q, sig] = d.args as unknown as [Record<string, unknown>, string];
    expect(q.priceAtomic).toBe(5_600_000_000n);
    expect(q.guest).toBe(GUEST);
    expect(sig).toBe(STUB_QUOTE_SIG);
  });

  it("bookingId changes with the guest", async () => {
    const { app } = makeApp();
    const offer = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    const other = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const p1 = await call(app, `/v1/offers/${offer.body.offerId}/prepare`, { method: "POST", body: { guestAddress: GUEST, email: "a@example.com" } });
    const p2 = await call(app, `/v1/offers/${offer.body.offerId}/prepare`, { method: "POST", body: { guestAddress: other, email: "a@example.com" } });
    expect(p1.body.bookingId).not.toBe(p2.body.bookingId);
  });

  it("404 on an unknown offer, 400 on a bad address or email", async () => {
    const { app } = makeApp();
    const missing = await call(app, "/v1/offers/off_garbage/prepare", { method: "POST", body: { guestAddress: GUEST, email: "a@example.com" } });
    expect([missing.status, missing.body]).toEqual([404, { error: "offer_not_found" }]);
    const offer = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    for (const body of [{ guestAddress: "0x123", email: "a@example.com" }, { guestAddress: GUEST, email: "nope" }]) {
      const r = await call(app, `/v1/offers/${offer.body.offerId}/prepare`, { method: "POST", body });
      expect([r.status, r.body]).toEqual([400, { error: "invalid_request" }]);
    }
  });

  it("409 unavailable when arrival has passed since the offer", async () => {
    const { app: early } = makeApp();
    const offer = await call(early, "/v1/offers", { method: "POST", body: offerBody() });
    const { app: late } = makeApp(new Date("2026-11-26T00:00:00Z"));
    const r = await call(late, `/v1/offers/${offer.body.offerId}/prepare`, { method: "POST", body: { guestAddress: GUEST, email: "a@example.com" } });
    expect([r.status, r.body]).toEqual([409, { error: "unavailable" }]);
  });
});

describe("GET /v1/bookings/{bookingId}", () => {
  it("returns an escrowed booking with a full refund available", async () => {
    const { app } = makeApp();
    const r = await call(app, `/v1/bookings/${BOOKING_ID}`, { headers: AUTH });
    expect(r.status).toBe(200);
    const b = v1.BookingResponse.parse(r.body);
    expect(b).toMatchObject({
      state: "ESCROWED",
      outcome: null,
      checkInLocal: "2027-07-10T15:00:00+03:00",
      checkOutLocal: "2027-07-17T11:00:00+03:00",
      priceAtomic: "5600000000",
      refundIfCancelledNowAtomic: "5600000000",
      accruedYieldAtomic: "4210000",
      guestYieldBps: 5_000,
      claimableAtomic: "0",
      claimCalls: [],
      policyId: "pol_stub_standard_v1",
    });
    expect(b.refundCurve).toHaveLength(4);
  });

  it("refund follows the curve as time passes, rounding up", async () => {
    const cases: [string, string][] = [
      ["2027-06-20T12:00:00Z", "2800000000"], // 50% window
      ["2027-07-01T12:00:00Z", "1400000000"], // 25% window (Jun 26 to Jul 3 18:00 local)
      ["2027-07-05T12:00:00Z", "0"], // after the last cutoff: finalBps
      ["2027-07-12T12:00:00Z", "0"], // in stay: finalBps
    ];
    for (const [t, refund] of cases) {
      const { app } = makeApp(new Date(t));
      const r = await call(app, `/v1/bookings/${BOOKING_ID}`, { headers: AUTH });
      expect(r.body.refundIfCancelledNowAtomic).toBe(refund);
      expect(r.body.state).toBe("ESCROWED");
    }
  });

  it("is DELIVERED once check-out passes", async () => {
    const { app } = makeApp(new Date("2027-07-17T09:00:00Z")); // 12:00 local, after 11:00 check-out
    const r = await call(app, `/v1/bookings/${BOOKING_ID}`, { headers: AUTH });
    expect(r.body).toMatchObject({ state: "DELIVERED", refundIfCancelledNowAtomic: "0" });
  });

  it("401 without a token, 403 with another booking's token", async () => {
    const { app } = makeApp();
    const none = await call(app, `/v1/bookings/${BOOKING_ID}`);
    expect([none.status, none.body]).toEqual([401, { error: "unauthorized" }]);
    const bad = await call(app, `/v1/bookings/${BOOKING_ID}`, { headers: { authorization: "Bearer something-else" } });
    expect(bad.status).toBe(401);
    const other = await call(app, `/v1/bookings/0x${"cd".repeat(32)}`, { headers: AUTH });
    expect([other.status, other.body]).toEqual([403, { error: "forbidden" }]);
  });
});

describe("POST /v1/bookings/{bookingId}/cancel-preview", () => {
  it("returns the refund and cancelByGuest + claim calls", async () => {
    const { app } = makeApp();
    const r = await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH });
    expect(r.status).toBe(200);
    const c = v1.CancelPreviewResponse.parse(r.body);
    expect(c).toMatchObject({ refundAtomic: "5600000000", refundBps: 10_000, guestYieldForfeitedAtomic: "4210000" });
    const fns = c.calls.map((x) => decodeFunctionData({ abi: ESCROW_ABI, data: x.data as `0x${string}` }));
    expect(fns.map((f) => f.functionName)).toEqual(["cancelByGuest", "claim"]);
    expect(fns[0]!.args).toEqual([BOOKING_ID]);
    expect(c.calls.every((x) => x.stub === true && x.to === STUB_ESCROW)).toBe(true);
  });

  it("409 not_cancellable after check-out", async () => {
    const { app } = makeApp(new Date("2027-07-18T00:00:00Z"));
    const r = await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH });
    expect([r.status, r.body]).toEqual([409, { error: "not_cancellable" }]);
  });

  it("requires guest auth", async () => {
    const { app } = makeApp();
    const r = await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST" });
    expect(r.status).toBe(401);
  });
});

describe("GET /v1/yield/terms", () => {
  it("for an offer: estimate from spec 8's deployment window", async () => {
    const { app } = makeApp();
    const offer = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
    const r = await call(app, `/v1/yield/terms?offerId=${offer.body.offerId}`);
    expect(r.status).toBe(200);
    const t = v1.YieldTermsResponse.parse(r.body);
    expect(t).toMatchObject({
      guestYieldBps: 5_000,
      vestingRule: "completed_stay_no_refund",
      apyEstimateBps: 418,
      asOf: "2026-09-26T12:00:00Z",
    });
    // 5,600 USDC; check-in 2026-11-25 13:00Z, minus 14 days, minus now = 46 days + 1 hour;
    // 90% deployed at 4.18%, half to the guest, each step rounded down. About 13.29 USDC.
    const window = 46n * 86_400n + 3_600n;
    const gross = (5_600_000_000n * 418n * window * 9_000n) / (10_000n * 365n * 86_400n * 10_000n);
    expect(t.estimatedGuestYieldAtomic).toBe(((gross * 5_000n) / 10_000n).toString());
    expect(Number(t.estimatedGuestYieldAtomic) / 1e6).toBeCloseTo(13.29, 2);
  });

  it("for a booking", async () => {
    const { app } = makeApp();
    const r = await call(app, `/v1/yield/terms?bookingId=${BOOKING_ID}`);
    expect(r.status).toBe(200);
    v1.YieldTermsResponse.parse(r.body);
  });

  it.each([
    ["neither id", "/v1/yield/terms"],
    ["both ids", `/v1/yield/terms?offerId=off_x&bookingId=${BOOKING_ID}`],
  ])("400 with %s", async (_n, path) => {
    const { app } = makeApp();
    expect((await call(app, path)).status).toBe(400);
  });

  it("404 on an unknown offer", async () => {
    const { app } = makeApp();
    const r = await call(app, "/v1/yield/terms?offerId=off_nope");
    expect([r.status, r.body]).toEqual([404, { error: "offer_not_found" }]);
  });
});
