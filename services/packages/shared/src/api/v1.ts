// `/v1` Service API schemas (chain-spec.md section 5.3).
//
// These are the source of truth for the API. C0 (api-stub) and C5 (quote-service) both use them
// unchanged. Any change needs an ADR in docs/adr/ and sign-off from both workstreams.
// Fields beyond spec 5.3 are marked with the ADR that added them.
//
// Response objects are strict: an unknown field fails validation, so nothing can be invented
// silently.

import { z } from "zod";
import { ATOMIC_STRING_RE } from "../money.js";

// ---------------------------------------------------------------------------------------------
// Primitives (formats fixed by ADR 0001)

export const AtomicAmount = z
  .string()
  .regex(ATOMIC_STRING_RE)
  .describe("USDC atomic units (6 decimals) as a decimal string");

/** Native-token amount in wei, as a decimal string. Always "0" for the calls in this API. */
export const WeiAmount = z.string().regex(ATOMIC_STRING_RE).describe("Wei as a decimal string");

export const Bps = z.number().int().min(0).max(10_000).describe("Basis points, 10000 = 100%");

export const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("32-byte hex");
export const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("EVM address");
export const HexData = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).describe("Hex-encoded bytes");

/** Unix seconds as used on-chain (uint40). Safe as a JSON number. */
export const UnixSeconds = z.number().int().min(0).max(2 ** 40 - 1);

/** Calendar date in the property's time zone, YYYY-MM-DD. */
export const LocalDate = z.iso.date();

/** ISO 8601 date-time in the property's zone, with explicit offset (e.g. +03:00). */
export const LocalDateTime = z.iso.datetime({ offset: true, local: false });

/** ISO 8601 UTC instant, e.g. 2026-09-26T12:00:00Z. */
export const UtcDateTime = z.iso.datetime();

export const OfferId = z.string().min(1).max(512);
export const PolicyId = z.string().min(1).max(128);
export const SessionId = z.string().min(1).max(256);

// ---------------------------------------------------------------------------------------------
// Errors (ADR 0001). Spec 5.3 defines only the two 409 prepare bodies; the rest are needed to
// answer malformed or unauthorised requests at all.

