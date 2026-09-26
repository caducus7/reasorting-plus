// C0: stub of the `/v1` Service API (chain-spec.md 5.3). Returns deterministic fixtures, validated
// against the shared zod schemas before they leave the process. No chain, database or signing.

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { keccak256, concat, type Hex } from "viem";
import { z } from "zod";
import { refundAtomic, toAtomicString, v1 } from "@chain/shared";
import {
  approveCall,
  bookingIdOf,
  cancelByGuestCall,
  claimCall,
  depositCall,
  fakeTxHash,
} from "./chain.js";
import {
  BOOKING,
  OFFER_LOCK_SECONDS,
  POLICY_HASH,
  PROPERTY,
  QUOTE_TTL_SECONDS,
  RENDERED_POLICY,
  STUB_QUOTE_SIG,
  YIELD,
} from "./fixtures.js";
import { buildOpenApi } from "./openapi.js";
import { InvalidScenario, parseScenarios, SCENARIO_HEADER, SLOW_MS, type Scenario } from "./scenario.js";
import {
  estimateGuestYield,
  InvalidStay,
  isoLocal,
  isoUtc,
  materialiseStay,
  refundBpsAt,
  refundCurve,
  type Stay,
} from "./stay.js";

export type AppOptions = {
  /** Clock. Inject a fixed one in tests. */
  now?: () => Date;
  /** Latency for the `slow` scenario. Inject a spy in tests. */
  delay?: (ms: number) => Promise<void>;
};

type Env = { Variables: { scenarios: ReadonlySet<Scenario> } };
type Ctx = Context<Env>;

const OFFER_PREFIX = "off_";
const OfferKey = z.tuple([v1.LocalDate, v1.LocalDate, z.number().int().min(1).max(100)]);

/** Stateless offer ids: the offer's inputs, base64url-encoded. Deterministic and restart-safe. */
export function encodeOfferId(checkIn: string, checkOut: string, guests: number): string {
  return OFFER_PREFIX + Buffer.from(JSON.stringify([checkIn, checkOut, guests])).toString("base64url");
}

