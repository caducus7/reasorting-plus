# Review 0001: chain agent pack, before wave 1

**Scope:** `CLAUDE.md`, `docs/chain-spec.md`, `docs/agent-spec-v1.md` (sections 5 to 7), `briefs/C0` to `C9`.
**Method:** read in full; every finding cites the lines it rests on. No code exists yet, so nothing
here was tested. The external claims (Base USDC `permit`, Aave figures) were not checked against chain
state. That job belongs to C1 and C4 on a pinned fork.

Severity: **Blocker** means a money-path ambiguity that CLAUDE.md section 8 says an agent must stop on.
**High** means the build can proceed, but a decision is needed before the named package finishes.
**Medium/Low** means worth fixing in the spec text.

## Summary

| # | Severity | Blocks | Finding |
|---|---|---|---|
| 1 | Blocker | C2 | `accrue()` lowers `lastAssets` on an unrecognised dip, so a recovery is paid out as yield |
| 2 | Blocker | C2 | Owner and fee recipient can drain idle funds during the 6h loss confirmation window |
| 3 | Blocker | C1, C3 | Payout address is not stored per booking, so rotating it escapes the `lossDebt` gates |
| 4 | Blocker | C1 | Nobody is named as the caller of `createEscrow`, so either the fee can be waived or owner consent is off-chain |
| 5 | High | C1, C3 | Freezing a `DISPUTED` booking is implied by C3 but undefined in spec 3.5 |
| 6 | High | C0, C5 | The Service API has no way for a guest to `claim` refunds or yield |
| 7 | High | C0 | The API `state` enum is undefined; C0's `cancelled` scenario is not a spec state |
| 8 | High | C1 | The pre-mainnet escrowed-value cap (12.3) is absent from C1, and clones are immutable |
| 9 | Medium | C1 | Guardian freeze has no time limit, so a compromised guardian can lock every booking forever |
| 10 | Medium | C0 | Agent `get_booking` expects `policy`; `/v1/bookings/{id}` has no policy field |
| 11 | Medium | C2 | Reserve withdrawal has no specified recipient |
| 12 | Medium | Ops | C9 starts in wave 2 alongside C3, before the dispute ABI exists |
| 13 | Low | C1 | Lazy timelocks: a new proposal can overwrite an effective-but-unpromoted value |
| 14 | Low | C1 | Guards 1 to 11 run before `accrue()`, contrary to CLAUDE.md money rule 4 |
| 15 | Low | C1 | Event list misses `MaxDeployBpsSet` and others that CLAUDE.md rule 7 requires |
| 16 | Low | C6, C0 | `bookingId` is not domain-separated, and `/v1` paths carry no escrow address |
| 17 | Low | Text | Spec 7 says "guest or owner may open", then defaults to guest only |
| 18 | Low | Text | Agent spec says `get_quote` returns a signed quote; offers are unsigned (5.2) |

Economics in spec 8 recomputed: 10,000 × 4.18% × 46/365 × 0.9 = 47.4 (matches); 146,000 × 0.474% = 692
(matches "about 690"). No errors found there.

---

## 1. Blocker: phantom yield after a transient dip (spec 6.1, 6.4)

`accrue()` (chain-spec.md lines 429 to 438) ends with `lastAssets = assets` unconditionally, and its
negative branch defers to 6.4. But 6.4 recognises a loss only after `LOSS_CONFIRMATION_WINDOW`
(6h, line 469), and C2 requires that "transient dips shorter than the confirmation window never become
`lossDebt`".

Scenario: adapter assets dip by 100 and `accrue()` runs, so `lastAssets` drops by 100 and no loss is
recorded. Assets then recover by 100 and `accrue()` runs again, so `delta = +100` goes into
`accYieldPerUnit` and is credited as yield. Liabilities rise by 100 while assets are back where
they started. The escrow is now 100 short for good, and INV-1 eventually breaks.

**Decision needed:** during an unconfirmed shortfall, does `lastAssets` hold at the pre-dip value
("expected value" in line 469 suggests yes), with gains counted only above it? Specify it in 6.1.

## 2. Blocker: drain during the confirmation window (spec 4.5, 6.4)

