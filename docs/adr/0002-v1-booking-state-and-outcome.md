# 0002: booking `state` enum and `outcome`

**Status:** Proposed by C0. Needs agent-workstream sign-off. Resolves review 0001 finding 7.
**Touches:** `BookingResponse` in the shared `/v1` schema.

## Context

`GET /v1/bookings/{id}` returns `state`, but spec 5.3 never lists its values. The contract states
(spec 3.5) are `ESCROWED`, `FROZEN`, `DELIVERED` (derived from time), `DISPUTED` and `SETTLED`. A
cancellation ends in `SETTLED`. The C0 brief nevertheless asks for distinct `cancelled` and
`settled` fixtures, and a guest or agent does need to tell a completed stay from a cancellation.

## Decision

- `state` is exactly the spec 3.5 state, upper-case: `ESCROWED | FROZEN | DELIVERED | DISPUTED | SETTLED`.
- A new field `outcome`, `null` unless `SETTLED`, records how the booking ended:
  `COMPLETED | CANCELLED_BY_GUEST | CANCELLED_BY_PROPERTY | DISPUTE_RESOLVED`.

This keeps `state` a faithful projection of the contract, which C6 can derive from events alone
(`BookingCancelled` names the canceller; `BookingSettled` and `DisputeResolved` are distinct
events).

## Alternatives rejected

A single enum with `CANCELLED`: this mixes contract state with history, and C6 would need a mapping
the contract does not have.
