# 0009: loss-window accounting and remaining review defaults

**Status:** Accepted. The project owner confirmed "go defaults", and asked that each be shown to work.
**Resolves:** review 0001 findings 1, 2, 11, 12 and 16, plus two findings from C1's fork run.
**Evidence:** `contracts/test/model/AccumulatorModel.t.sol`, an executable model of spec 6.1 and
6.4 that runs the spec's pseudocode as written next to the default below.

## 1. High-water-mark baseline during an unrecognised shortfall (finding 1)

`accrue()` never lowers `lastAssets` on its own. If `assets < lastAssets`, the difference is an
**observed shortfall** (`shortfallSince` is set if not already). Only gains above `lastAssets` are
distributed (after repaying `lossDebt`). `recogniseLoss()` (after `LOSS_CONFIRMATION_WINDOW`) is the
only path that lowers `lastAssets`: to `assets`, booking the loss through the spec 6.4 absorption
order. If assets recover to `lastAssets` before then, the observation clears and nothing is booked.

Why the spec text fails:
`test_specAsWritten_dipThenRecoveryCreatesPhantomYield` shows a 100-unit dip followed by recovery
credited as 100 of yield, leaving the escrow permanently 100 short. The default credits nothing
(`test_default_dipThenRecoveryCreditsNothing`). Under 1,000 fuzzed sequences of gains, dips,
recognitions, deposits and owner claims, `assets + lossDebt + shortfall >= liabilities` and "yield
credited ≤ real gains − real losses" hold (`testFuzz_default_neverPhantomYield`). The same property
fails immediately on the spec's pseudocode.

## 2. Observed shortfall gates owner and fee claims (finding 2)

`claim()` treats "shortfall observed" like `lossDebt > 0`: only guest buckets are paid; owner-only
and fee-only callers revert `LossDebtOutstanding`. The same gate applies to `deploy` and to
reserve withdrawal. It clears automatically when assets recover to the baseline.

Evidence: `test_specAsWritten_ownerDrainsDuringWindow` (the owner withdraws 500 while guest
principal is uncovered) versus `test_default_ownerBlockedDuringWindowAndDebt` (blocked during the
window and while `lossDebt > 0`, paid once gains have repaid the debt, with no phantom yield from the
repayment).

**Griefing guard (brief C2):** a shortfall below `MIN_LOSS_ATOMIC` is ignored for gating and
recognition, so ERC-4626 rounding dust (ADR 0008) cannot block owners. C2 sets the value in its
loss-threshold ADR, as the brief requires.

## 3. Reserve withdrawal recipient (finding 11)

Reserve withdrawals pay the **current `payoutAddress`**. No recipient parameter (CLAUDE.md money
rule 3). Two-step, as the C2 brief says: the owner proposes, the guardian confirms. The withdrawal
reverts while `lossDebt > 0` or a shortfall is observed.

## 4. C9 scheduling (finding 12)

C9 starts after **C3's interim handoff** (published dispute ABI), not with wave 2. It stays a fresh
agent. `briefs/README.md` is updated.

## 5. bookingId namespace (finding 16)

The contract keeps `bookingId = hashStruct(quote)` (spec 4.1). Off-chain, the indexer (C6) and quote
service (C5) key every booking by `(chainId, escrow, bookingId)`. The `/v1` path stays
`/v1/bookings/{bookingId}` while there is one escrow; before a second owner, the API gains an escrow
dimension (a new `/v1` ADR with the agent workstream).

## 6. From the fork run (C1)

- **EIP-7702 and the quote signer.** OpenZeppelin `SignatureChecker` validates any signer with code
  through ERC-1271, and an EIP-7702 delegation counts as code. The well-known test key
  `makeAddr("signer")` is delegated on Base mainnet, and quotes from it are rejected
  (`test_eip7702DelegatedSignerRejectsEcdsaQuotes`). **Ops rule:** the KMS quote-signer EOA is never
  7702-delegated. Rotate with `setQuoteSigner` if it ever is.
- **The USDC permit domain name differs by network.** Mainnet `name()` is `"USD Coin"`; Base Sepolia
  `name()` is `"USDC"` (both `version()` `"2"`). Anything that builds a USDC permit (checkout A3,
  C5's prepare) reads `name()` and `version()` from chain, never a constant.
