// Brief test 2 (DST): policies whose local cutoff falls on the Europe/Athens DST transitions
// (last Sunday of March and October) materialise to the correct UTC instant.

import { describe, expect, it } from "vitest";
import { InvalidPolicy, InvalidStay, localInstant, materialiseStay, Property, refundCurve } from "../src/property.js";
import { VILLA } from "./fixtures.js";


const utc = (dt: { toUTC(): { toISO(o: object): string | null } }) =>
  dt.toUTC().toISO({ suppressMilliseconds: true });

describe("localInstant: Europe/Athens DST (2026: starts Mar 29 03:00 EET, ends Oct 25 04:00 EEST)", () => {
  it("18:00 on the spring-forward day is 15:00Z (already EEST, +03:00)", () => {
    expect(utc(localInstant("2026-03-29", "18:00", "Europe/Athens"))).toBe("2026-03-29T15:00:00Z");
  });

  it("18:00 the day before spring-forward is 16:00Z (EET, +02:00)", () => {
    expect(utc(localInstant("2026-03-28", "18:00", "Europe/Athens"))).toBe("2026-03-28T16:00:00Z");
  });

  it("18:00 on the fall-back day is 16:00Z (EET again, +02:00)", () => {
    expect(utc(localInstant("2026-10-25", "18:00", "Europe/Athens"))).toBe("2026-10-25T16:00:00Z");
  });

  it("a wall time inside the spring-forward gap resolves to the first instant after the gap", () => {
    // 03:30 does not exist on 2026-03-29; clocks read 04:30 EEST at 01:30Z.
    expect(utc(localInstant("2026-03-29", "03:30", "Europe/Athens"))).toBe("2026-03-29T01:30:00Z");
  });

  it("a wall time inside the fall-back overlap resolves to the later occurrence (guest-favourable)", () => {
    // 03:30 happens twice on 2026-10-25: 00:30Z (EEST) and 01:30Z (EET). Take 01:30Z.
    expect(utc(localInstant("2026-10-25", "03:30", "Europe/Athens"))).toBe("2026-10-25T01:30:00Z");
  });

  it("the exact transition minutes", () => {
    expect(utc(localInstant("2026-03-29", "02:59", "Europe/Athens"))).toBe("2026-03-29T00:59:00Z");
    expect(utc(localInstant("2026-03-29", "04:00", "Europe/Athens"))).toBe("2026-03-29T01:00:00Z");
    expect(utc(localInstant("2026-10-25", "04:00", "Europe/Athens"))).toBe("2026-10-25T02:00:00Z");
  });
});

describe("materialiseStay", () => {
  const NOW = Date.UTC(2026, 0, 1) / 1000;

  it("materialises a stay whose cutoffs straddle the October change", () => {
    // Check-in Nov 8 2026: cutoffs Oct 9 (EEST), Oct 25 (the fall-back day, EET), Nov 1 (EET).
    const s = materialiseStay(VILLA, "2026-11-08", "2026-11-15", NOW);
    expect(s.nights).toBe(7);
    expect(s.priceAtomic).toBe(5_600_000_000n);
    expect(s.cutoffs.map((c) => new Date(c.cutoffUtc * 1000).toISOString())).toEqual([
      "2026-10-09T15:00:00.000Z",
      "2026-10-25T16:00:00.000Z",
      "2026-11-01T16:00:00.000Z",
    ]);
    expect(refundCurve(s)[1]).toEqual({ untilLocal: "2026-10-25T18:00:00+02:00", refundBps: 5_000 });
  });

  it("materialises a stay whose cutoffs straddle the March change", () => {
    const s = materialiseStay(VILLA, "2026-04-05", "2026-04-08", NOW);
    expect(s.cutoffs.map((c) => new Date(c.cutoffUtc * 1000).toISOString())).toEqual([
      "2026-03-06T16:00:00.000Z", // EET
      "2026-03-22T16:00:00.000Z", // EET
      "2026-03-29T15:00:00.000Z", // the change day: EEST
    ]);
  });

  it("rejects a stay in the past, reversed dates and too many nights", () => {
    expect(() => materialiseStay(VILLA, "2025-12-01", "2025-12-03", NOW)).toThrow(InvalidStay);
    expect(() => materialiseStay(VILLA, "2026-05-10", "2026-05-01", NOW)).toThrow(InvalidStay);
    expect(() => materialiseStay(VILLA, "2026-05-01", "2026-07-15", NOW)).toThrow(InvalidStay);
  });

  it("rejects a policy that would produce a non-monotonic curve before it reaches a guest (spec 5.1)", () => {
    const bad = Property.parse({
      ...VILLA,
      policy: { ...VILLA.policy, rules: [{ daysBefore: 7, time: "18:00", refundBps: 2_500 }, { daysBefore: 14, time: "18:00", refundBps: 5_000 }] },
    });
    expect(() => materialiseStay(bad, "2026-06-01", "2026-06-05", NOW)).toThrow(InvalidPolicy);
  });
});
