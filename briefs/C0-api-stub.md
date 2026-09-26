# C0: Stub Service API

**Read first:** `CLAUDE.md`; `docs/chain-spec.md` sections 5.3 and 11; `docs/agent-spec-v1.md`
sections 5 and 6 (to see how the API is consumed).
**Depends on:** nothing. **Deadline:** week 1. The agent workstream is blocked until this exists.

## Goal

A running HTTP service that implements the `/v1` Service API from spec 5.3 exactly, returning
deterministic fixtures, so the agent workstream can build the guest agent and checkout without any
contract or indexer existing.

## In scope

- `services/apps/api-stub/`, and the zod schemas for every request and response in
  `services/packages/shared/src/api/v1.ts`. **These schemas are the source of truth for the API
  and are reused unchanged by C5.**
- All six endpoints in spec 5.3, with realistic fixtures for the villa: one `resourceId`, a
  cancellation curve with three cutoffs, prices in atomic USDC as strings.
- Scenario switches via a request header `x-stub-scenario`, so the other workstream can test
  failure paths:
  `unavailable` (prepare returns 409 unavailable), `terms_changed` (409 terms_changed),
  `slow` (2s latency), `error` (500), `cancelled` and `settled` booking states,
  `yield_zero` (no yield accrued).
- A fake guest auth: accept any bearer token of the form `stub-guest:<bookingId>`.
- `calls` in the prepare response: a two-element bundle (USDC `approve`, escrow `deposit`) with
  plausible but clearly fake calldata and addresses, flagged `"stub": true`.
- An OpenAPI document generated from the zod schemas, served at `/v1/openapi.json`.
- A Dockerfile and a one-line run command in the app README.

## Out of scope

Any chain access, database, real signing, real availability, or business logic beyond returning the
fixture that matches the scenario.

## Deliverables

- `services/packages/shared/src/api/v1.ts` (schemas and inferred types)
- `services/apps/api-stub/` (server, fixtures, scenario handling, tests)
- `/v1/openapi.json`

## Acceptance

- Every response validates against its zod schema in tests.
- Every scenario is covered by a test.
- Money fields are decimal strings; no response contains `feeBps` except inside `quote` in the
  prepare response (spec 5.3).
- `pnpm --filter api-stub test` passes; the Docker image starts and serves the OpenAPI document.

## Watch for

- Don't invent fields that the spec doesn't define. If the agent workstream needs something extra,
  record it under "Blocked" in your handoff; don't add it yourself.
- `refundCurve[].untilLocal` is local time in the property's zone (Europe/Athens for the pilot), in
  ISO 8601 with offset.

## Handoff

`docs/handoffs/C0.md`, per `CLAUDE.md` section 10. Include the run command and the base URL.
