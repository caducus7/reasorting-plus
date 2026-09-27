// Acceptance: concurrent offer requests for the same slot never produce two active holds (spec 5.2).
// Runs against real PostgreSQL: the guarantee is the exclusion constraint, not application logic.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createOfferWithHold, migrate, recordQuote, SlotTaken, slotHeldByOther, type Db, holdLockKey } from "../src/db.js";
import { freshDb } from "./pgtest.js";

const R = `0x${"44".repeat(32)}`;
const T0 = new Date("2026-09-26T12:00:00Z");
let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, drop } = await freshDb());
});
afterAll(async () => drop());

function offer(checkIn: string, checkOut: string, now = T0, lockMin = 25) {
  return {
    offer_id: randomUUID(),
    chain_id: 31337,
    escrow: "0xescrow",
    resource_id: R,
    check_in: checkIn,
    check_out: checkOut,
    guests: 2,
    price_atomic: "5600000000",
    policy_id: "p",
    session_id: null,
    now,
    expiresAt: new Date(now.getTime() + lockMin * 60_000),
  };
}

async function activeHolds(): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM holds WHERE active AND expires_at > $1", [T0]);
  return r.rows[0].n as number;
}

describe("soft holds", () => {
  it("50 concurrent requests for the same slot: exactly one hold", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => createOfferWithHold(db, offer("2027-01-10", "2027-01-17"))),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const taken = results.filter((r) => r.status === "rejected" && r.reason instanceof SlotTaken).length;
    expect(ok).toBe(1);
    expect(taken).toBe(49);
    expect(await activeHolds()).toBe(1);
  });

  it("overlapping ranges conflict; adjacent ranges (check-out day = next check-in) do not", async () => {
    await createOfferWithHold(db, offer("2027-02-10", "2027-02-15"));
    await expect(createOfferWithHold(db, offer("2027-02-14", "2027-02-20"))).rejects.toBeInstanceOf(SlotTaken);
    await expect(createOfferWithHold(db, offer("2027-02-01", "2027-02-11"))).rejects.toBeInstanceOf(SlotTaken);
    await createOfferWithHold(db, offer("2027-02-15", "2027-02-18")); // starts on the check-out day
    await createOfferWithHold(db, offer("2027-02-05", "2027-02-10")); // ends on the check-in day
  });

  // Not every pair overlaps ([02-28, 03-02) and [03-05, 03-12) are disjoint), so which requests win
  // depends on arrival order. The property: winners are pairwise disjoint, someone wins, and every
  // loser fails with SlotTaken (not a deadlock or another error).
  it("concurrent overlapping requests: winners never overlap; losers get SlotTaken", async () => {
    const ranges: [string, string][] = [
      ["2027-03-01", "2027-03-08"],
      ["2027-03-05", "2027-03-12"],
      ["2027-03-07", "2027-03-09"],
      ["2027-02-28", "2027-03-02"],
    ];
    for (let round = 0; round < 10; round++) {
      await db.query("TRUNCATE offers, holds CASCADE");
      const results = await Promise.allSettled(ranges.map(([a, b]) => createOfferWithHold(db, offer(a, b))));
      const won = ranges.filter((_, i) => results[i]!.status === "fulfilled");
      expect(won.length).toBeGreaterThan(0);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(SlotTaken);
      for (let i = 0; i < won.length; i++)
        for (let j = i + 1; j < won.length; j++) expect(won[i]![0] < won[j]![1] && won[j]![0] < won[i]![1]).toBe(false);
    }
  });

  it("an expired hold is released by the next request for the slot", async () => {
    await createOfferWithHold(db, offer("2027-04-01", "2027-04-05", T0, 25));
    const later = new Date(T0.getTime() + 26 * 60_000);
    await expect(createOfferWithHold(db, offer("2027-04-02", "2027-04-04", new Date(T0.getTime() + 60_000)))).rejects.toBeInstanceOf(SlotTaken);
    await createOfferWithHold(db, offer("2027-04-02", "2027-04-04", later)); // after the 25-minute lock
  });

  it("slotHeldByOther ignores our own hold and expired holds", async () => {
    const mine = offer("2027-05-01", "2027-05-05");
    await createOfferWithHold(db, mine);
    expect(await slotHeldByOther(db, R, "2027-05-02", "2027-05-03", T0, mine.offer_id)).toBe(false);
    expect(await slotHeldByOther(db, R, "2027-05-02", "2027-05-03", T0, null)).toBe(true);
    expect(await slotHeldByOther(db, R, "2027-05-02", "2027-05-03", new Date(T0.getTime() + 30 * 60_000), null)).toBe(false);
  });

  it("at most one live quote per offer, even under concurrent prepares", async () => {
    const o = offer("2027-06-01", "2027-06-05");
    await createOfferWithHold(db, o);
    const expiresAt = new Date(T0.getTime() + 15 * 60_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        recordQuote(db, {
          chainId: 31337, escrow: "0xescrow", bookingId: `0x${i.toString(16).padStart(64, "0")}`, offerId: o.offer_id,
          guest: "0xguest", email: "g@example.com", sessionId: null, quote: {}, quoteSig: "0x", expiresAt, now: T0,
        }),
      ),
    );
    expect(results.filter((r) => r === "recorded").length).toBe(1);
    expect(results.filter((r) => r === "conflict").length).toBe(9);
  });

  it("migrations are idempotent", async () => {
    await migrate(db);
    await migrate(db);
  });

  it("advisory-lock key: deterministic, case-insensitive, a signed 64-bit value per resource", () => {
    const k = holdLockKey(R);
    expect(holdLockKey(R.toUpperCase().replace("0X", "0x"))).toBe(k);
    expect(k).toBe(holdLockKey(R));
    expect(k >= -(2n ** 63n) && k < 2n ** 63n).toBe(true);
    expect(holdLockKey(`0x${"45".repeat(32)}`)).not.toBe(k);
  });
});
