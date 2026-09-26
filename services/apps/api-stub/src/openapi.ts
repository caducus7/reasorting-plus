// OpenAPI 3.1 document generated from the shared zod schemas, served at /v1/openapi.json.

import { z } from "zod";
import { v1 } from "@chain/shared";
import { SCENARIOS, SCENARIO_HEADER } from "./scenario.js";

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
const scenarioParam = {
  name: SCENARIO_HEADER,
  in: "header",
  required: false,
  description: `Stub only. Comma-separated: ${SCENARIOS.join(", ")}`,
  schema: { type: "string" },
};

const err = (d: string) => json(v1.ErrorBody, d);
const common = { "400": err("Invalid request or scenario"), "500": err("Stub error scenario") };
const guestAuth = [{ guestBearer: [] }];

export function buildOpenApi(): JsonSchema {
  return {
    openapi: "3.1.0",
    info: {
      title: "Direct booking Service API (stub)",
      version: "1.0.0",
      description:
        "chain-spec.md section 5.3. Served by api-stub (C0) with fixtures; calls carrying `stub: true` " +
        "have fake addresses and calldata. Money fields are USDC atomic units as decimal strings.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        guestBearer: {
          type: "http",
          scheme: "bearer",
          description: "Stub: `stub-guest:<bookingId>`. Real: JWT from the checkout backend (D7).",
        },
      },
    },
    paths: {
      "/v1/availability": {
        get: {
          operationId: "getAvailability",
          parameters: [...queryParams(v1.AvailabilityQuery, true), scenarioParam],
          responses: { "200": json(v1.AvailabilityResponse, "Bookable resources"), ...common },
        },
      },
      "/v1/offers": {
        post: {
          operationId: "createOffer",
          parameters: [scenarioParam],
          requestBody: { required: true, content: { "application/json": { schema: schema(v1.OfferRequest, "input") } } },
          responses: {
            "200": json(v1.OfferResponse, "Unsigned offer with a 25-minute price lock"),
            "404": err("Unknown resource"),
            ...common,
          },
        },
      },
      "/v1/offers/{offerId}/prepare": {
        post: {
          operationId: "prepareOffer",
          parameters: [offerIdParam, scenarioParam],
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
          parameters: [bookingIdParam, scenarioParam],
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
          parameters: [bookingIdParam, scenarioParam],
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
          parameters: [...queryParams(v1.YieldTermsQuery, false), scenarioParam],
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
