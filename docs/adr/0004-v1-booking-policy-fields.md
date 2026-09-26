# 0004: policy fields on the booking response

**Status:** Proposed by C0. Needs agent-workstream sign-off. Resolves review 0001 finding 10.
**Touches:** `BookingResponse` in the shared `/v1` schema.

## Context

The agent's `get_booking` tool (agent-spec-v1 section 6) returns "status, dates, policy, refund if
cancelled now". `GET /v1/bookings/{id}` has no policy field, so the agent could not restate the
policy a guest actually booked under.

## Decision

`GET /v1/bookings/{id}` adds `policyId`, `renderedPolicy` and `refundCurve`, with the same shapes as
`POST /v1/offers`. They describe the terms locked at deposit (spec 2, term locking), not the
property's current policy.

## Consequences

C5 and C6 must keep the rendered policy per `policyHash`, so an old booking still shows its own
text after the owner edits the policy.
