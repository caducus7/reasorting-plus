# 0014: indexing framework (D6): Ponder

**Status:** Accepted with C6's framework step. Amended by [0017](0017-indexer-design.md) §4: an
unrecoverable reorg stops indexing at once, but the process exits only after up to 10 minutes of
retries, so a stall is detected from outside (lag monitor). The project owner said to "go defaults" and to follow
established tooling over custom code (spec 10.1: "Do not hand-roll chain ingestion").

**Evaluated:** Ponder 0.17.12 (`ponder-sh/ponder@6b0bd2c`) and Envio HyperIndex 3.12.1
(`enviodev/hyperindex@7c8a7f5`). Both were read at source and run as prototypes on 2026-09-27. The
prototype sources and scripts are in `docs/spikes/d6-indexer/`.

## Evidence against spec 10.1

| Requirement | Ponder | Envio |
|---|---|---|
| 1. Roll back to the common ancestor on a reorg and re-index | **Yes, within its window.** Trigger-based transaction log (`docs/indexing/overview.mdx`). | **Yes, within its window.** |
| Rollback window on Base | **Fixed.** `getFinalityBlockCount` gives 30 blocks for chains not in its table (`utils/finality.ts`), and finality advances in steps, so the window is 30–60 blocks. Not configurable. | **Configurable.** `max_reorg_depth`, default 200 for Base (`Config.res`). |
| Reorg deeper than the window | **Fails loudly.** Detected, `Encountered unrecoverable reorg`, then shutdown (`sync-realtime/index.ts:925-941`). | **Silent.** The reorg is detected, 0 events are rolled back, and indexing continues. A phantom booking remains. |
| 2. `unsafe`/`safe`/`finalized` heads | **No.** Its "finalized" is latest − 30, not the chain's tag (`finalized_block` = head − 30 in the Base Sepolia run). | **No.** It uses its own depth threshold. |
| 3. Idempotent handlers keyed on the event | **Yes.** `event.id` is a globally unique id per log, and a checkpoint cursor gives exactly-once processing. | **Yes.** `chainId`, `transaction.hash` and `logIndex` are available, with a checkpoint cursor. |
| 4. Full replay into a separate schema | **Yes.** `ponder start --schema <name>`, one instance per schema, `--views-schema` for zero-downtime cut-over (`production/self-hosting.mdx`). | **Yes.** `ENVIO_PG_SCHEMA`. |
| License | MIT | Proprietary EULA. It bars offering the generated code to third parties "as a hosted or managed service" (`licenses/EULA.md`). |
| Stack fit | TypeScript and viem in Node, which matches `services/` | TypeScript handlers; a Rust/ReScript engine with codegen |

**Prototype results.** Both were run against our real `Escrow` on Anvil: deposit a booking, then
force `anvil_reorg`.

| Reorg | Ponder | Envio (`max_reorg_depth: 50`) |
|---|---|---|
| 3 blocks | Rolled back (row removed) | Rolled back (`rollbackedEvents: 1`) |
| 40–45 blocks, inside the window | Rolled back while still inside its 30–60 step | Rolled back (`rollbackedEvents: 1`) |
| 70 blocks, beyond the window | **Halted:** `unrecoverable reorg beyond finalized block 60` | **Silent:** `rollbackedEvents: 0`, phantom row kept, still running |

**Base Sepolia.** Ponder on the public RPC backfilled 572 blocks of Circle USDC `Transfer` logs in
11 s and indexed live within 2 blocks of head. It warns that production needs a higher-rate-limit
RPC, supplied from `.env` (CLAUDE.md §9).

## Decision: Ponder

It is the only candidate that never serves a silently wrong projection. For an escrow whose off-chain
calendar is the only overlap check, a phantom or missing booking is the failure that matters. It is
also MIT-licensed and fits the existing TypeScript services.

Neither framework meets requirement 2, and Ponder's window is fixed. Per spec 10.1 ("document the
gap and build only that part"), C6 builds only these:

1. **Head tracker (requirement 2).** A small poller reads the chain's own `latest`, `safe` and
   `finalized` block tags. It records them with their hashes, and publishes head-transition events
   (outbox table or `LISTEN/NOTIFY`, per the C6 brief).
   - Every action in spec 10.2 is gated on these real tags, never on Ponder's heuristic.
   - The quote service already reads `safe` directly (ADR 0012 §3).
2. **Deep-reorg recovery.** A Ponder halt on an unrecoverable reorg is treated as an incident:
   - page the operator;
   - start a fresh full replay into a new schema (requirement 4);
   - switch the views schema once it is ready.
   - This is the same machinery as the nightly replay diff (spec 10.3).
   - On Base a reorg deeper than 30 blocks needs sequencer equivocation or a batch-derivation
     failure. Actions gated on `safe`/`finalized` are unaffected either way.
3. **Event keys.** The ledger stores `(chainId, txHash, logIndex)` alongside Ponder's `event.id`, so
   entries stay stable across replays and match spec 10.1's wording.

**Rejected alternative.** Envio's configurable depth is a real advantage. However, silent loss of a
rollback beyond the window cannot be detected from inside the indexer, and the EULA constrains
operation. If Ponder's fixed window ever proves too small in practice, revisit it by asking upstream
to make `finalityBlockCount` configurable. Do not fork.
