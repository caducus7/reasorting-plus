// OpenAPI 3.1 document for the /v1 Service API, generated from these zod schemas. Shared by the
// api-stub (C0) and the quote service (C5) so both serve the same contract.

import { z } from "zod";
import * as v1 from "./v1.js";

type JsonSchema = Record<string, unknown>;

function schema(s: z.ZodType, io: "input" | "output" = "output"): JsonSchema {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { target: "draft-2020-12", io }) as JsonSchema;
  return rest;
}

function json(s: z.ZodType, description: string) {
  return { description, content: { "application/json": { schema: schema(s) } } };
}

function queryParams(obj: z.ZodObject, required: boolean) {
  return Object.entries(obj.shape).map(([name, s]) => ({
    name,
    in: "query",
    required: required && !(s as z.ZodType).safeParse(undefined).success,
    schema: schema((s as z.ZodType), "output"),
  }));
}

const bookingIdParam = { name: "bookingId", in: "path", required: true, schema: schema(v1.Bytes32) };
const offerIdParam = { name: "offerId", in: "path", required: true, schema: schema(v1.OfferId) };
export type OpenApiOptions = {
  title: string;
  description: string;
  /** Extra header parameter on every operation (the stub's scenario switch). */
  header?: { name: string; description: string };
};

const err = (d: string) => json(v1.ErrorBody, d);
const common = { "400": err("Invalid request"), "500": err("Internal error") };
const guestAuth = [{ guestBearer: [] }];

export function buildOpenApi(opts: OpenApiOptions): JsonSchema {
  const extra = opts.header
    ? [{ name: opts.header.name, in: "header", required: false, description: opts.header.description, schema: { type: "string" } }]
    : [];
  return {
    openapi: "3.1.0",
    info: {
      title: opts.title,
      version: "1.0.0",
      description: opts.description,
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        guestBearer: {
          type: "http",
          scheme: "bearer",
          description: "JWT from the checkout backend (D7, docs/adr/0012). The api-stub accepts `stub-guest:<bookingId>`.",
        },
      },
    },
    paths: {
      "/v1/availability": {
        get: {
          operationId: "getAvailability",
          parameters: [...queryParams(v1.AvailabilityQuery, true), ...extra],
          responses: { "200": json(v1.AvailabilityResponse, "Bookable resources"), ...common },
        },
      },
      "/v1/offers": {
        post: {
          operationId: "createOffer",
          parameters: [...extra],
          requestBody: { required: true, content: { "application/json": { schema: schema(v1.OfferRequest, "input") } } },
          responses: {
            "200": json(v1.OfferResponse, "Unsigned offer with a 25-minute price lock"),
            "404": err("Unknown resource"),
            "409": err("Slot unavailable or held by another offer (docs/adr/0012)"),
            ...common,
          },
        },
      },
      "/v1/offers/{offerId}/prepare": {
        post: {
          operationId: "prepareOffer",
          parameters: [offerIdParam, ...extra],
          requestBody: { required: true, content: { "application/json": { schema: schema(v1.PrepareRequest, "input") } } },
          responses: {
            "200": json(v1.PrepareResponse, "Signed quote and the call bundle (approve, deposit)"),
            "404": err("Unknown offer"),
            "409": json(v1.PrepareConflict, "Slot no longer available, or terms changed: re-offer"),
            ...common,
          },
        },
      },
      "/v1/bookings/{bookingId}": {
        get: {
          operationId: "getBooking",
          security: guestAuth,
          parameters: [bookingIdParam, ...extra],
          responses: {
            "200": json(v1.BookingResponse, "Booking status"),
            "401": err("Missing or malformed guest token"),
            "403": err("Token is for another booking"),
            ...common,
          },
        },
      },
      "/v1/bookings/{bookingId}/cancel-preview": {
        post: {
          operationId: "cancelPreview",
          security: guestAuth,
          parameters: [bookingIdParam, ...extra],
          responses: {
            "200": json(v1.CancelPreviewResponse, "Refund if cancelled now, and the calls to do it"),
            "401": err("Missing or malformed guest token"),
            "403": err("Token is for another booking"),
            "409": err("Booking can no longer be cancelled"),
            ...common,
          },
        },
      },
      "/v1/yield/terms": {
        get: {
          operationId: "getYieldTerms",
          description: "Exactly one of offerId or bookingId.",
          parameters: [...queryParams(v1.YieldTermsQuery, false), ...extra],
          responses: {
            "200": json(v1.YieldTermsResponse, "Yield terms; figures are estimates"),
            "404": err("Unknown offer"),
            ...common,
          },
        },
      },
    },
  };
}
