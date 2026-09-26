# api-stub (C0)

Stub of the `/v1` Service API in `docs/chain-spec.md` section 5.3. It returns deterministic
fixtures for one villa, with no chain, database or signing behind it. The agent workstream builds
against it until C5 replaces it.

**Run (Docker, from `services/`):**

```
docker build -f apps/api-stub/Dockerfile -t chain/api-stub . && docker run --rm -p 8080:8080 chain/api-stub
```

Base URL: `http://localhost:8080/v1`. OpenAPI: `http://localhost:8080/v1/openapi.json`.

To build behind a TLS-intercepting proxy, add `--secret id=ca,src=/path/to/ca-bundle.crt` to
`docker build`. The CA is used for the install step only and is not written into the image.

**Run (local):** `pnpm install && pnpm -r build && pnpm --filter api-stub start` (from `services/`).
Set `PORT` and `HOST` to override `8080` and `0.0.0.0`.

**Test:** `pnpm --filter api-stub test` (typecheck, then vitest).

## Fixtures

| | |
|---|---|
| Resource | `Stub Villa (Crete)`, `resourceId` = `keccak256("stub:villa:crete:1")`, up to 8 guests |
| Price | 800 USDC per night (`800000000` atomic) |
| Times | Check-in 15:00, check-out 11:00, `Europe/Athens` |
| Policy | 100% until 18:00 local 30 days before arrival, 50% until 14 days before, 25% until 7 days before, then 0% (`refundCurve` has these three cutoffs plus a final point at check-out) |
| Terms | `feeBps` 500 (only inside `quote` at prepare), `guestYieldBps` 5000, APY estimate 418 bps |
| Booking | Every `bookingId` resolves to the same 7-night stay, 2027-07-10 to 2027-07-17, 5,600 USDC |
| Contracts | USDC `0x1111…1111`, escrow `0x2222…2222`, signature `0x5b…5b1b`. All fake. Every call carries `"stub": true`: **never submit** |

Stay dates are property-local `YYYY-MM-DD`. The stub accepts 1 to 60 nights with check-in in the
future. Offer ids are opaque: treat them as strings.

## Auth

Guest endpoints accept `Authorization: Bearer stub-guest:<bookingId>`. No token gives 401; a token
for another booking gives 403. The real API takes a JWT from the checkout backend (D7).

## Scenarios

Send `x-stub-scenario: <name>[,<name>...]` on any `/v1` request except `openapi.json`.

| Name | Effect |
|---|---|
| `unavailable` | prepare returns `409 {"error":"unavailable"}` |
| `terms_changed` | prepare returns `409 {"error":"terms_changed"}` |
| `slow` | 2 s latency on every endpoint |
| `error` | `500 {"error":"internal_error"}` on every endpoint |
| `cancelled` | booking `SETTLED` / `CANCELLED_BY_GUEST`, 50% refund claimable, yield forfeited; cancel-preview returns 409 `not_cancellable` |
| `settled` | booking `SETTLED` / `COMPLETED`, vested guest yield claimable; cancel-preview returns 409 |
| `yield_zero` | no yield accrued, forfeited or claimable |

`cancelled` with `settled`, or `unavailable` with `terms_changed`, returns `400 invalid_scenario`,
as does any unknown name.

## Beyond spec 5.3

`GET /v1/bookings/{id}` also returns `outcome`, `policyId`, `renderedPolicy`, `refundCurve`,
`claimableAtomic` and `claimCalls`, and cancel-preview's `calls` are `cancelByGuest` then `claim`.
Error bodies use a fixed code list. See `docs/adr/0001` to `0004`. **These changes are pending
agent-workstream sign-off.**
