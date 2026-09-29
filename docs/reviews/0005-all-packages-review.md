# 0005: review of every package since review 0004

**Scope:** everything added or changed since review 0004 (commit `cdd71a9355c09facaca52b3cff472e5cdd687e17`).
- **Contracts:** the C4 best-effort claim pull, `MockYieldVault`, the `LedgerTape` fixtures.
- **Packages:** `@chain/signer`.
- **Apps:** `quote-service` (indexer read model), `indexer` (C6), `ical-sync` (C7),
  `rebalancer` (C8).

**Method:** adversarial reading against the spec, the ADRs and CLAUDE.md. Every finding below has a
failing reproduction, or cites the code line if the failure is by inspection. Fixes follow the prior
art each row names. **Status: findings only; no fix applied yet.**

## Findings

| # | Sev | Package | Finding | Reproduction |
|---|---|---|---|---|
| R1 | **High** | rebalancer | A key serving several escrows (`ESCROWS=a,b`) signs two transactions at the **same nonce**: "one in flight" and the advisory lock are per escrow, while the nonce is per signer. One replaces or blocks the other, and a needed redeem can be replaced by another escrow's deploy; `send` then swallows "replacement transaction underpriced". | `services/apps/rebalancer/test/review/shared-key.test.ts`: nonces signed `5,5` |
| R2 | **High** | indexer | One escrow whose chain reads revert (a broken vault before write-off, ADR 0013 §3: `totalAssets` reverts) makes `runMonitors` throw. **Every monitor for every escrow goes dark**, including INV-1 on healthy escrows and all of INV-3, exactly during the incident. Nothing alerts; the worker only logs "tick failed". | `services/apps/indexer/test/review/monitors-dark.test.ts`: **0 alerts**; INV-1 on the healthy escrow is not raised |
| R3 | Medium | rebalancer | The same failure mode in C8: a reverting read throws out of `cycle()`. No decision row, no alert, and the log cannot explain the silence (brief acceptance: "every decision explainable from the log"). | By inspection: `executor.cycle` calls `c.snapshot()` with no catch; `main.ts` only logs |
| R4 | Medium | ical-sync | Conflicts are checked only after a 200 import. A guest depositing onto nights a channel already blocked, while that channel's feed stays unchanged (304), is **never logged** in `ical_sync.conflicts`. This is exactly spec 9's residual race. C6's INV-3 monitor still alerts, so it is the log (brief: "log every conflict") that misses it. | `services/apps/ical-sync/test/review/conflict-on-304.test.ts`: 0 rows |
| R5 | Medium | ical-sync | Export URLs, each a bearer secret for a channel, are printed to stdout at every start, so they land in log aggregation. | `src/main.ts:37` |
| R6 | Medium | indexer | The read API (`/v1/indexer/*`) and Ponder's `/status` and `/metrics` have **no authentication**. The summary exposes each escrow's ledger, and a booking view exposes the guest address and stay dates. The design assumes it is internal (C5 is its only client), but nothing enforces that. | `src/api/index.ts` has no auth middleware |
| R7 | Low | quote-service | With the indexer read model, a guest whose deposit is newer than the indexer's checkpoint gets 403 on `GET /v1/bookings/{id}` until it catches up (seconds normally, minutes in a `LAG` incident). It is safe (nothing is revealed), but it reads as "not your booking". | By inspection: `readModel.ts` returns null on 404, and `app.ts` turns that into 403 |
| R8 | Low | indexer | `indexer_ops.head_events` grows by one row per head change, up to about 130k rows a day on Base (three tags polled every 2 s), with no retention. | `migrations/001_ops.sql` |

Reconfirmed open items from earlier handoffs (owner decisions, not bugs): the C7 mass-deletion guard,
the C8 liquidity exit during a depeg, and the USDC/USD deviation threshold (confirm before mainnet).

## What was checked and held

- **Contracts:**
  - `LedgerLib.claim`'s best-effort pull cannot underflow `lastAssets`: paid ≤ idle ≤ assets ≤
    lastAssets after `_accrue`, and the stranded path books the pull first.
  - Source is unchanged since the C4 CI run (256/256, invariants at 1,000 runs × depth 100). The
    only later edit is test-only: `C9Handler._call` made `virtual`.
- **No secrets in git:** only Anvil's public dev keys (the 10 used by the harnesses); no keyed RPC
  URLs; `feeds.json` is gitignored.
- **C6 reducer:** the 12 C9 tapes, 156 snapshots and 4 mutations pass; so do the event-order cases
  (`BookingCancelled` before `BookingSettled`, `YieldDeferred` before settlement, and the
  `Redeemed` → `YieldAccrued` → `Claimed` order on the stranded path).
- **C7 fetcher:** the SSRF tests hold, including DNS names resolving to loopback. Timing-safe token
  comparison, HMAC UIDs.
- **C8 policy:**
  - Cap safety holds by property, plus a backstop that the bounds never hit.
  - No price value turns a hold into a redeem.
  - A stata wrapper pause (ADR 0016) makes a redeem pre-check revert: a cooldown, not a loop.

## Recommended fixes, with prior art

| # | Fix | Prior art |
|---|---|---|
| R1 | Make "one transaction in flight" and the process lock **per signer** (chain id + address): an escrow waits (`sender_busy`) while another escrow's transaction is pending. | viem's `nonceManager` keys the nonce sequence on (address, chainId), not per contract (`utils/nonceManager.ts`). OpenZeppelin Defender Relayers serialise nonces per relayer. Our write-ahead row keeps it restart-safe, which the in-memory viem manager is not. |
| R2 | Evaluate each escrow independently. A failed read opens a **page** `READ_FAILED:<escrow>` (response: `check_vault`, `write_off_vault`, ADR 0013 §3) and the rest continue. INV-3 is isolated from chain reads. | OpenZeppelin Monitor and Forta evaluate each monitored target on its own and alert on monitor failures. A monitor must fail loud, not silent (Google SRE, "Monitoring distributed systems": no silent failure of the alerting path). |
| R3 | A failed snapshot writes a `hold` `read_failed` decision row with the error, plus an alert. | Same principle; also the brief's "explainable from the log alone". |
| R4 | Run `checkConflicts` for every configured resource on **every** loop tick, not only on a 200 (level-triggered, not edge-triggered). | Kubernetes controllers reconcile desired against actual state on every sync, not only on change events ("level-triggered"). |
| R5 | Do not log export URLs. Add an explicit `pnpm export-urls` command for the owner. | OWASP Logging Cheat Sheet: never log access tokens, session identifiers or URLs containing them. |
| R6 | Require a bearer token (`INDEXER_API_TOKEN`, constant-time compared) on `/v1/indexer/*`; C5 sends it. Deployment note: bind the port to the private network. | Defence in depth: network isolation plus authentication (OWASP ASVS V4). Ponder's own docs leave auth to the app's Hono middleware. |
| R7 | On a 404 from the indexer, C5 falls back to the chain read model for that request. | Graceful degradation with a read-through fallback. |
| R8 | Keep 7 days of `head_events` (consumers read NOTIFY live; the table is only for catch-up). | Outbox pattern: events are pruned once consumed or past a retention window. |