function decodeOfferId(offerId: string): z.infer<typeof OfferKey> | null {
  if (!offerId.startsWith(OFFER_PREFIX)) return null;
  try {
    const parsed = OfferKey.safeParse(JSON.parse(Buffer.from(offerId.slice(OFFER_PREFIX.length), "base64url").toString()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function send<S extends z.ZodType>(c: Ctx, schema: S, body: z.input<S>, status: ContentfulStatusCode = 200) {
  // Throws on a fixture that drifts from the schema: a stub bug must be a 500, never bad data.
  return c.json(schema.parse(body) as object, status);
}

function fail(c: Ctx, status: ContentfulStatusCode, error: v1.ErrorCode) {
  return send(c, v1.ErrorBody, { error }, status);
}

function unix(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/** `Authorization: Bearer stub-guest:<bookingId>` (C0 brief). */
function authorise(c: Ctx, bookingId: string): Response | null {
  const m = /^Bearer stub-guest:(0x[0-9a-fA-F]{64})$/.exec(c.req.header("authorization") ?? "");
  if (!m) return fail(c, 401, "unauthorized");
  if (m[1]!.toLowerCase() !== bookingId.toLowerCase()) return fail(c, 403, "forbidden");
  return null;
}

export function createApp(opts: AppOptions = {}): Hono<Env> {
  const now = opts.now ?? (() => new Date());
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const openApi = buildOpenApi();
  const app = new Hono<Env>();

  app.get("/v1/openapi.json", (c) => c.json(openApi));

  app.use("/v1/*", async (c, next) => {
    try {
      c.set("scenarios", parseScenarios(c.req.header(SCENARIO_HEADER)));
    } catch (e) {
      if (e instanceof InvalidScenario) return fail(c, 400, "invalid_scenario");
      throw e;
    }
    const s = c.get("scenarios");
    if (s.has("slow")) await delay(SLOW_MS);
    if (s.has("error")) return fail(c, 500, "internal_error");
    await next();
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "internal_error" }, 500);
  });
  app.notFound((c) => c.json({ error: "invalid_request" }, 404));

  // --- GET /v1/availability --------------------------------------------------------------------
  app.get("/v1/availability", (c) => {
    const q = v1.AvailabilityQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_request");
    let stay: Stay;
    try {
      stay = materialiseStay(q.data.checkIn, q.data.checkOut, now());
    } catch (e) {
      if (e instanceof InvalidStay) return fail(c, 400, "invalid_stay");
      throw e;
    }
    const items =
      q.data.guests > PROPERTY.maxGuests
        ? []
        : [
            {
              resourceId: PROPERTY.resourceId,
              name: PROPERTY.name,
              nights: stay.nights,
              priceAtomic: toAtomicString(stay.priceAtomic),
              policyId: PROPERTY.policyId,
            },
          ];
    return send(c, v1.AvailabilityResponse, items);
  });

  // --- POST /v1/offers -------------------------------------------------------------------------
  app.post("/v1/offers", async (c) => {
    const body = v1.OfferRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request");
    if (body.data.resourceId.toLowerCase() !== PROPERTY.resourceId) return fail(c, 404, "resource_not_found");
    if (body.data.guests > PROPERTY.maxGuests) return fail(c, 400, "invalid_stay");
    let stay: Stay;
    try {
      stay = materialiseStay(body.data.checkIn, body.data.checkOut, now());
    } catch (e) {
      if (e instanceof InvalidStay) return fail(c, 400, "invalid_stay");
      throw e;
    }
    return send(c, v1.OfferResponse, {
      offerId: encodeOfferId(body.data.checkIn, body.data.checkOut, body.data.guests),
      priceAtomic: toAtomicString(stay.priceAtomic),
      checkInLocal: isoLocal(stay.checkInLocal),
      checkOutLocal: isoLocal(stay.checkOutLocal),
      tz: PROPERTY.tz,
      policyId: PROPERTY.policyId,
      renderedPolicy: RENDERED_POLICY,
      refundCurve: refundCurve(stay),
      expiresAt: isoUtc(unix(now()) + OFFER_LOCK_SECONDS),
    });
  });

  // --- POST /v1/offers/{offerId}/prepare -------------------------------------------------------
  app.post("/v1/offers/:offerId/prepare", async (c) => {
    const key = decodeOfferId(c.req.param("offerId"));
    if (!key) return fail(c, 404, "offer_not_found");
    const body = v1.PrepareRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) return fail(c, 400, "invalid_request");

    const s = c.get("scenarios");
    if (s.has("unavailable")) return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
    if (s.has("terms_changed")) return send(c, v1.PrepareConflict, { error: "terms_changed" }, 409);

    let stay: Stay;
    try {
      stay = materialiseStay(key[0], key[1], now());
    } catch (e) {
      // The stay was valid when offered; arrival has since passed.
      if (e instanceof InvalidStay) return send(c, v1.PrepareConflict, { error: "unavailable" }, 409);
      throw e;
    }

    const guest = body.data.guestAddress;
    const expiresAt = unix(now()) + QUOTE_TTL_SECONDS;
    const quote: v1.Quote = {
      resourceId: PROPERTY.resourceId,
      checkInUtc: stay.checkInUtc,
      checkOutUtc: stay.checkOutUtc,
      priceAtomic: toAtomicString(stay.priceAtomic),
      feeBps: PROPERTY.feeBps,
      guestYieldBps: PROPERTY.guestYieldBps,
      policyHash: POLICY_HASH,
      cutoffs: stay.cutoffs.map(({ cutoffUtc, refundBps }) => ({ cutoffUtc, refundBps })),
      finalBps: stay.finalBps,
      guest,
      expiresAt,
      salt: keccak256(concat([PROPERTY.resourceId, guest.toLowerCase() as Hex, keccak256(Buffer.from(c.req.param("offerId")))])),
    };
    // The guest's email is accepted and discarded: the stub stores nothing (spec 5.2).
    return send(c, v1.PrepareResponse, {
      bookingId: bookingIdOf(quote),
      quote,
      quoteSig: STUB_QUOTE_SIG,
      calls: [approveCall(stay.priceAtomic), depositCall(quote, STUB_QUOTE_SIG)],
      expiresAt: isoUtc(expiresAt),
    });
  });

  // --- Booking fixture ------------------------------------------------------------------------
  const bookingStay = () => materialiseStay(BOOKING.checkIn, BOOKING.checkOut, new Date(0));

  // --- GET /v1/bookings/{bookingId} ------------------------------------------------------------
  app.get("/v1/bookings/:bookingId", (c) => {
    const bookingId = c.req.param("bookingId");
    const denied = authorise(c, bookingId);
    if (denied) return denied;
    if (!v1.Bytes32.safeParse(bookingId).success) return fail(c, 400, "invalid_request");

    const s = c.get("scenarios");
    const stay = bookingStay();
    const t = now();
    const base = {
      checkInLocal: isoLocal(stay.checkInLocal),
      checkOutLocal: isoLocal(stay.checkOutLocal),
      priceAtomic: toAtomicString(stay.priceAtomic),
      guestYieldBps: PROPERTY.guestYieldBps,
      txHash: fakeTxHash(bookingId as Hex),
      policyId: PROPERTY.policyId,
      renderedPolicy: RENDERED_POLICY,
      refundCurve: refundCurve(stay),
    };

    if (s.has("cancelled")) {
      const refund = refundAtomic(stay.priceAtomic, BOOKING.cancelledRefundBps);
      return send(c, v1.BookingResponse, {
        ...base,
        state: "SETTLED",
        outcome: "CANCELLED_BY_GUEST",
        refundIfCancelledNowAtomic: "0",
        accruedYieldAtomic: "0", // forfeited: guest share does not vest on cancellation (D3)
        claimableAtomic: toAtomicString(refund),
        claimCalls: [claimCall()],
      });
    }
    if (s.has("settled")) {
      const y = s.has("yield_zero") ? 0n : BOOKING.settledGuestYieldAtomic;
      return send(c, v1.BookingResponse, {
        ...base,
        state: "SETTLED",
        outcome: "COMPLETED",
        refundIfCancelledNowAtomic: "0",
        accruedYieldAtomic: toAtomicString(y),
        claimableAtomic: toAtomicString(y),
        claimCalls: y > 0n ? [claimCall()] : [],
      });
    }
    const bps = refundBpsAt(stay, t);
    return send(c, v1.BookingResponse, {
      ...base,
      state: bps === null ? "DELIVERED" : "ESCROWED",
      outcome: null,
      refundIfCancelledNowAtomic: toAtomicString(bps === null ? 0n : refundAtomic(stay.priceAtomic, bps)),
      accruedYieldAtomic: toAtomicString(s.has("yield_zero") ? 0n : BOOKING.accruedGuestYieldAtomic),
      claimableAtomic: "0",
      claimCalls: [],
    });
  });

  // --- POST /v1/bookings/{bookingId}/cancel-preview --------------------------------------------
  app.post("/v1/bookings/:bookingId/cancel-preview", (c) => {
    const bookingId = c.req.param("bookingId");
    const denied = authorise(c, bookingId);
    if (denied) return denied;
    if (!v1.Bytes32.safeParse(bookingId).success) return fail(c, 400, "invalid_request");

    const s = c.get("scenarios");
    const stay = bookingStay();
    const bps = refundBpsAt(stay, now());
    if (s.has("cancelled") || s.has("settled") || bps === null) return fail(c, 409, "not_cancellable");
    return send(c, v1.CancelPreviewResponse, {
      refundAtomic: toAtomicString(refundAtomic(stay.priceAtomic, bps)),
      refundBps: bps,
      guestYieldForfeitedAtomic: toAtomicString(s.has("yield_zero") ? 0n : BOOKING.accruedGuestYieldAtomic),
      calls: [cancelByGuestCall(bookingId as Hex), claimCall()],
    });
  });

  // --- GET /v1/yield/terms?offerId|bookingId ---------------------------------------------------
  app.get("/v1/yield/terms", (c) => {
    const q = v1.YieldTermsQuery.safeParse(c.req.query());
    if (!q.success) return fail(c, 400, "invalid_request");
    const t = now();
    let stay: Stay;
    if (q.data.offerId !== undefined) {
      const key = decodeOfferId(q.data.offerId);
      if (!key) return fail(c, 404, "offer_not_found");
      try {
        stay = materialiseStay(key[0], key[1], t);
      } catch (e) {
        if (e instanceof InvalidStay) return fail(c, 400, "invalid_stay");
        throw e;
      }
    } else {
      stay = bookingStay();
    }
    return send(c, v1.YieldTermsResponse, {
      guestYieldBps: PROPERTY.guestYieldBps,
      vestingRule: YIELD.vestingRule,
      apyEstimateBps: YIELD.apyEstimateBps,
      estimatedGuestYieldAtomic: toAtomicString(
        estimateGuestYield(stay, t, YIELD.apyEstimateBps, PROPERTY.guestYieldBps),
      ),
      protocol: YIELD.protocol,
      asOf: isoUtc(unix(t)),
    });
  });

  return app;
}
