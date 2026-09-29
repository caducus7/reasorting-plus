// The indexer-backed read model: mapping, strict validation, 404 = unknown, errors surface.
import { describe, expect, it } from "vitest";
import { indexerReadModel, withFallback, type BookingReadModel } from "../src/readModel.js";

const ESCROW = "0x3B02fF1e626Ed7a8fd6eC5299e2C54e1421B626B" as const;
const ID = `0x${"ab".repeat(32)}` as const;
const body = {
  escrow: ESCROW.toLowerCase(),
  bookingId: ID,
  state: "ESCROWED",
  outcome: null,
  guest: "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  resourceId: `0x${"a1".repeat(32)}`,
  checkInUtc: 1_790_000_000,
  checkOutUtc: 1_790_259_200,
  principalAtomic: "450000000",
  feeBps: 500,
  guestYieldBps: 5_000,
  finalBps: 0,
  cutoffs: [{ cutoffUtc: 1_789_395_200, refundBps: 10_000 }],
  frozenTotal: 0,
  refundBps: 10_000,
  refundIfCancelledNowAtomic: "450000000",
  accruedGuestYieldAtomic: "1234",
  claimableAtomic: "0",
  txHash: `0x${"cd".repeat(32)}`,
  asOf: { block: "12", timestamp: "1789000000" },
};
const fake = (status: number, json: unknown): typeof fetch =>
  (async (url: string) => {
    expect(url).toBe(`http://idx/v1/indexer/bookings/${ESCROW}/${ID}`);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;

describe("indexerReadModel", () => {
  it("maps the indexer's booking view to BookingView with bigint money", async () => {
    const v = await indexerReadModel("http://idx/", ESCROW, { fetch: fake(200, body) }).getBooking(ID);
    expect(v).toMatchObject({ state: "ESCROWED", principalAtomic: 450_000_000n, accruedGuestYieldAtomic: 1_234n, claimableAtomic: 0n, frozenTotal: 0 });
    expect(v).not.toHaveProperty("bookingId");
  });
  it("an unknown booking is null (the API answers 403 either way)", async () => {
    expect(await indexerReadModel("http://idx", ESCROW, { fetch: fake(404, { error: "not_found" }) }).getBooking(ID)).toBeNull();
  });
  it("rejects malformed money, unknown states and a mismatched booking", async () => {
    const m = (j: unknown) => indexerReadModel("http://idx", ESCROW, { fetch: fake(200, j) }).getBooking(ID);
    await expect(m({ ...body, principalAtomic: 450_000_000 })).rejects.toThrow();
    await expect(m({ ...body, principalAtomic: "4.5e8" })).rejects.toThrow();
    await expect(m({ ...body, state: "PAID" })).rejects.toThrow();
    await expect(m({ ...body, bookingId: `0x${"ef".repeat(32)}` })).rejects.toThrow(/different booking/);
  });
  it("an indexer error is an error, never a guess", async () => {
    await expect(indexerReadModel("http://idx", ESCROW, { fetch: fake(500, {}) }).getBooking(ID)).rejects.toThrow(/500/);
  });
});

describe("withFallback (review 0005 R7)", () => {
  const view = { state: "ESCROWED" } as never;
  const model = (f: () => Promise<unknown>): BookingReadModel & { calls: number } => {
    const m = { calls: 0, getBooking: async () => (m.calls++, f() as never) };
    return m;
  };
  it("uses the indexer when it knows the booking, and the chain when it does not or is down", async () => {
    const chain = model(async () => view);
    expect(await withFallback(model(async () => view), chain).getBooking(ID)).toBe(view);
    expect(chain.calls).toBe(0);
    expect(await withFallback(model(async () => null), chain).getBooking(ID)).toBe(view); // not indexed yet
    expect(await withFallback(model(async () => { throw new Error("indexer read API 503"); }), chain, () => {}).getBooking(ID)).toBe(view);
    expect(chain.calls).toBe(2);
    expect(await withFallback(model(async () => null), model(async () => null)).getBooking(ID)).toBeNull(); // unknown everywhere
  });
});