export const ErrorCode = z.enum([
  "invalid_request",
  "invalid_stay",
  "invalid_scenario",
  "resource_not_found",
  "offer_not_found",
  "unauthorized",
  "forbidden",
  "unavailable", // spec 5.3
  "terms_changed", // spec 5.3
  "not_cancellable",
  "internal_error",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z.strictObject({ error: ErrorCode });
export type ErrorBody = z.infer<typeof ErrorBody>;

export const PrepareConflict = z.strictObject({ error: z.enum(["unavailable", "terms_changed"]) });

// ---------------------------------------------------------------------------------------------
// Shared shapes

/** One contract call for the guest's wallet to submit, in order. */
export const Call = z.strictObject({
  to: Address,
  data: HexData,
  value: WeiAmount,
  /** Present and true only on api-stub responses: fake addresses and calldata. Never submit. */
  stub: z.literal(true).optional(),
});
export type Call = z.infer<typeof Call>;

export const RefundCurvePoint = z.strictObject({
  untilLocal: LocalDateTime,
  refundBps: Bps,
});

/** On-chain Quote struct (spec 4.1), JSON form. uint256 as decimal string, uint40/uint16 as numbers. */
export const Cutoff = z.strictObject({ cutoffUtc: UnixSeconds, refundBps: Bps });

export const Quote = z.strictObject({
  resourceId: Bytes32,
  checkInUtc: UnixSeconds,
  checkOutUtc: UnixSeconds,
  priceAtomic: AtomicAmount,
  feeBps: Bps,
  guestYieldBps: Bps,
  policyHash: Bytes32,
  cutoffs: z.array(Cutoff).min(1).max(8),
  finalBps: Bps,
  guest: Address,
  expiresAt: UnixSeconds,
  salt: Bytes32,
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------------------------------------
// GET /v1/availability?checkIn&checkOut&guests

export const AvailabilityQuery = z.strictObject({
  checkIn: LocalDate,
  checkOut: LocalDate,
  guests: z.coerce.number().int().min(1).max(100),
});

export const AvailabilityItem = z.strictObject({
  resourceId: Bytes32,
  name: z.string(),
  nights: z.number().int().min(1),
  priceAtomic: AtomicAmount,
  policyId: PolicyId,
});
export const AvailabilityResponse = z.array(AvailabilityItem);

// ---------------------------------------------------------------------------------------------
// POST /v1/offers

export const OfferRequest = z.strictObject({
  resourceId: Bytes32,
  checkIn: LocalDate,
  checkOut: LocalDate,
  guests: z.number().int().min(1).max(100),
  locale: z.string().min(2).max(35).describe("BCP 47 language tag"),
  sessionId: SessionId.optional(),
});

export const OfferResponse = z.strictObject({
  offerId: OfferId,
  priceAtomic: AtomicAmount,
  checkInLocal: LocalDateTime,
  checkOutLocal: LocalDateTime,
  tz: z.string().describe("IANA time zone of the property"),
  policyId: PolicyId,
  renderedPolicy: z.string(),
  refundCurve: z.array(RefundCurvePoint).min(1),
  expiresAt: UtcDateTime,
});

// ---------------------------------------------------------------------------------------------
// POST /v1/offers/{offerId}/prepare

export const PrepareRequest = z.strictObject({
  guestAddress: Address,
  email: z.email(),
  sessionId: SessionId.optional(),
});

export const PrepareResponse = z.strictObject({
  bookingId: Bytes32,
  quote: Quote,
  quoteSig: HexData,
  calls: z.array(Call).min(1),
  expiresAt: UtcDateTime,
});

// ---------------------------------------------------------------------------------------------
// GET /v1/bookings/{bookingId}   (guest auth)

/** Contract booking state (spec 3.5), DELIVERED derived from time. ADR 0002. */
export const BookingState = z.enum(["ESCROWED", "FROZEN", "DELIVERED", "DISPUTED", "SETTLED"]);

/** How a SETTLED booking ended; null while not settled. ADR 0002. */
export const BookingOutcome = z.enum([
  "COMPLETED",
  "CANCELLED_BY_GUEST",
  "CANCELLED_BY_PROPERTY",
  "DISPUTE_RESOLVED",
]);

export const BookingResponse = z.strictObject({
  state: BookingState,
  checkInLocal: LocalDateTime,
  checkOutLocal: LocalDateTime,
  priceAtomic: AtomicAmount,
  refundIfCancelledNowAtomic: AtomicAmount,
  /** Guest's share of yield accrued on this booking so far; vests only on a completed stay. */
  accruedYieldAtomic: AtomicAmount,
  guestYieldBps: Bps,
  txHash: Bytes32,
  outcome: BookingOutcome.nullable(), // ADR 0002
  policyId: PolicyId, // ADR 0004
  renderedPolicy: z.string(), // ADR 0004
  refundCurve: z.array(RefundCurvePoint).min(1), // ADR 0004
  claimableAtomic: AtomicAmount, // ADR 0003
  claimCalls: z.array(Call), // ADR 0003; empty when nothing is claimable
});

export const BookingIdParam = z.strictObject({ bookingId: Bytes32 });

// ---------------------------------------------------------------------------------------------
// POST /v1/bookings/{bookingId}/cancel-preview   (guest auth)

export const CancelPreviewResponse = z.strictObject({
  refundAtomic: AtomicAmount,
  refundBps: Bps,
  guestYieldForfeitedAtomic: AtomicAmount,
  /** cancelByGuest then claim (ADR 0003). */
  calls: z.array(Call).min(1),
});

// ---------------------------------------------------------------------------------------------
// GET /v1/yield/terms?offerId|bookingId

export const YieldTermsQuery = z
  .strictObject({ offerId: OfferId.optional(), bookingId: Bytes32.optional() })
  .refine((q) => (q.offerId === undefined) !== (q.bookingId === undefined), {
    message: "exactly one of offerId or bookingId",
  });

export const VestingRule = z.enum(["completed_stay_no_refund"]);

export const YieldTermsResponse = z.strictObject({
  guestYieldBps: Bps,
  vestingRule: VestingRule,
  apyEstimateBps: z.number().int().min(0),
  /** Always an estimate (spec 5.3). */
  estimatedGuestYieldAtomic: AtomicAmount,
  protocol: z.string(),
  asOf: UtcDateTime,
});

// ---------------------------------------------------------------------------------------------

export type AvailabilityQuery = z.infer<typeof AvailabilityQuery>;
export type AvailabilityResponse = z.infer<typeof AvailabilityResponse>;
export type OfferRequest = z.infer<typeof OfferRequest>;
export type OfferResponse = z.infer<typeof OfferResponse>;
export type PrepareRequest = z.infer<typeof PrepareRequest>;
export type PrepareResponse = z.infer<typeof PrepareResponse>;
export type BookingState = z.infer<typeof BookingState>;
export type BookingOutcome = z.infer<typeof BookingOutcome>;
export type BookingResponse = z.infer<typeof BookingResponse>;
export type CancelPreviewResponse = z.infer<typeof CancelPreviewResponse>;
export type YieldTermsQuery = z.infer<typeof YieldTermsQuery>;
export type YieldTermsResponse = z.infer<typeof YieldTermsResponse>;
