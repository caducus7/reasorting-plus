// C5: the /v1 Service API (chain-spec.md 5.3) backed by real policy materialisation, Postgres holds,
// live chain terms and EIP-712 signing. Request and response shapes are the C0 zod schemas,
// unchanged; every response is validated before it leaves the process.

import { randomBytes, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { encodeFunctionData, erc20Abi, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { z } from "zod";
import { escrowAbi } from "@chain/abi";
import { refundBpsAt, refundOf, toAtomicString, v1 } from "@chain/shared";
import { buildOpenApi } from "@chain/shared/api/openapi";
import { bookingIdOf, quoteTypedData } from "@chain/shared/eip712";
import { owns, type GuestAuth, type GuestClaims } from "./auth.js";
import type { EscrowReader } from "./chain.js";
import {
  bookingEmail,
  createOfferWithHold,
  getOffer,
  holdIsLive,
  awaitingHoldOfOffer,
  awaitingHolds,
  releaseAwaitingHold,
  type AwaitingHold,
  liveQuoteForOffer,
  recordQuote,
  SlotTaken,
  slotHeldByOther,
  type CalendarPort,
  type Db,
} from "./db.js";
import { InvalidPolicy, InvalidStay, isoLocal, isoUtc, materialiseStay, refundCurve, type Property, type Stay } from "./property.js";
import type { BookingReadModel, BookingView } from "./readModel.js";
import type { QuoteSigner } from "./signer.js";
import { DateTime } from "luxon";

export type Settings = {
  chainId: number;
  escrow: Address;
  usdc: Address;
  offerLockSec: number; // spec 5.2: 25 minutes
  quoteTtlSec: number; // prepared quote lifetime (docs/adr/0012)
  feedMaxAgeSec: number; // fail closed beyond this (docs/adr/0012)
  maxClockSkewSec: number; // chain time vs server clock; holds use one, quotes the other
  apyEstimateBps: number;
  yieldProtocol: string;
};

export type Deps = {
  db: Db;
  calendar: CalendarPort;
  chain: EscrowReader;
  signer: QuoteSigner;
  bookings: BookingReadModel;
  auth: GuestAuth;
  properties: Property[];
  settings: Settings;
  /** Server clock, for offers and availability. Quotes use chain time. */
  now?: () => Date;
};

type Ctx = Context;

function send<S extends z.ZodType>(c: Ctx, schema: S, body: z.input<S>, status: ContentfulStatusCode = 200) {
  return c.json(schema.parse(body) as object, status);
}

function fail(c: Ctx, status: ContentfulStatusCode, error: v1.ErrorCode) {
  return send(c, v1.ErrorBody, { error }, status);
}

const MIN_LEAD_TIME_SEC = 14n * 86_400n; // spec 6.7 / 8
const MAX_DEPLOY_BPS = 9_000n; // spec 6.3 / 8
const YEAR_SEC = 365n * 86_400n;

/** Spec 8: estimated guest yield over the deployment window, every step rounded down. */
export function estimateGuestYield(price: bigint, checkInUtc: number, nowUtc: number, apyBps: number, guestYieldBps: number): bigint {
  const window = BigInt(checkInUtc) - MIN_LEAD_TIME_SEC - BigInt(nowUtc);
  if (window <= 0n) return 0n;
  const gross = (price * BigInt(apyBps) * window * MAX_DEPLOY_BPS) / (10_000n * YEAR_SEC * 10_000n);
  return (gross * BigInt(guestYieldBps)) / 10_000n;
}

export function policyHashOf(rendered: string): Hex {
  return keccak256(stringToHex(rendered));
}

export function createApp(d: Deps): Hono {
  const now = d.now ?? (() => new Date());
  const s = d.settings;
  const byResource = new Map(d.properties.map((p) => [p.resourceId.toLowerCase(), p]));
  const openApi = buildOpenApi({
    title: "Direct booking Service API",
    description: "chain-spec.md section 5.3. Money fields are USDC atomic units as decimal strings.",
  });
  const app = new Hono();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => c.json({ error: "invalid_request" }, 404));
  app.get("/v1/openapi.json", (c) => c.json(openApi));

  const unixNow = () => Math.floor(now().getTime() / 1000);
  const materialise = (p: Property, checkIn: string, checkOut: string, nowUtc: number): Stay | "invalid" => {
    try {
      return materialiseStay(p, checkIn, checkOut, nowUtc);
    } catch (e) {
      if (e instanceof InvalidStay || e instanceof InvalidPolicy) return "invalid";
      throw e;
    }
  };

  /**
   * Ends an awaiting-payment hold only on proof (docs/adr/0012 §3), like a Stripe Checkout Session
   * that ends on the provider's authoritative state rather than a local timer:
   *  - handed over: the deposit is at the safe head and the indexer projected it into calendar_blocks;
   *  - unpaid: the chain's safe head is past the quote's expiry (the escrow rejects an expired quote
   *    for good) and the booking does not exist at that block.
   * Otherwise the hold stays, however long the indexer or the chain takes.
   */
  async function resolveHold(h: AwaitingHold): Promise<"handed-over" | "unpaid" | "pending"> {
    try {
      const head = await d.chain.safeHead();
      const paid = await d.chain.bookingExistsAt(h.booking_id as Hex, head.number);
      // Handed over only once the deposit is past reorg (safe head): if C6 projected it at the
      // unsafe head and it were reorged away, the still-valid quote could be paid again.
      if (paid && (await d.calendar.hasEscrowBooking(h.resource_id, h.booking_id))) {
        await releaseAwaitingHold(d.db, h);
        return "handed-over";
      }
      if (!paid && head.timestamp > h.until) {
        await releaseAwaitingHold(d.db, h);
        return "unpaid";
      }
    } catch (e) {
      // No proof without the chain: the hold stays (fail closed), and the endpoint still answers.
      console.error("hold resolution: chain read failed", e);
    }
    return "pending";
  }

  async function resolveSlot(resourceId: string, checkIn: string, checkOut: string) {
    for (const h of await awaitingHolds(d.db, resourceId, checkIn, checkOut)) await resolveHold(h);
  }

  async function available(p: Property, checkIn: string, checkOut: string, exceptOffer: string | null) {
    await resolveSlot(p.resourceId, checkIn, checkOut);
    if (await d.calendar.isBusy(p.resourceId, checkIn, checkOut)) return false;
    return !(await slotHeldByOther(d.db, p.resourceId, checkIn, checkOut, now(), exceptOffer));
  }

  async function rememberPolicy(p: Property): Promise<Hex> {
    const hash = policyHashOf(p.policy.rendered);
    await d.db.query(
      "INSERT INTO policies (policy_hash, policy_id, rendered) VALUES ($1, $2, $3) ON CONFLICT (policy_hash) DO NOTHING",
      [hash, p.policy.id, p.policy.rendered],
    );
    return hash;
  }

  // ---------------------------------------------------------------- GET /v1/availability
  app.get("/v1/availability", async (c) => {
    const q = v1.AvailabilityQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_request");
    const items = [];
    let valid = 0;
    for (const p of d.properties) {
      // Per-property night limits: a stay invalid for one property just omits it; 400 only when
      // the stay is invalid for every property (e.g. check-out before check-in, or in the past).
      const stay = materialise(p, q.data.checkIn, q.data.checkOut, unixNow());
      if (stay === "invalid") continue;
      valid++;
      if (q.data.guests > p.maxGuests) continue;
      if (!(await available(p, q.data.checkIn, q.data.checkOut, null))) continue;
      items.push({ resourceId: p.resourceId, name: p.name, nights: stay.nights, priceAtomic: toAtomicString(stay.priceAtomic), policyId: p.policy.id });
    }
    if (valid === 0) return fail(c, 400, "invalid_stay");
    return send(c, v1.AvailabilityResponse, items);
  });

  // ---------------------------------------------------------------- POST /v1/offers
  app.post("/v1/offers", async (c) => {
    const body = v1.OfferRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request");
    const p = byResource.get(body.data.resourceId.toLowerCase());
    if (!p) return fail(c, 404, "resource_not_found");
    if (body.data.guests > p.maxGuests) return fail(c, 400, "invalid_stay");
    const stay = materialise(p, body.data.checkIn, body.data.checkOut, unixNow());
    if (stay === "invalid") return fail(c, 400, "invalid_stay");
    await resolveSlot(p.resourceId, stay.checkIn, stay.checkOut);
    if (await d.calendar.isBusy(p.resourceId, stay.checkIn, stay.checkOut)) return fail(c, 409, "unavailable");

    const offerId = randomUUID();
    const t = now();
    const expiresAt = new Date(t.getTime() + s.offerLockSec * 1000);
    try {
      await createOfferWithHold(d.db, {
        offer_id: offerId,
        chain_id: s.chainId,
        escrow: s.escrow.toLowerCase(),
        resource_id: p.resourceId,
        check_in: stay.checkIn,
        check_out: stay.checkOut,
        guests: body.data.guests,
        price_atomic: toAtomicString(stay.priceAtomic),
        policy_id: p.policy.id,
        session_id: body.data.sessionId ?? null,
        now: t,
        expiresAt,
      });
    } catch (e) {
      if (e instanceof SlotTaken) return fail(c, 409, "unavailable");
      throw e;
    }
    await rememberPolicy(p);
    return send(c, v1.OfferResponse, {
      offerId,
      priceAtomic: toAtomicString(stay.priceAtomic),
      checkInLocal: isoLocal(stay.checkInLocal),
      checkOutLocal: isoLocal(stay.checkOutLocal),
      tz: p.tz,
      policyId: p.policy.id,
      renderedPolicy: p.policy.rendered,
      refundCurve: refundCurve(stay),
      expiresAt: isoUtc(Math.floor(expiresAt.getTime() / 1000)),
    });
  });

  // ---------------------------------------------------------------- POST /v1/offers/{id}/prepare
  app.post("/v1/offers/:offerId/prepare", async (c) => {
    const offerId = c.req.param("offerId");
    if (!z.uuid().safeParse(offerId).success) return fail(c, 404, "offer_not_found");
    const offer = await getOffer(d.db, offerId);
    if (!offer || offer.chain_id !== s.chainId || offer.escrow !== s.escrow.toLowerCase()) {
      return fail(c, 404, "offer_not_found");
    }
    const body = v1.PrepareRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request");
    const p = byResource.get(offer.resource_id.toLowerCase());
    if (!p) return fail(c, 404, "offer_not_found");
    const guest = body.data.guestAddress as Address;
    const t = now();

    // One live quote per hold: re-preparing returns it to the same guest; anyone else waits.
    const live = await liveQuoteForOffer(d.db, offerId, t);
    if (live) {
      if (live.guest !== guest.toLowerCase()) return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
      return respondPrepared(c, live.booking_id as Hex, live.quote as v1.Quote, live.quote_sig as Hex, live.expires_at);
    }
    // The offer's quote has expired. The offer ends only once that quote is proven unpaid (then the
    // guest takes a fresh offer); until then no replacement is signed, so no one can pay twice.
    const quoted = await awaitingHoldOfOffer(d.db, offerId);
    if (quoted) {
      const outcome = await resolveHold(quoted);
      return send(c, v1.PrepareConflict, { error: outcome === "unpaid" ? "terms_changed" : "unavailable" }, 409);
    }
    // The 25-minute price lock has lapsed: the guest must take a fresh offer (docs/adr/0012).
    if (!(await holdIsLive(d.db, offerId, t))) return send(c, v1.PrepareConflict, { error: "terms_changed" }, 409);

    // Re-check availability against every calendar source, and fail closed on stale feeds.
    if (!(await available(p, offer.check_in, offer.check_out, offerId))) {
      return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    }
    if ((await d.calendar.staleFeeds(p.resourceId, t, s.feedMaxAgeSec)).length > 0) {
      return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    }

    // Live terms at the latest block; all expiry maths in chain time.
    const live2 = await d.chain.liveTerms();
    if (live2.quoteSigner.toLowerCase() !== d.signer.address.toLowerCase()) {
      throw new Error(`escrow quoteSigner ${live2.quoteSigner} is not this service's signer ${d.signer.address}`);
    }
    if (live2.paused || live2.lossDebt !== 0n) return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    const price = BigInt(offer.price_atomic);
    if (live2.totalOpenPrincipal + price > live2.maxOpenPrincipalAtomic) {
      return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    }
    const chainNow = live2.blockTimestamp;
    // Quote expiry is chain time; hold and quote liveness in Postgres use the server clock. If they
    // disagree, holds could lapse before the quote does, so refuse to sign (fail closed).
    if (Math.abs(chainNow - Math.floor(t.getTime() / 1000)) > s.maxClockSkewSec) {
      throw new Error(`clock skew: chain ${chainNow} vs server ${t.toISOString()}`);
    }
    const stay = materialise(p, offer.check_in, offer.check_out, chainNow);
    if (stay === "invalid") return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    if (price < live2.minNightlyAtomic * BigInt(stay.nights)) {
      throw new Error(`offer price ${price} is below the escrow's floor for ${stay.nights} nights`);
    }

    // No quote may straddle a fee change (spec 5.2): cap expiry at pendingFeeAt - 60s while the
    // change is still in the future; inside the last minute, ask the client to retry.
    let expiresAt = chainNow + s.quoteTtlSec;
    if (live2.pendingFeeAt > chainNow) {
      const cap = live2.pendingFeeAt - 60;
      if (cap <= chainNow) return send(c, v1.PrepareConflict, { error: "terms_changed" }, 409);
      expiresAt = Math.min(expiresAt, cap);
    }

    const quote: v1.Quote = {
      resourceId: p.resourceId,
      checkInUtc: stay.checkInUtc,
      checkOutUtc: stay.checkOutUtc,
      priceAtomic: toAtomicString(price), // the price locked by the offer
      feeBps: live2.effectiveFeeBps,
      guestYieldBps: live2.guestYieldBps,
      policyHash: await rememberPolicy(p),
      cutoffs: stay.cutoffs.map(({ cutoffUtc, refundBps }) => ({ cutoffUtc, refundBps })),
      finalBps: stay.finalBps,
      guest,
      expiresAt,
      salt: toHex(randomBytes(32)),
    };
    const bookingId = bookingIdOf(quote);
    const quoteSig = await d.signer.signTypedData(quoteTypedData(quote, s.chainId, s.escrow) as never);
    const recorded = await recordQuote(d.db, {
      chainId: s.chainId,
      escrow: s.escrow,
      bookingId,
      offerId,
      guest,
      email: body.data.email,
      sessionId: body.data.sessionId ?? null,
      quote,
      quoteSig,
      expiresAt: new Date(expiresAt * 1000),
      expiresAtChain: expiresAt,
      now: t,
    });
    if (recorded === "conflict") return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    return respondPrepared(c, bookingId, quote, quoteSig, new Date(expiresAt * 1000));
  });

  function respondPrepared(c: Ctx, bookingId: Hex, quote: v1.Quote, quoteSig: Hex, expiresAt: Date) {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [s.escrow, BigInt(quote.priceAtomic)] });
    const typed = quoteTypedData(quote, s.chainId, s.escrow).message;
    const deposit = encodeFunctionData({ abi: escrowAbi, functionName: "deposit", args: [typed as never, quoteSig] });
    return send(c, v1.PrepareResponse, {
      bookingId,
      quote,
      quoteSig,
      calls: [
        { to: s.usdc, data: approve, value: "0" },
        { to: s.escrow, data: deposit, value: "0" },
      ],
      expiresAt: isoUtc(Math.floor(expiresAt.getTime() / 1000)),
    });
  }

  // ---------------------------------------------------------------- guest-authenticated reads
  async function authorised(c: Ctx, bookingId: string): Promise<{ booking: BookingView } | Response> {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "");
    if (!m) return fail(c, 401, "unauthorized");
    let claims: GuestClaims;
    try {
      claims = await d.auth.verify(m[1]!);
    } catch {
      return fail(c, 401, "unauthorized");
    }
    if (!v1.Bytes32.safeParse(bookingId).success) return fail(c, 400, "invalid_request");
    const booking = await d.bookings.getBooking(bookingId as Hex);
    // An unknown booking and someone else's booking look the same: never reveal existence.
    if (!booking) return fail(c, 403, "forbidden");
    const email = await bookingEmail(d.db, s.chainId, s.escrow, bookingId);
    if (!owns(claims, booking.guest, email)) return fail(c, 403, "forbidden");
    return { booking };
  }

  const zoneOf = (resourceId: Hex) => byResource.get(resourceId.toLowerCase())?.tz ?? "UTC";
  const local = (unix: number, tz: string) => isoLocal(DateTime.fromSeconds(unix, { zone: tz }));

  async function policyOf(bookingId: string): Promise<{ policyId: string; rendered: string }> {
    const r = await d.db.query(
      `SELECT p.policy_id, p.rendered FROM quotes q JOIN policies p ON p.policy_hash = q.quote->>'policyHash'
         WHERE q.chain_id = $1 AND q.escrow = $2 AND q.booking_id = $3`,
      [s.chainId, s.escrow.toLowerCase(), bookingId.toLowerCase()],
    );
    const row = r.rows[0] as { policy_id: string; rendered: string } | undefined;
    return row ? { policyId: row.policy_id, rendered: row.rendered } : { policyId: "unknown", rendered: "Policy terms are recorded on-chain with this booking." };
  }

  const claimCall = () => ({ to: s.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "claim" }), value: "0" });

  app.get("/v1/bookings/:bookingId", async (c) => {
    const bookingId = c.req.param("bookingId");
    const a = await authorised(c, bookingId);
    if (a instanceof Response) return a;
    const b = a.booking;
    const tz = zoneOf(b.resourceId);
    const chainNow = (await d.chain.liveTerms()).blockTimestamp;
    const bps = b.state === "ESCROWED" ? refundBpsAt(b, chainNow) : null;
    const policy = await policyOf(bookingId);
    return send(c, v1.BookingResponse, {
      state: b.state,
      checkInLocal: local(b.checkInUtc, tz),
      checkOutLocal: local(b.checkOutUtc, tz),
      priceAtomic: toAtomicString(b.principalAtomic),
      refundIfCancelledNowAtomic: toAtomicString(bps === null ? 0n : refundOf(b.principalAtomic, bps)),
      accruedYieldAtomic: toAtomicString(b.accruedGuestYieldAtomic),
      guestYieldBps: b.guestYieldBps,
      txHash: b.txHash,
      outcome: b.outcome,
      policyId: policy.policyId,
      renderedPolicy: policy.rendered,
      refundCurve: [
        ...b.cutoffs.map((x) => ({ untilLocal: local(x.cutoffUtc, tz), refundBps: x.refundBps })),
        { untilLocal: local(b.checkOutUtc, tz), refundBps: b.finalBps },
      ],
      claimableAtomic: toAtomicString(b.claimableAtomic),
      claimCalls: b.claimableAtomic > 0n ? [claimCall()] : [],
    });
  });

  app.post("/v1/bookings/:bookingId/cancel-preview", async (c) => {
    const bookingId = c.req.param("bookingId");
    const a = await authorised(c, bookingId);
    if (a instanceof Response) return a;
    const b = a.booking;
    const chainNow = (await d.chain.liveTerms()).blockTimestamp;
    const bps = b.state === "ESCROWED" ? refundBpsAt(b, chainNow) : null;
    if (bps === null) return fail(c, 409, "not_cancellable");
    return send(c, v1.CancelPreviewResponse, {
      refundAtomic: toAtomicString(refundOf(b.principalAtomic, bps)),
      refundBps: bps,
      guestYieldForfeitedAtomic: toAtomicString(b.accruedGuestYieldAtomic), // D3: forfeited on cancel
      calls: [
        { to: s.escrow, data: encodeFunctionData({ abi: escrowAbi, functionName: "cancelByGuest", args: [bookingId as Hex] }), value: "0" },
        claimCall(),
      ],
    });
  });

  // ---------------------------------------------------------------- GET /v1/yield/terms
  app.get("/v1/yield/terms", async (c) => {
    const q = v1.YieldTermsQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_request");
    const t = now();
    let price: bigint;
    let checkInUtc: number;
    let guestYieldBps: number;
    if (q.data.offerId !== undefined) {
      const offer = z.uuid().safeParse(q.data.offerId).success ? await getOffer(d.db, q.data.offerId) : null;
      const p = offer && byResource.get(offer.resource_id.toLowerCase());
      if (!offer || !p) return fail(c, 404, "offer_not_found");
      const stay = materialise(p, offer.check_in, offer.check_out, 0);
      if (stay === "invalid") return fail(c, 400, "invalid_stay");
      price = BigInt(offer.price_atomic);
      checkInUtc = stay.checkInUtc;
      guestYieldBps = (await d.chain.liveTerms()).guestYieldBps;
    } else {
      const b = await d.bookings.getBooking(q.data.bookingId as Hex);
      if (!b) return fail(c, 404, "offer_not_found");
      price = b.principalAtomic;
      checkInUtc = b.checkInUtc;
      guestYieldBps = b.guestYieldBps;
    }
    return send(c, v1.YieldTermsResponse, {
      guestYieldBps,
      vestingRule: "completed_stay_no_refund",
      apyEstimateBps: s.apyEstimateBps,
      estimatedGuestYieldAtomic: toAtomicString(
        estimateGuestYield(price, checkInUtc, Math.floor(t.getTime() / 1000), s.apyEstimateBps, guestYieldBps),
      ),
      protocol: s.yieldProtocol,
      asOf: isoUtc(Math.floor(t.getTime() / 1000)),
    });
  });

  return app;
}