The `lossDebt` gates (lines 318 and 476 to 484) apply only once `lossDebt > 0`. During the 6h window
`lossDebt == 0`, so the payout address and fee recipient can claim from idle funds. C2's
`observeShortfall()` is permissionless and public, so the owner can see a loss coming. That breaks
"guest claims are paid first" (line 486), and it also empties absorption step 2 (the owner's
unclaimed `claimable`, line 473) before the loss is recognised.

**Decision needed:** should an observed-but-unconfirmed shortfall also gate owner and fee claims?

## 3. Blocker: payout address is not on the booking (spec 3.3, 4.2, 4.4, 7)

- 4.2 (line 242) lists stored per-booking fields; `payoutAddress` is not among them.
- 4.4 (line 287) credits `claimable[payoutAddress]`, meaning the escrow's current value.
- 7 (line 564) says "`resolve` reads guest and payout address **from the booking**".
- 3.3 lets the owner set the payout address with no timelock.
- 4.5 and 6.4 gate and absorb against "the owner payout address", with no rule for historical
  addresses.

Consequence: the owner rotates the payout address. The old address still holds `claimable`, is no
longer "the payout address", and so escapes both the `lossDebt` claim gate and step-2 absorption.

**Decision needed:** either snapshot `payoutAddress` per booking (and gate every address ever used), or
keep owner credits in an address-independent `ownerClaimable` bucket paid to the current payout
address. The second is simpler and closes both holes. Either way, fix the contradiction with section 7.

## 4. Blocker: who calls `createEscrow` (C1 brief, spec 3.3, 3.4)

C1 specifies `createEscrow(owner, maxFeeBps, initialFeeBps, ...)`, and the spec says `maxFeeBps` is
"fixed at creation, owner consents" (line 115). The spec never says who may call it.

- If it is **permissionless**, anyone can deploy an escrow with `initialFeeBps = 0`. That bypasses
  "fee cannot be waived" (CLAUDE.md section 5), and `factoryAdmin` can only raise it after 7 days.
- If it is **`factoryAdmin` only**, the owner's consent to `maxFeeBps` never happens on-chain.

**Decision needed:** caller and consent mechanism, for example admin-only with `initialFeeBps` taken
from factory defaults, or two steps where the admin offers and the owner accepts.

## 5. High: freeze on a disputed booking (spec 3.5; C1 and C3 briefs)

The state diagram (lines 152 to 162) allows `freezeBooking` only from `ESCROWED`, and "unfreeze
restores `ESCROWED`". C3 (line 46) requires "a frozen booking cannot be disputed **or resolved**",
which implies freezing a `DISPUTED` booking. Unfreezing that booking back to `ESCROWED` would be wrong:
its principal has already left `totalOpenPrincipal`. It is also undefined whether time spent frozen
counts toward `DISPUTE_WINDOW` for `resolveByDefault`.

**Decision needed:** can `DISPUTED` be frozen? If so, unfreeze returns it to `DISPUTED`, and a rule is
needed for the dispute window.

## 6. High: no claim path in the Service API (spec 4.5, 5.3, 11)

Settlement "credits claimable balances. It never transfers" (line 166), so a guest's refund or yield
reaches them only through `claim()`. Spec 5.3 has no claim endpoint or call bundle, and
`/v1/bookings/{id}` exposes no claimable balance. Section 11's acceptance ("cancel ... end to end")
passes without the guest ever receiving money. `cancel-preview` could bundle `[cancel, claim]`, but
nothing covers claiming vested yield after settlement or a refund after `cancelByProperty`.

C0 is told not to invent fields, so it can only list this under "Blocked". **Decision needed:** add a
claim field and bundle (both workstreams must agree, per 5.3).

## 7. High: API booking `state` enum (spec 3.5, 5.3; C0 brief)

5.3 returns `state` without defining its values. Spec 3.5 states are `ESCROWED`, `FROZEN`,
`DELIVERED`, `DISPUTED`, `SETTLED`: a cancelled booking is `SETTLED`. C0's scenarios distinguish
`cancelled` from `settled`, so the API evidently needs an outcome that the contract state does not
carry. **Decision needed:** the enum, fixed before C0 because the agent workstream builds against it.

