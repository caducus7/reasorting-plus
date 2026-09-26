# 0001: `/v1` wire formats and error bodies

**Status:** Proposed by C0. Needs project-owner and agent-workstream sign-off (spec 5.3).
**Touches:** `services/packages/shared/src/api/v1.ts` (shared `/v1` schema).

## Context

Spec 5.3 fixes the endpoints and field names, and says money is a string of atomic units. It does
not fix date formats, number vs string for non-money integers, or any error body except prepare's
two 409s. C0 had to choose, and C5 reuses the choices unchanged.

## Decision

| Thing | Format |
|---|---|
| Money (`*Atomic`) | Decimal string of USDC atomic units, `^(0\|[1-9][0-9]*)$` |
| `calls[].value` | Decimal string of wei (always `"0"`) |
| bps | JSON integer, 0 to 10000 |
| Request dates (`checkIn`, `checkOut`) | Property-local calendar date `YYYY-MM-DD` |
| `*Local` | ISO 8601 date-time in the property zone **with offset**, no milliseconds |
| `expiresAt` (offer, prepare), `asOf` | ISO 8601 UTC, `Z` suffix |
| `quote.*Utc`, `quote.expiresAt` | Unix seconds, JSON integer (uint40 fits in 2^53) |
| `quote.priceAtomic` | Decimal string (uint256) |
| `resourceId`, `bookingId`, `txHash`, hashes | `0x` + 64 hex |
| `refundCurve` | One point per cutoff, then a final point `{untilLocal: checkOutLocal, refundBps: finalBps}` |
| Response objects | Strict: unknown fields fail validation |

**Errors:** `{ "error": <code> }` with a fixed code list: `invalid_request`, `invalid_stay`,
`invalid_scenario` (stub only), `resource_not_found`, `offer_not_found`, `unauthorized`,
`forbidden`, `unavailable`, `terms_changed`, `not_cancellable`, `internal_error`. Cancel-preview on
a booking that can no longer be cancelled returns `409 not_cancellable` (the contract's
`NotCancellable`, spec 4.3).

**Stub marker:** each call from api-stub carries `"stub": true`. The field is optional in the
schema and C5 never sets it.

## Consequences

Clients parse money with `BigInt`, never `Number`. Adding an error code is a schema change.
