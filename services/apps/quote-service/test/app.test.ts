// App-level tests: real Postgres, real signer and JWT verification, fake chain and read model.
// Every response is also re-validated here against the unchanged C0 schemas.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportSPKI, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { decodeFunctionData, erc20Abi, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { escrowAbi } from "@chain/abi";
import { v1 } from "@chain/shared";
import { bookingIdOf, quoteTypedData } from "@chain/shared/eip712";
import { createApp, estimateGuestYield, type Deps } from "../src/app.js";
import { jwtAuth } from "../src/auth.js";
import type { LiveTerms } from "../src/chain.js";
import { pgCalendar, type Db } from "../src/db.js";
import { Property } from "../src/property.js";
import type { BookingView } from "../src/readModel.js";
import { localSigner } from "../src/signer.js";
import { freshDb } from "./pgtest.js";
import { VILLA } from "./fixtures.js";

const ANVIL_KEY_2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const GUEST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const OTHER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address; // anvil #3 (not the signer, #2)
const ESCROW = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const USDC = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const CHAIN_ID = 31_337;
const T0 = Date.parse("2026-04-01T09:00:00Z");

const STUDIO = Property.parse({
  ...VILLA,
  resourceId: `0x${"AB".repeat(32)}`, // mixed case in config, canonical lowercase in use
  name: "Studio",
  maxGuests: 2,
  nightlyAtomic: "100000000",
  minNights: 3,
});

let pg: Awaited<ReturnType<typeof freshDb>>;
let db: Db;
let jwtKey: CryptoKey;
let deps: Deps;
let clock: number;
let terms: LiveTerms;
let safeLagSec = 30;
const bookings = new Map<string, BookingView>();
const signer = localSigner(ANVIL_KEY_2, "test");

beforeAll(async () => {
  pg = await freshDb();
  db = pg.db;
  const kp = await generateKeyPair("ES256");
  jwtKey = kp.privateKey;
  deps = {
    db,
    calendar: pgCalendar(db),
    chain: {
      liveTerms: async () => ({ ...terms, blockTimestamp: Math.floor(clock / 1000) }),
      // Safe head trails latest by ~30 s on live Base (measured 2026-09-27: 15 blocks).
      safeHead: async () => ({ number: 1n, timestamp: Math.floor(clock / 1000) - safeLagSec }),
      bookingExistsAt: async (id) => bookings.has(id.toLowerCase()),
    },
    signer,
    bookings: { getBooking: async (id) => bookings.get(id.toLowerCase()) ?? null },
    auth: await jwtAuth({ issuer: "checkout", audience: "booking-api", publicKeyPem: await exportSPKI(kp.publicKey) }),
    properties: [VILLA, STUDIO],
    settings: {
      chainId: CHAIN_ID,
      escrow: ESCROW,
      usdc: USDC,
      offerLockSec: 1_500,
      quoteTtlSec: 900,
      feedMaxAgeSec: 900,
      maxClockSkewSec: 120,
      apyEstimateBps: 400,
      yieldProtocol: "Aave V3 USDC on Base",
    },
    now: () => new Date(clock),
  };
});
afterAll(async () => pg.drop());

beforeEach(async () => {
  clock = T0;
  terms = {
    blockNumber: 1n,
    blockTimestamp: 0,
    effectiveFeeBps: 300,
    guestYieldBps: 5_000,
    pendingFeeAt: 0,
    paused: false,
    lossDebt: 0n,
    quoteSigner: signer.address,
    minNightlyAtomic: 1_000_000n,
    maxOpenPrincipalAtomic: 1_000_000_000_000n,
    totalOpenPrincipal: 0n,
  };
  bookings.clear();
  safeLagSec = 30;
  await db.query("TRUNCATE offers, holds, quotes, calendar_blocks, channel_feeds CASCADE");
});