## 8. High: escrowed-value cap is mandatory but unbuilt (spec 12.3)

12.3 makes "a contract-enforced cap on total escrowed value per escrow" non-optional before mainnet.
The C1 brief does not include it, and CLAUDE.md forbids adding parameters. Clones are immutable, so
adding it later means a new implementation and a drain migration for every escrow created before
then. **Decision needed:** build it into C1 now (a new owner or admin parameter plus a guard in
`deposit`)?

## 9. Medium: unbounded freeze (spec 3.3, 3.5)

The guardian "cannot move any funds", but can freeze any booking indefinitely, and nothing unfreezes it
except the guardian. C9 property 11 explicitly exempts frozen bookings. A compromised guardian can
strand every guest's principal. Consider a maximum freeze duration, or permissionless unfreeze after
a window. If the current design is intended, add it to the CLAUDE.md "looks like a bug" table.

## 10. Medium: `get_booking` expects policy (agent spec 6)

The agent's `get_booking` returns "status, dates, policy, refund if cancelled now". `/v1/bookings/{id}`
returns no `policyId`, `renderedPolicy` or `refundCurve`. The agent workstream will hit this on A1/A3.

## 11. Medium: reserve withdrawal recipient (spec 6.5)

Withdrawal requires owner and guardian and emits `ReserveWithdrawn(amount, reasonCode)`, but no
recipient is specified. CLAUDE.md money rule 3 forbids a recipient parameter. Presumably it is the
payout address, which runs into finding 3.

## 12. Medium: C9 scheduling (briefs/README.md)

C9 runs in wave 2 alongside C3 and depends on "C1-C3 ABIs". Properties 9 and 11 and the arbitrator
scenarios cannot be written until C3 publishes `openDispute` and `resolve`. Either start C9 after
C3's interim handoff, or split it (C9a core, C9b disputes).

## 13. Low: lazy timelock overwrite (spec 3.4)

If `pendingFeeAt` has passed but no state-changing escrow call has promoted it yet, a new proposal
that overwrites `pendingFeeBps`/`pendingFeeAt` silently reverts the effective fee. That makes quotes
signed at the effective value fail, and breaks the indexer's "pure function of time" computation.
Proposals must promote first. The same applies to the arbitrator snapshot: at deposit, snapshot the
*effective* arbitrator, not the stored one.

## 14. Low: guard ordering vs rule 4

CLAUDE.md rule 4 says "`accrue()` is the first call in every state-changing escrow function". Spec
4.2 puts `accrue()` at guard 12. The spec wins (CLAUDE.md section 1), and view-only guards first is
fine. But guard 5 checks `lossDebt == 0` *before* an `accrue()` that might have repaid it. Note the
exception in CLAUDE.md so the agents don't argue about it.

## 15. Low: events

The owner can set `maxDeployBps` (3.3), but there is no `MaxDeployBpsSet`. C2 adds
`observeShortfall`, a reserve-withdrawal proposal and pending-yield release, none of which is in 4.7's
list. It is "minimum set" wording, but C6 needs the full list fixed with C1's interim handoff.

## 16. Low: bookingId namespace

`bookingId = hashStruct(quote)` excludes the domain, so identical quotes on two escrows share an id,
and `/v1/bookings/{bookingId}` carries no escrow address. This is harmless for the single-owner
pilot. Before a second owner, key the indexer and API on `(escrow, bookingId)` or use the full
EIP-712 digest.

## 17 and 18. Text fixes

- Spec 7, line 552: "The guest or the owner may open" contradicts the D8 default at line 572. Say
  "the guest (D8)".
- Agent spec 6, `get_quote`: "Fetches a signed quote from C5". Offers are unsigned until prepare
  (spec 5.2). Say "fetches an offer".

## Not findings (checked and consistent)

- Rounding directions in 4.4 match CLAUDE.md money rule 1 and keep all three equalities exact.
- The dispute split across two settlement calls conserves principal per part, so it conserves per
  booking.
- The fee expiry cap `pendingFeeAt - 60s` (5.2) together with guard 9 prevents fee straddling.
- 15.2's corrected 46-day window matches section 8's arithmetic.
