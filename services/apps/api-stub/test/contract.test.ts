// Cross-cutting acceptance: OpenAPI matches responses, money is strings, feeBps stays hidden,
// and the yield estimate reproduces spec 8.

import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { materialiseStay, estimateGuestYield } from "../src/stay.js";
import { AUTH, BOOKING_ID, STAY, call, findKeys, makeApp, offerBody, offerThenPrepare } from "./helpers.js";

type Doc = { paths: Record<string, Record<string, { responses: Record<string, any> }>> };

async function everyResponse() {
  const { app } = makeApp();
  const offer = await call(app, "/v1/offers", { method: "POST", body: offerBody() });
  const { prep } = await offerThenPrepare(app);
  const out: { path: string; method: string; status: number; body: unknown }[] = [
    { path: "/v1/availability", method: "get", ...(await call(app, `/v1/availability?checkIn=${STAY.checkIn}&checkOut=${STAY.checkOut}&guests=2`)) },
    { path: "/v1/offers", method: "post", ...offer },
    { path: "/v1/offers/{offerId}/prepare", method: "post", ...prep },
    { path: "/v1/offers/{offerId}/prepare", method: "post", ...(await offerThenPrepare(app, "unavailable")).prep },
    { path: "/v1/offers/{offerId}/prepare", method: "post", ...(await call(app, "/v1/offers/off_x/prepare", { method: "POST", body: {} })) },
    { path: "/v1/yield/terms", method: "get", ...(await call(app, `/v1/yield/terms?offerId=${offer.body.offerId}`)) },
    { path: "/v1/yield/terms", method: "get", ...(await call(app, "/v1/yield/terms")) },
    { path: "/v1/offers", method: "post", ...(await call(app, "/v1/offers", { method: "POST", body: offerBody(), scenario: "error" })) },
  ];
  for (const scenario of ["", "cancelled", "settled", "yield_zero"]) {
    out.push({ path: "/v1/bookings/{bookingId}", method: "get", ...(await call(app, `/v1/bookings/${BOOKING_ID}`, { headers: AUTH, scenario })) });
    out.push({ path: "/v1/bookings/{bookingId}/cancel-preview", method: "post", ...(await call(app, `/v1/bookings/${BOOKING_ID}/cancel-preview`, { method: "POST", headers: AUTH, scenario })) });
  }
  out.push({ path: "/v1/bookings/{bookingId}", method: "get", ...(await call(app, `/v1/bookings/${BOOKING_ID}`)) });
  return out;
}

describe("OpenAPI document", () => {
  it("is served at /v1/openapi.json with all six endpoints", async () => {
    const { app } = makeApp();
    const r = await call(app, "/v1/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.1.0");
    expect(Object.keys(r.body.paths).sort()).toEqual(
      [
        "/v1/availability",
        "/v1/bookings/{bookingId}",
        "/v1/bookings/{bookingId}/cancel-preview",
        "/v1/offers",
        "/v1/offers/{offerId}/prepare",
        "/v1/yield/terms",
      ].sort(),
    );
  });

  it("ignores stub scenarios", async () => {
    const { app } = makeApp();
    expect((await call(app, "/v1/openapi.json", { scenario: "error" })).status).toBe(200);
  });

  it("describes every response the stub produces", async () => {
    const { app } = makeApp();
    const doc = (await call(app, "/v1/openapi.json")).body as Doc;
    const ajv = new Ajv2020.default({ strict: false, allErrors: true });
    addFormats.default(ajv);
    for (const r of await everyResponse()) {
      const spec = doc.paths[r.path]?.[r.method]?.responses[String(r.status)];
      expect(spec, `${r.method} ${r.path} ${r.status} undocumented`).toBeDefined();
      const validate = ajv.compile(spec.content["application/json"].schema);
      expect(validate(r.body), `${r.method} ${r.path} ${r.status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});

describe("money and disclosure rules", () => {
  it("every money field is a decimal string", async () => {
    const moneyKeys = /Atomic$/;
    for (const r of await everyResponse()) {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === "object") {
          for (const [k, x] of Object.entries(v)) {
            if (moneyKeys.test(k)) expect(x, k).toMatch(/^(0|[1-9][0-9]*)$/);
            walk(x);
          }
        }
      };
      walk(r.body);
    }
  });

  it("feeBps appears only inside quote in the prepare response", async () => {
    for (const r of await everyResponse()) {
      const hits = findKeys(r.body, "feeBps");
      const allowed = r.path === "/v1/offers/{offerId}/prepare" && r.status === 200 ? ["$.quote.feeBps"] : [];
      expect(hits, `${r.method} ${r.path} ${r.status}`).toEqual(allowed);
    }
  });
});

describe("yield estimate (spec 8)", () => {
  it("reproduces the 10,000 USDC, 60-day, 4.18% row: ~47 gross, ~24 to the guest", () => {
    const stay = { ...materialiseStay("2027-02-20", "2027-02-23", new Date(0)), priceAtomic: 10_000_000_000n };
    const now = new Date((stay.checkInUtc - 60 * 86_400) * 1000);
    const guest = estimateGuestYield(stay, now, 418, 5_000);
    // Exact: floor(floor(10_000e6 * 418 * 46d * 9000 / (1e4 * 365d * 1e4)) * 5000 / 1e4)
    const gross = (10_000_000_000n * 418n * (46n * 86_400n) * 9_000n) / (10_000n * 365n * 86_400n * 10_000n);
    expect(gross).toBe(47_411_506n); // 47.41 USDC; spec 8 table says ~47
    expect(guest).toBe(gross / 2n);
  });

  it("is zero inside the 14-day liquidity window", () => {
    const stay = materialiseStay("2027-02-20", "2027-02-23", new Date(0));
    expect(estimateGuestYield(stay, new Date((stay.checkInUtc - 13 * 86_400) * 1000), 418, 5_000)).toBe(0n);
  });
});