const app = () => createApp(deps);
const call = (path: string, init?: RequestInit) => app().request(path, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function offer(checkIn = "2026-06-10", checkOut = "2026-06-14", resourceId: string = VILLA.resourceId) {
  const r = await post("/v1/offers", { resourceId, checkIn, checkOut, guests: 2, locale: "en" });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}
async function prepare(offerId: string, guestAddress: Address = GUEST, email = "g@example.com") {
  const r = await post(`/v1/offers/${offerId}/prepare`, { guestAddress, email });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe("availability", () => {
  it("lists free properties that fit, with the materialised price", async () => {
    const r = await call("/v1/availability?checkIn=2026-06-10&checkOut=2026-06-14&guests=2");
    expect(r.status).toBe(200);
    const items = v1.AvailabilityResponse.parse(await r.json());
    expect(items.map((i) => [i.name, i.nights, i.priceAtomic])).toEqual([
      ["Villa (Crete)", 4, "3200000000"],
      ["Studio", 4, "400000000"],
    ]);
  });

  it("omits a property whose limits the stay breaks, 400s only if no property accepts it", async () => {
    const two = v1.AvailabilityResponse.parse(await (await call("/v1/availability?checkIn=2026-06-10&checkOut=2026-06-12&guests=1")).json());
    expect(two.map((i) => i.name)).toEqual(["Villa (Crete)"]); // Studio has minNights 3
    const r = await call("/v1/availability?checkIn=2026-06-14&checkOut=2026-06-10&guests=1");
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_stay" });
  });

  it("drops a property blocked by a channel event or by another guest's hold", async () => {
    await db.query("INSERT INTO calendar_blocks VALUES ($1, daterange('2026-06-12','2026-06-13'), 'airbnb', 'uid1')", [VILLA.resourceId]);
    await offer("2026-06-10", "2026-06-14", STUDIO.resourceId);
    const items = v1.AvailabilityResponse.parse(await (await call("/v1/availability?checkIn=2026-06-10&checkOut=2026-06-14&guests=2")).json());
    expect(items).toEqual([]);
  });

  it("rejects malformed queries", async () => {
    expect((await call("/v1/availability?checkIn=2026-06-10&guests=2")).status).toBe(400);
  });
});

describe("offers", () => {
  it("locks price and the slot for 25 minutes and returns local times with offsets", async () => {
    const o = await offer();
    expect(o.status).toBe(200);
    const body = v1.OfferResponse.parse(o.body);
    expect(body.priceAtomic).toBe("3200000000");
    expect(body.checkInLocal).toBe("2026-06-10T15:00:00+03:00");
    expect(body.expiresAt).toBe("2026-04-01T09:25:00Z");
    expect(body.refundCurve.at(-1)).toEqual({ untilLocal: "2026-06-14T11:00:00+03:00", refundBps: 0 });
    expect(JSON.stringify(o.body)).not.toContain("feeBps");
    const again = await offer("2026-06-12", "2026-06-16");
    expect(again).toEqual({ status: 409, body: { error: "unavailable" } });
  });

  it("404s an unknown resource, 400s bad stays and oversized parties, 409s a channel block", async () => {
    expect((await offer("2026-06-10", "2026-06-14", `0x${"99".repeat(32)}`)).status).toBe(404);
    expect((await offer("2026-06-14", "2026-06-10")).body).toEqual({ error: "invalid_stay" });
    const big = await post("/v1/offers", { resourceId: STUDIO.resourceId, checkIn: "2026-06-10", checkOut: "2026-06-14", guests: 3, locale: "en" });
    expect(big.status).toBe(400);
    await db.query("INSERT INTO calendar_blocks VALUES ($1, daterange('2026-06-13','2026-06-20'), 'escrow', '0x01')", [VILLA.resourceId]);
    expect(await offer()).toEqual({ status: 409, body: { error: "unavailable" } });
  });

  it("accepts a mixed-case resourceId", async () => {
    expect((await offer("2026-06-10", "2026-06-14", STUDIO.resourceId.toUpperCase().replace("0X", "0x"))).status).toBe(200);
  });
});

describe("prepare", () => {
  it("signs a quote the escrow's signer recovers, with live fee, split and chain-time expiry", async () => {
    const o = await offer();
    const p = await prepare(o.body.offerId as string);
    expect(p.status).toBe(200);
    const r = v1.PrepareResponse.parse(p.body);
    expect(r.quote).toMatchObject({ feeBps: 300, guestYieldBps: 5_000, priceAtomic: "3200000000", finalBps: 0, guest: GUEST });
    expect(r.quote.resourceId).toBe(VILLA.resourceId);
    expect(r.quote.expiresAt).toBe(Math.floor(T0 / 1000) + 900);
    expect(r.quote.cutoffs).toEqual([
      { cutoffUtc: Date.parse("2026-05-11T15:00:00Z") / 1000, refundBps: 10_000 },
      { cutoffUtc: Date.parse("2026-05-27T15:00:00Z") / 1000, refundBps: 5_000 },
      { cutoffUtc: Date.parse("2026-06-03T15:00:00Z") / 1000, refundBps: 2_500 },
    ]);
    expect(r.bookingId).toBe(bookingIdOf(r.quote));
    const recovered = await recoverTypedDataAddress({ ...(quoteTypedData(r.quote, CHAIN_ID, ESCROW) as never), signature: r.quoteSig as Hex });
    expect(recovered).toBe(signer.address);

    // calls: approve(escrow, price) on USDC, then deposit(quote, sig) on the escrow
    expect(r.calls.map((c) => c.to)).toEqual([USDC, ESCROW]);
    const approve = decodeFunctionData({ abi: erc20Abi, data: r.calls[0]!.data as Hex });
    expect(approve.args).toEqual([ESCROW, 3_200_000_000n]);
    const dep = decodeFunctionData({ abi: escrowAbi, data: r.calls[1]!.data as Hex });
    expect(dep.functionName).toBe("deposit");
    expect((dep.args as unknown[])[1]).toBe(r.quoteSig);
    expect(r.calls.every((c) => c.stub === undefined && c.value === "0")).toBe(true);
  });

  it("is idempotent for the same guest and 409s another guest while the quote is live", async () => {
    const id = (await offer()).body.offerId as string;
    const a = await prepare(id);
    const b = await prepare(id);
    expect(b).toEqual(a);
    expect(await prepare(id, OTHER)).toEqual({ status: 409, body: { error: "unavailable" } });
  });

  it("issues exactly one live quote under concurrent prepares", async () => {
    const id = (await offer()).body.offerId as string;
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => prepare(id, i % 2 ? GUEST : OTHER)));
    const ok = rs.filter((r) => r.status === 200);
    const ids = new Set(ok.map((r) => r.body.bookingId));
    expect(ids.size).toBe(1);
    expect(rs.every((r) => r.status === 200 || (r.status === 409 && (r.body as { error: string }).error === "unavailable"))).toBe(true);
    const n = await db.query("SELECT count(*)::int AS n FROM quotes");
    expect(n.rows[0].n).toBe(1);
  });

  it("holds a quoted slot until the chain proves the quote unpaid, then frees it", async () => {
    const id = (await offer()).body.offerId as string;
    clock = T0 + 20 * 60_000;
    expect((await prepare(id)).status).toBe(200); // quote expires T0+35m (chain time)
    clock = T0 + 30 * 60_000;
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(409);
    clock = T0 + 35 * 60_000 + 20_000; // expired, but the safe head (30 s behind) is not past it yet
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(409);
    clock = T0 + 35 * 60_000 + 31_000; // safe head past expiry, booking absent: proven unpaid
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(200);
  });

  it("never frees a paid slot, however long the indexer lags; hands over to calendar_blocks", async () => {
    const id = (await offer()).body.offerId as string;
    const r = v1.PrepareResponse.parse((await prepare(id)).body);
    bookings.set(r.bookingId.toLowerCase(), { state: "ESCROWED" } as BookingView); // deposited, not indexed
    clock = T0 + 24 * 3_600_000; // a day later, still no indexer
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(409);
    const items = v1.AvailabilityResponse.parse(
      await (await call("/v1/availability?checkIn=2026-06-10&checkOut=2026-06-14&guests=2")).json(),
    );
    expect(items.map((i) => i.name)).toEqual(["Studio"]);
    // The indexer projects the booking: the hold hands over and the calendar keeps blocking.
    await db.query("INSERT INTO calendar_blocks VALUES ($1, daterange('2026-06-10','2026-06-14'), 'escrow', $2)", [
      VILLA.resourceId,
      r.bookingId,
    ]);
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(409);
    expect((await db.query("SELECT count(*)::int AS n FROM holds WHERE active")).rows[0].n).toBe(0);
    // The booking is later cancelled and C6 removes the block: the slot is free again.
    await db.query("DELETE FROM calendar_blocks");
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(200);
  });

  it("an expired quote ends its offer only on proof; no replacement quote is ever signed", async () => {
    const id = (await offer()).body.offerId as string;
    v1.PrepareResponse.parse((await prepare(id)).body);
    clock = T0 + 15 * 60_000 + 10_000; // quote expired; safe head not yet past it
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "unavailable" } });
    clock = T0 + 15 * 60_000 + 31_000; // proven unpaid
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "terms_changed" } });
    expect((await db.query("SELECT count(*)::int AS n FROM quotes")).rows[0].n).toBe(1);
  });

  it("an RPC outage leaves quoted holds in place without failing the endpoints", async () => {
    const id = (await offer()).body.offerId as string;
    v1.PrepareResponse.parse((await prepare(id)).body);
    clock = T0 + 60 * 60_000; // long expired: would be provable, but the chain is unreachable
    const real = deps.chain;
    deps.chain = { ...real, safeHead: async () => Promise.reject(new Error("rpc down")) };
    try {
      expect((await offer("2026-06-11", "2026-06-13")).status).toBe(409);
      expect((await call("/v1/availability?checkIn=2026-06-10&checkOut=2026-06-14&guests=2")).status).toBe(200);
      expect(await prepare(id)).toEqual({ status: 409, body: { error: "unavailable" } });
    } finally {
      deps.chain = real;
    }
    expect((await offer("2026-06-11", "2026-06-13")).status).toBe(200); // chain back: proven unpaid
  });

  it("a paid offer is never re-quoted", async () => {
    const id = (await offer()).body.offerId as string;
    const r = v1.PrepareResponse.parse((await prepare(id)).body);
    bookings.set(r.bookingId.toLowerCase(), { state: "ESCROWED" } as BookingView);
    clock = T0 + 2 * 3_600_000;
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "unavailable" } });
    expect((await db.query("SELECT count(*)::int AS n FROM quotes")).rows[0].n).toBe(1);
  });

  it("returns terms_changed once the offer lock has lapsed without a quote", async () => {
    const id = (await offer()).body.offerId as string;
    clock = T0 + 26 * 60_000;
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "terms_changed" } });
  });

  it("caps expiry 60s before a pending fee change and 409s inside that last minute", async () => {
    const t = Math.floor(T0 / 1000);
    terms.pendingFeeAt = t + 600;
    const a = v1.PrepareResponse.parse((await prepare((await offer()).body.offerId as string)).body);
    expect(a.quote.expiresAt).toBe(t + 540);
    expect(a.quote.feeBps).toBe(300);

    await db.query("TRUNCATE offers, holds, quotes CASCADE");
    terms.pendingFeeAt = t + 60;
    expect(await prepare((await offer()).body.offerId as string)).toEqual({ status: 409, body: { error: "terms_changed" } });

    // Once the change is live the effective fee is read directly; no cap applies.
    await db.query("TRUNCATE offers, holds, quotes CASCADE");
    terms.pendingFeeAt = t - 1;
    terms.effectiveFeeBps = 450;
    const c = v1.PrepareResponse.parse((await prepare((await offer()).body.offerId as string)).body);
    expect([c.quote.feeBps, c.quote.expiresAt]).toEqual([450, t + 900]);
  });

  it.each([
    ["deposits paused", () => void (terms.paused = true)],
    ["loss debt outstanding", () => void (terms.lossDebt = 1n)],
    ["escrow cap would be exceeded", () => void (terms.totalOpenPrincipal = terms.maxOpenPrincipalAtomic - 3_199_999_999n)],
  ])("fails closed with unavailable when %s", async (_n, set) => {
    const id = (await offer()).body.offerId as string;
    set();
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "unavailable" } });
    expect((await db.query("SELECT count(*)::int AS n FROM quotes")).rows[0].n).toBe(0);
  });

  it("fails closed when a channel feed is stale or a channel booking arrived after the offer", async () => {
    const id = (await offer()).body.offerId as string;
    await db.query("INSERT INTO channel_feeds VALUES ($1, 'airbnb', $2)", [VILLA.resourceId, new Date(T0 - 901_000)]);
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "unavailable" } });
    await db.query("UPDATE channel_feeds SET last_success_at = NULL"); // never imported = stale
    expect(await prepare(id)).toEqual({ status: 409, body: { error: "unavailable" } });
    await db.query("UPDATE channel_feeds SET last_success_at = $1", [new Date(T0 - 60_000)]);
    expect((await prepare(id)).status).toBe(200);

    const id2 = (await offer("2026-07-01", "2026-07-05")).body.offerId as string;
    await db.query("INSERT INTO calendar_blocks VALUES ($1, daterange('2026-07-04','2026-07-06'), 'booking', 'x')", [VILLA.resourceId]);
    expect(await prepare(id2)).toEqual({ status: 409, body: { error: "unavailable" } });
  });

  it("refuses to sign (500) if the escrow's quoteSigner is not this service's key", async () => {
    const id = (await offer()).body.offerId as string;
    terms.quoteSigner = OTHER;
    const r = await post(`/v1/offers/${id}/prepare`, { guestAddress: GUEST, email: "g@example.com" });
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "internal_error" });
  });

  it("refuses to sign (500) when chain time and the server clock disagree beyond the limit", async () => {
    const id = (await offer()).body.offerId as string;
    const real = deps.chain;
    deps.chain = { ...real, liveTerms: async () => ({ ...(await real.liveTerms()), blockTimestamp: Math.floor(clock / 1000) - 121 }) };
    try {
      expect((await post(`/v1/offers/${id}/prepare`, { guestAddress: GUEST, email: "g@example.com" })).status).toBe(500);
      deps.chain = { ...real, liveTerms: async () => ({ ...(await real.liveTerms()), blockTimestamp: Math.floor(clock / 1000) - 120 }) };
      expect((await prepare(id)).status).toBe(200);
    } finally {
      deps.chain = real;
    }
  });

  it("404s unknown and malformed offer ids; 400s bad bodies", async () => {
    expect((await prepare("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await prepare("nope")).status).toBe(404);
    const id = (await offer()).body.offerId as string;
    expect((await post(`/v1/offers/${id}/prepare`, { guestAddress: GUEST })).status).toBe(400);
    expect((await post(`/v1/offers/${id}/prepare`, { guestAddress: "0x12", email: "g@example.com" })).status).toBe(400);
  });
});

// ------------------------------------------------------------------ guest-authenticated reads

function jwt(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("checkout")
    .setAudience("booking-api")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(jwtKey);
}

async function preparedBooking(): Promise<{ bookingId: Hex; quote: v1.Quote }> {
  const r = v1.PrepareResponse.parse((await prepare((await offer()).body.offerId as string, GUEST, "Guest@Example.com")).body);
  const q = r.quote;
  bookings.set(r.bookingId.toLowerCase(), {
    state: "ESCROWED",
    outcome: null,
    guest: GUEST,
    resourceId: q.resourceId as Hex,
    checkInUtc: q.checkInUtc,
    checkOutUtc: q.checkOutUtc,
    principalAtomic: BigInt(q.priceAtomic),
    feeBps: q.feeBps,
    guestYieldBps: q.guestYieldBps,
    finalBps: q.finalBps,
    cutoffs: q.cutoffs,
    accruedGuestYieldAtomic: 1_234n,
    claimableAtomic: 0n,
    txHash: `0x${"aa".repeat(32)}`,
  });
  return { bookingId: r.bookingId as Hex, quote: q };
}

describe("bookings (guest auth)", () => {
  it("shows the booking to the guest's address and to the booking email", async () => {
    const { bookingId } = await preparedBooking();
    for (const claims of [{ addr: GUEST }, { email: "guest@example.com" }]) {
      const r = await call(`/v1/bookings/${bookingId}`, { headers: { authorization: `Bearer ${await jwt(claims)}` } });
      expect(r.status).toBe(200);
      const b = v1.BookingResponse.parse(await r.json());
      expect(b).toMatchObject({
        state: "ESCROWED",
        priceAtomic: "3200000000",
        refundIfCancelledNowAtomic: "3200000000", // before the first cutoff: 100%
        accruedYieldAtomic: "1234",
        checkInLocal: "2026-06-10T15:00:00+03:00",
        policyId: "pol_standard_v1",
        renderedPolicy: VILLA.policy.rendered,
        claimCalls: [],
      });
    }
  });

  it("401s without a valid token; 403s another guest and an unknown booking alike", async () => {
    const { bookingId } = await preparedBooking();
    expect((await call(`/v1/bookings/${bookingId}`)).status).toBe(401);
    expect((await call(`/v1/bookings/${bookingId}`, { headers: { authorization: "Bearer junk" } })).status).toBe(401);
    const other = { authorization: `Bearer ${await jwt({ addr: OTHER })}` };
    const a = await call(`/v1/bookings/${bookingId}`, { headers: other });
    const b = await call(`/v1/bookings/0x${"77".repeat(32)}`, { headers: other });
    expect([a.status, await a.json()]).toEqual([403, { error: "forbidden" }]);
    expect([b.status, await b.json()]).toEqual([403, { error: "forbidden" }]);
    const wrongMail = { authorization: `Bearer ${await jwt({ email: "else@example.com" })}` };
    expect((await call(`/v1/bookings/${bookingId}`, { headers: wrongMail })).status).toBe(403);
  });

  it("cancel-preview follows the signed curve in chain time and returns cancelByGuest + claim", async () => {
    const { bookingId, quote } = await preparedBooking();
    const h = { authorization: `Bearer ${await jwt({ addr: GUEST })}` };
    clock = (quote.cutoffs[1]!.cutoffUtc - 1) * 1000; // 50% tier
    const r = v1.CancelPreviewResponse.parse(await (await post(`/v1/bookings/${bookingId}/cancel-preview`, {}, h)).json());
    expect(r).toMatchObject({ refundAtomic: "1600000000", refundBps: 5_000, guestYieldForfeitedAtomic: "1234" });
    const fns = r.calls.map((c) => decodeFunctionData({ abi: escrowAbi, data: c.data as Hex }).functionName);
    expect(fns).toEqual(["cancelByGuest", "claim"]);
    expect(r.calls.every((c) => c.to === ESCROW)).toBe(true);

    clock = quote.checkOutUtc * 1000;
    const late = await post(`/v1/bookings/${bookingId}/cancel-preview`, {}, h);
    expect([late.status, await late.json()]).toEqual([409, { error: "not_cancellable" }]);
  });

  it("cancel-preview 409s a settled booking and GET exposes claim calls when funds are claimable", async () => {
    const { bookingId } = await preparedBooking();
    const b = bookings.get(bookingId.toLowerCase())!;
    Object.assign(b, { state: "SETTLED", outcome: "CANCELLED_BY_GUEST", claimableAtomic: 5n });
    const h = { authorization: `Bearer ${await jwt({ addr: GUEST })}` };
    expect((await post(`/v1/bookings/${bookingId}/cancel-preview`, {}, h)).status).toBe(409);
    const view = v1.BookingResponse.parse(await (await call(`/v1/bookings/${bookingId}`, { headers: h })).json());
    expect(view.refundIfCancelledNowAtomic).toBe("0");
    expect(view.claimCalls.map((c) => decodeFunctionData({ abi: escrowAbi, data: c.data as Hex }).functionName)).toEqual(["claim"]);
  });
});

describe("yield terms", () => {
  it("estimates by offer with the live split, and by booking with its snapshotted split", async () => {
    const id = (await offer()).body.offerId as string;
    const r = v1.YieldTermsResponse.parse(await (await call(`/v1/yield/terms?offerId=${id}`)).json());
    const checkIn = Date.parse("2026-06-10T12:00:00Z") / 1000;
    expect(r.estimatedGuestYieldAtomic).toBe(estimateGuestYield(3_200_000_000n, checkIn, T0 / 1000, 400, 5_000).toString());
    expect(r).toMatchObject({ guestYieldBps: 5_000, apyEstimateBps: 400, vestingRule: "completed_stay_no_refund" });

    await db.query("TRUNCATE offers, holds, quotes CASCADE");
    const { bookingId } = await preparedBooking();
    bookings.get(bookingId.toLowerCase())!.guestYieldBps = 2_500;
    terms.guestYieldBps = 9_000; // a later change must not affect an existing booking
    const b = v1.YieldTermsResponse.parse(await (await call(`/v1/yield/terms?bookingId=${bookingId}`)).json());
    expect(b.guestYieldBps).toBe(2_500);
  });

  it("estimate: zero inside the lead time, rounds down, spec 8 formula", () => {
    const now = 1_000_000;
    expect(estimateGuestYield(10n ** 12n, now + 14 * 86_400, now, 400, 5_000)).toBe(0n);
    // 1,000 USDC, 4% APY, one year of window, 90% deployable, 50% share = 18 USDC
    expect(estimateGuestYield(1_000_000_000n, now + 14 * 86_400 + 365 * 86_400, now, 400, 5_000)).toBe(18_000_000n);
  });

  it("400s both/neither ids and 404s an unknown offer", async () => {
    expect((await call("/v1/yield/terms")).status).toBe(400);
    expect((await call(`/v1/yield/terms?offerId=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });
});

describe("OpenAPI", () => {
  it("serves the shared document without the stub header", async () => {
    const doc = (await (await call("/v1/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain("/v1/offers/{offerId}/prepare");
    expect(JSON.stringify(doc)).not.toContain("X-Stub-Scenario");
  });
});
