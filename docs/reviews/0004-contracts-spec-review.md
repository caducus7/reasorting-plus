# 0004: independent review of contracts/src against the spec

**Reviewer:** independent reviewer agent (briefs/README.md: "after C1 to C3 and C9 are green"). I wrote
none of the code under review.
**Date:** 2026-09-27
**Commit reviewed:** `1117d814b02325f73b2d2c6fdfa61a38f765823d`. The review branch
`worktree-agent-a76a3f97ac51081d9` adds only this document and `contracts/test/review/`.

## 1. Scope and method

**In scope:** `contracts/src/` in full.
- `Escrow.sol` (757 lines) and `EscrowFactory.sol` (189)
- `interfaces/IEscrow.sol` and `interfaces/IEscrowFactory.sol`
- `libraries/`: `LedgerLib`, `DisputeLib`, `QuoteLib`, `SettlementLib`, `BookingLib`, `Params`

**Reference:** `docs/chain-spec.md` read in full, including section 16, plus ADRs 0001 to 0013 and
`CLAUDE.md` (money rules and the "designs that look like bugs" table).

**Anchoring control.** Until my own findings list was written, I read only the spec, the ADRs,
`CLAUDE.md` and `src/`. The list was saved to the scratchpad before I opened `contracts/test/*`,
`docs/handoffs/*` or `docs/reviews/*`. I then read the handoffs and earlier reviews to mark which
findings were already known. That status is given per finding.

**Commands run** (from `contracts/`):

| Command | Result |
|---|---|
| `forge build` | ok (solc 0.8.35, legacy codegen). Only warnings from OpenZeppelin and test files |
| `forge build --sizes` | `Escrow` 21,687 B runtime (2,889 B margin to EIP-170), `LedgerLib` 7,345 B, `DisputeLib` 2,303 B, `QuoteLib` 1,943 B, `BookingLib` 1,472 B, `EscrowFactory` 4,305 B |
| `forge test --no-match-path 'test/fork/*'` (before adding PoCs) | **230 passed, 0 failed, 0 skipped**, 17 suites |
| `forge test --match-path 'test/review/*'` | **3 failed, as intended** (see section 3) |
| `slither src --exclude-dependencies` (0.11.6) | 33 results, none of them real findings. See below |
| Fork tests | **Not run.** `BASE_RPC_URL` is not set in this environment |

**Slither triage (all ruled out):**
- `uninitialized-local` (`LedgerLib.accrue` `toReserve`): intended to default to 0.
- `unused-return` (`vault.withdraw`): ERC-4626 `withdraw` delivers exactly `assets` or reverts; see R8.
- `missing-zero-check` (`setRebalancer`): `address(0)` intentionally disables rebalancing.
- `reentrancy-benign` (`depositWithPermit`): the permit is to USDC, under `nonReentrant`.
- Timestamp comparisons, pragma, naming, complexity and unindexed-address items: informational.

## 2. Findings

| ID | Severity | Location | Spec / ADR | Summary | Known before? |
|---|---|---|---|---|---|
| R1 | **Medium** | `Escrow.sol:229-238`, `:279-293`, `:366-394`; `QuoteLib.sol:276-288` | 3.3, 3.5, 4.3, 6.4; ADR 0007 §3, 0011 §3 | A guardian freeze does not stop the refund-policy clock or `GRACE`. A frozen guest crosses cutoffs, check-in or check-out and loses refund, cancel and dispute rights | GRACE part: yes (C3 handoff). Cutoff, check-in and check-out part: **new** |
| R2 | **Medium** | `Escrow.sol:109-112`, `:511-513`, `:532-538`, `:559-576` | 3.3, 6.4; ADR 0013 §3 | `writeOffVault` works on a healthy vault, instantly, by one party. Only the owner or guardian can undo it, and `redeem` is blocked meanwhile. Guest refunds held in a working vault are withheld | Single-party noted in C9-fixes. The lock on guest liquidity: **new** |
| R3 | Low | `Escrow.sol:214`, `:452-456` | 12.3; ADR 0007 §4 | The escrowed-value cap counts only open principal, not unclaimed guest credits, disputed amounts or pending yield. The owner can also raise it alone | Partly (ADR 0007 chose owner-set) |
| R4 | Low | `Escrow.sol:198-199` | 4.2 guard 5; ADR 0009 §2, 0013 §3 | Deposits are accepted during an observed shortfall and while the vault is written off. On recovery, new bookings share vault growth they did not fund | Behaviour known (C9 prediction 4); not raised as a concern |
| R5 | Low | `Escrow.sol:367`, `:382` | ADR 0013 §2, §3 | `freezeBooking` and `unfreezeBooking` run `accrue()`, so a broken vault stops the guardian freezing and stops the permissionless unfreeze | New |
| R6 | Low | `EscrowFactory.sol:83-113`, `:136-150` | 3.3; ADR 0007 §2 | `createEscrow` cannot pin the implementation, vault or arbitrator the owner reviewed, and the admin can change them without delay | New |
| R7 | Low | `LedgerLib.sol:127`, `DisputeLib.sol:138` vs `LedgerLib.sol:175-176` | 4.4, 6.4; ADR 0009 §2, 0010 §3 | Settlement defers yield only on `lossDebt > 0`. During an observed shortfall, new vested yield is credited to the guest and paid ahead of other guests' principal, although pending-yield release is gated in that same state | New |
| R8 | Info | `LedgerLib.sol:255-260`, `:290-292` | 6.6; ADR 0008 | Vault pulls and deposits trust exact ERC-4626 behaviour: no balance-delta check, and a residual allowance is left if the vault pulls less | New |
| R9 | Info | `LedgerLib.sol:187`, `:237`, `:326` | Money rule 7 | `Claimed`, `PendingYieldReleased` and `LossRecognised` merge buckets. A ledger rebuild must reproduce the contract's debit order exactly | New |

**Counts:** Critical 0, High 0, Medium 2, Low 5, Informational 2.

No finding shows a path for any role, or an outsider, to take escrowed USDC to an address that is
not stored on the booking or held as a role. The books identity, the three settlement equalities
and the rounding rules all held under my review (section 5).

---

### R1 (Medium): freezing a booking runs the guest's policy clock and GRACE

**Description.** `freezeBooking` (`Escrow.sol:366`) sets `state = FROZEN`, so `_escrowed()` rejects
`cancelByGuest` and `openDispute` while the booking is frozen. The time checks are still made
against raw `block.timestamp`:
- `QuoteLib.refundBps(..., block.timestamp)` (`Escrow.sol:235`)
- `block.timestamp >= b.checkOutUtc` → `NotCancellable` (`:234`)
- `block.timestamp >= checkOut + GRACE` → `DisputeTooLate` (`:287`)

`unfreezeBooking` records `frozenTotal`, but only `disputeDeadline` uses it (ADR 0011 §3). The freeze
budget is 30 days, longer than most gaps between refund tiers, so one freeze can take a guest from
the 100% tier to 0%.

**Impact.**
- Up to 100% of a guest's principal moves from the guest's refund to the owner's retained share.
  There are three ways:
  - frozen across cutoffs: a lower tier;
  - frozen across check-in: `finalBps`;
  - frozen across check-out: no cancellation at all.
- A freeze across `checkOut + GRACE` also removes the guest's only remedy, the dispute.
- Spec 3.3 says the guardian "cannot move any funds". Spec 6.4 requires that "no sequence of valid
  operations reduces any guest's credited refund ... below the policy-derived figure".
- Likelihood:
  - It needs the guardian to freeze. For the pilot the guardian, the platform and the owner are
    effectively one party (spec 7 notes this for the arbitrator, not for the guardian).
  - An **honest** freeze, for example while investigating fraud, harms an honest guest in exactly
    the same way.

**PoC** (`contracts/test/review/Review0004.t.sol`):
- `test_R1_freezeAcrossCutoffsCutsGuestRefund` **fails as intended**:
  `R1: freeze moved the guest's refund to the owner: 0 != 5600000000`.
  1. The booking is frozen on day 29 of the 100% tier.
  2. Cancelling reverts `BookingNotEscrowed` while it is frozen.
  3. After the permissionless unfreeze on day 59, the refund is 0.
- `test_R1_freezeAcrossGraceRemovesDisputeRight` **fails as intended** with `DisputeTooLate()`. This
  is the C3 concern, reproduced.

**Recommended fix.**
1. Evaluate every guest-facing time check at the booking's **frozen-adjusted time**,
   `block.timestamp - b.frozenTotal`, for:
   - the `refundBps` lookup;
   - the `NotCancellable` bound;
   - the `DisputeTooLate` bound.
2. Leave the owner-facing `settle` and `cancelByProperty` bounds unchanged.

Total extra delay is bounded by `MAX_FREEZE_DURATION`, as ADR 0011 already accepts for
`DISPUTE_WINDOW`.

**Prior art:**
- *Aave V3 (aave-dao/aave-v3-origin @ 8305565):*
  - `src/contracts/protocol/pool/PoolConfigurator.sol:240-256`: `setReservePause(asset, paused,
    gracePeriod)` sets a liquidation grace period on unpause.
  - `src/contracts/protocol/libraries/logic/ValidationLogic.sol:276-277` blocks liquidation until
    `liquidationGracePeriodUntil`.

  Aave's rule: users who could not act during an admin pause must not be penalised on unpause for
  time that passed while they were locked out.
- *This codebase:* ADR 0011 §3 and `Escrow.sol:337-342` (`disputeDeadline` adds frozen time)
  already apply the same principle to the arbitrator's window.

This changes spec 3.5 ("Time spent frozen does not extend GRACE") and needs an ADR.

---

### R2 (Medium): a healthy-vault write-off withholds guest refunds, and only owner or guardian can undo it

**Description.**
- `writeOffVault()` (`Escrow.sol:559-565`) is callable instantly by the owner **or** the guardian,
  whether or not the vault is broken.
- While `vaultWrittenOff` is set:
  - `_activeVault()` returns `address(0)`, so `claim` and reserve withdrawals pay from idle only
    (`LedgerLib.planPull`);
  - `redeem` reverts `VaultIsWrittenOff` (`:533`).
- `recoverVault()` (`:571-576`) is also owner-or-guardian only.

With `maxDeployBps` at 9,000, up to 90% of guest principal and refunds sits in a vault that works
but that nobody can pull from. That lasts until one of the two parties that can write off chooses to
recover.

ADR 0013 §3 bounds the abuse as "harms only the owner first; guests are senior ... reversible". That
covers **accounting**, not **liquidity**. Guests' credits stay intact while the USDC is withheld.
After `LOSS_CONFIRMATION_WINDOW`, anyone can recognise the "loss". That puts the escrow into
`lossDebt`, which also blocks deposits and all owner and fee claims.

Yearn, the ADR's own precedent, documents the opposite procedure: "All possible assets should be
removed from the strategy first via update_debt" before `force_revoke_strategy`
(yearn/yearn-vaults-v3 @ 89ab996, `contracts/VaultV3.vy:1777-1788`). This design blocks that step.

**Impact.**
- Who can trigger it: an owner in dispute with guests, or a compromised or misused guardian. For the
  pilot the owner, the platform and the guardian are the same party.
- What it does: withholds guest refunds indefinitely, with no loss.
- Ping-pong: a write-off, recovery, write-off cycle by the two parties keeps it going, because the
  shortfall clears on each recovery and is never recognised.
- Deposits made during the write-off get an `accAtDeposit` that excludes the vault's hidden growth.
  On recovery that growth is shared with them (see R4). The amount is small.
- There is no theft. That, and the privileged precondition, is why this is Medium and not High.

**PoC.** `test_R2_healthyVaultWriteOffLocksGuestRefund` **fails as intended**:
`R2: healthy-vault write-off withholds the guest's refund: 561000000 != 5600000000`.
1. The guest deposits 5,600 USDC, and 90% is deployed to a healthy vault.
2. The owner writes the vault off.
3. The guest cancels in the 100% tier and claims 561 USDC. That is idle plus the reserve, although
   `maxWithdraw` covers the full amount.
4. The test also asserts two things that pass: a non-owner `recoverVault()` reverts
   `NotOwnerOrGuardian`, and `redeem` reverts `VaultIsWrittenOff`.

**Recommended fix.** Any of the following, each from audited practice. The owner should pick, and
record the choice in an ADR amending ADR 0013 §3.
1. **Timelock the write-off of a readable vault.** Allow it instantly only when the vault's views
   actually revert. Review 0002's F3 recommendation proposed this condition, and ADR 0013 dropped it.
   - MetaMorpho (morpho-org/metamorpho @ ded84e5), `src/MetaMorpho.sol:292-300`: removing a market
     that still holds supply goes through `submitMarketRemoval` with `removableAt = block.timestamp +
     timelock`.
   - Morpho Vault V2 (morpho-org/vault-v2 @ 9ee4dbd), `src/VaultV2.sol:349-370, 442-443`:
     `removeAdapter` is `timelocked()`.
   - No audited vault I found gates on "view reverts" directly. The instant path for a broken vault
     remains the project's own rule.
2. **Keep `redeem` working during a write-off.** Yearn's "remove all possible assets first". This is
   accounting-safe here:
   - before recognition, a redeem moves value from the excluded vault into idle, which shrinks the
     observed shortfall;
   - after recognition, redeemed USDC shows as a gain, which repays `lossDebt` first. That is the
     ADR 0013 recovery rule.
3. **Guarantee guests an exit that does not depend on the curator.** Vault V2's permissionless
   `forceDeallocate` does this (`src/VaultV2.sol:840-849`). The escrow analogue is a permissionless
   `recoverVault()`, which already reverts while the vault is broken. There is no direct precedent
   for making re-enable permissionless; `forceDeallocate` is the closest.

---

### R3 (Low): the escrowed-value cap does not bound what guests have exposed, and the owner sets it alone

**Description.** `deposit` checks `totalOpenPrincipal + price <= maxOpenPrincipalAtomic`
(`Escrow.sol:214`). Some guest money is also deployable (it counts in spec 6.3 liabilities) but not
counted by the cap:
- unclaimed guest refunds (`totalClaimable`)
- contested amounts (`totalDisputed`)
- deferred guest yield

So guest money exposed to a vault loss can exceed the cap. Separately, `setMaxOpenPrincipal` is
owner-only with no bound (`:452`), so the admin's approved figure is advisory.

**Impact.** Spec 12.3 makes the cap a pre-mainnet requirement "at a level the owner could cover". In
practice, refunds are usually claimed in the same bundle (ADR 0003), so the excess is small. This is
a design gap more than an exploit.

**PoC:** none; rated Low.

**Fix:**
- Count `totalOpenPrincipal + totalDisputed + guest-owed claimables` against the cap. Owner credits
  can be excluded; they absorb first.
- Or bound owner increases by an admin-approved ceiling, in the same shape as `maxFeeBps` bounding
  `feeBps`.

**Prior art:** Yearn V3's `deposit_limit` is checked against `_total_assets()`, all assets, not one
component (`contracts/VaultV3.vy:535-556`).

---

### R4 (Low): deposits during an observed shortfall or write-off

**Description.** Guard 5 checks only `paused` and `lossDebt` (`Escrow.sol:198-199`). ADR 0009 §2 and
ADR 0013 §3 gate owner and fee claims, `deploy` and reserve withdrawals on an observed shortfall, but
not deposits.

A guest can therefore pay into an escrow that is already short by at least 1 USDC and has not yet
recognised it. If the owner never tops up, the new guest's USDC pays earlier claimants first (spec
6.4, "priority, not guarantee").

**Impact:** Low. Spec 10.4 says the guardian pauses deposits off-chain on an INV-1 breach. This makes
it automatic.

**PoC:** none; rated Low.

**Fix:** extend guard 5 to `lossDebt == 0 && shortfallSince == 0 && !vaultWrittenOff`.

**Prior art:**
- Yearn V3 `shutdown_vault` sets `deposit_limit = 0`, so `_max_deposit` returns 0
  (`contracts/VaultV3.vy:1834-1851`, `:548-556`). It does this under a role, not automatically.
- MetaMorpho V1.1 books a loss into `lostAssets` on the next interaction, so no deposit enters at a
  stale pre-loss valuation (`src/MetaMorphoV1_1.sol:907-937`).

---

### R5 (Low): freeze and unfreeze depend on a live vault read

**Description.** `freezeBooking` and `unfreezeBooking` call `_accrue()` (`Escrow.sol:367`, `:382`).
Neither moves funds or changes an accounting parameter. With a broken vault and no write-off yet,
both revert:
- the guardian cannot freeze during the incident;
- the "anyone may unfreeze after 30 days" guarantee (ADR 0007 §3) stops working.

ADR 0013 §2 made pause a pure flag for exactly this reason.

**Fix:** drop `_accrue()` from both, as for pause.

**Prior art:** Aave `setReservePause` does not sync indexes, as cited in ADR 0013 §2.

---

### R6 (Low): the owner cannot pin what they consent to in `createEscrow`

**Description.**
- `approveOwner` fixes the fee terms (ADR 0007 §2). `createEscrow` then clones whatever
  `implementation`, `defaultVault` and `defaultArbitrator` hold at execution time.
- The admin can change all three instantly (`EscrowFactory.sol:136-150`), including between an
  owner's review and inclusion of their transaction.
- The escrow is immutable afterwards, and its code, vault and arbitrator bind every future guest.

**Impact:** Low. It needs a malicious or mistaken admin Safe, and `EscrowCreated` exposes the values,
so an owner can check them before taking bookings.

**Fix:** `createEscrow(expectedImplementation, expectedVault, expectedArbitrator, ...)`, reverting on
mismatch.

**Prior art:**
- Safe (safe-global/safe-smart-account @ f8fc2f2), `contracts/proxies/SafeProxyFactory.sol:86`:
  `createProxyWithNonce(address _singleton, ...)`. The caller names the implementation.
- MetaMorpho (`src/MetaMorphoFactory.sol:40-49`) has no swappable implementation at all.

---

### R7 (Low): vested yield is paid during an observed shortfall

**Description.**
- `LedgerLib.settle` (`:127`) and `DisputeLib.resolve` (`:138`) defer yield only when
  `lossDebt != 0`.
- During an observed but not yet recognised shortfall, a delivered stay credits `guestYield`
  straight into `guestClaimable`. The guest can claim it at once, because guest buckets are paid
  during a loss.
- The same state blocks the release of yield that was **already** deferred (`claim`, `:175-176`,
  "no loss active").

**Impact:** yield, which is junior to principal, is paid ahead of other guests' principal during the
window. If the recognised loss exceeds the reserve plus the owner's credits, the last guests are
short by that amount. Low: the amount is bounded by yield.

**Fix:** use `lossActive(l)` for the settlement deferral as well, as ADR 0009 did for claims.

**Prior art:** none specific. This follows the codebase's own ADR 0009 gate.

---

### R8 (Info): exact-ERC-4626 trust in vault calls

**Description:**
- `pullFromVault` ignores `withdraw`'s return value and does not check the USDC balance delta.
- `deploy` leaves any unspent `forceApprove` allowance in place if the vault pulls less than
  `assets`.

This is correct for compliant vaults, and ADR 0013 §1 limits approval to rate-priced or OpenZeppelin
vaults.

**Fix:**
- Optionally assert the balance delta on the pull.
- Reset the allowance to 0 after `deposit`.

**Prior art:** Yearn V3 `_update_debt` (`contracts/VaultV3.vy:1121-1134`) approves exactly the amount,
measures the balance delta around `IStrategy.deposit`, and resets the approval to 0. The withdraw side
(`:1058-1064`) also uses the measured delta.

---

### R9 (Info): merged event figures

**Description:**
- `Claimed(account, requested, paid)` does not say which bucket was debited.
- `PendingYieldReleased` merges guest and owner pending yield.
- `LossRecognised.fromOwner` merges the owner bucket and the owner's pending yield (ADR 0010 §5).

All of these can be reconstructed, but only if C6 replicates the contract's debit order and the
`isPayout` and loss-active state at that block. Money rule 7 is met, but fragilely.

**Fix:** add the split figures to the events (an `IEscrow` change, which needs an ADR).

---

## 3. PoC tests

File: `contracts/test/review/Review0004.t.sol`. Command: `forge test --match-path 'test/review/*' -vv`.

| Test | Finding | Result |
|---|---|---|
| `test_R1_freezeAcrossCutoffsCutsGuestRefund` | R1 | FAIL as intended: `0 != 5600000000` |
| `test_R1_freezeAcrossGraceRemovesDisputeRight` | R1 (GRACE part, C3 concern) | FAIL as intended: `DisputeTooLate()` |
| `test_R2_healthyVaultWriteOffLocksGuestRefund` | R2 | FAIL as intended: `561000000 != 5600000000` |

Each test asserts the property a guest would expect, so each should pass once its finding is fixed.
Until then, the default `forge test` run reports these three failures. Exclude them with
`--no-match-path 'test/review/*'` if a green run is needed before the owner decides.

## 4. Spec concerns (the spec itself looks wrong or ambiguous)

1. **Spec 3.5, freeze and time (R1).** The spec says frozen time does not extend `GRACE`, and says
   nothing about refund cutoffs, check-in or check-out. Both leave the guardian able to change
   economic outcomes, which contradicts spec 3.3 ("cannot move any funds") and the 6.4 required
   test. ADR 0011 already reversed the same rule for `DISPUTE_WINDOW`.
2. **ADR 0013 §3, write-off scope (R2).** "Harms only the owner first" is true of accounting and not
   of liquidity. The ADR's precedent (Yearn) drains before writing off, and its alternative
   precedents (MetaMorpho, Vault V2) timelock the removal.
3. **Spec 12.3 and ADR 0007 §4, the cap (R3).** A cap "at a level the owner could cover" that the
   owner sets alone, and that counts only open principal, does not bound guest exposure.
4. **Spec 4.2 guard 5 and spec 4.4 deferral vs ADR 0009 (R4, R7).** ADR 0009 made an observed
   shortfall equivalent to `lossDebt` for claims, deploys and reserve withdrawals. It left deposits
   and settlement yield deferral keyed on `lossDebt` alone. The spec should state one rule for "loss
   active".
5. **Liquidity crunch without a loss.** Guest priority (spec 4.5) applies only while a loss is
   active. In a pure liquidity crunch (for example, Aave at 100% utilisation), owner and fee claims
   compete with guest refunds for the 10% idle buffer on a first-come basis. Spec 6.7 keeps
   claimables liquid off-chain only. The owner should decide whether guest-first also applies when
   `maxWithdraw` is short.
6. **Independence of the guardian.** Several abuse bounds (R1, R2, reserve co-signing) assume the
   guardian is independent of the owner. Spec 7 requires that independence before mainnet for the
   arbitrator only. It should say the same for the guardian.

## 5. Checked and found correct

- **Deposit guards 1 to 12** (spec 4.2):
  - in the spec's order, each with its own custom error;
  - the cap sits between guards 11 and 12 (ADR 0007 §4);
  - the balance delta is checked (`_pullExact`);
  - the effective arbitrator is snapshotted after timelock promotion;
  - every term in spec 4.2 is stored, and `BookingDeposited` carries all of them.
- **Refund maths** (spec 4.3): `QuoteLib.refundBps`, strict `<` on cutoffs, `finalBps` from
  check-in, `NotCancellable` from check-out. `cancelByProperty` gives 10,000 bps and only before
  check-in.
- **Settlement** (spec 4.4, `SettlementLib.compute`):
  - refund `mulDiv(..., Ceil)`, fee floor on `retained`, owner remainder;
  - `guestY` floor, `ownerY = y - guestY`;
  - D3 non-vested yield goes to the owner;
  - the three equalities hold by construction;
  - the dispute split holds across open and resolve (ADR 0011 §1).
- **Accumulator** (spec 6.1, ADR 0009, 0010):
  - high-water mark: `lastAssets` is lowered only in `recogniseLoss`;
  - gains repay `lossDebt` first, then go to the reserve when no principal is open;
  - `yieldUnallocated` absorbs round-down dust.

  I checked that the sum of per-booking `y` never exceeds `yieldUnallocated`:
  `floor(p·ΣΔA/1e18) ≤ Σ p·ΔA/1e18`, and at each distribution `Σ p_open·ΔA ≤ gain·1e18`, because
  the accumulator's denominator equals the sum of open principals, FROZEN included and DISPUTED
  excluded.
- **Books identity** (LedgerLib header): verified by hand for every state-changing path. The paths
  are deposit, cancel, settle, dispute open and resolve, claim (with and without release),
  `fundReserve`, `topUpLoss`, reserve withdrawal, `recogniseLoss` and `accrue`.
- **Money rule 5:** every USDC inflow and outflow changes `lastAssets` by exactly the amount moved.
  `deploy` and `redeem` are internal moves.
- **Loss handling** (spec 6.4, ADR 0010 §5):
  - absorption order: reserve, then the owner bucket, then the owner's pending yield, then
    `lossDebt`;
  - recognition only after the window, measured at call time;
  - the 1 USDC threshold on both observation and clearing;
  - `topUpLoss` takes `min(amount, debt)`;
  - `deploy` is blocked on debt or a shortfall; `redeem` is allowed.
- **Claims** (spec 4.5, ADR 0007 §1):
  - zero-claimable returns 0;
  - guest bucket only while a loss is active, and owner-only or fee-only callers revert;
  - partial pay bounded by `maxWithdraw`;
  - all state is written before `withdraw` and `transfer`;
  - the vault is always called with `receiver = owner = escrow`.
- **Reserve** (spec 6.5, ADR 0009 §3, 0010 §6, 0013 §5):
  - two-party, with an exact-proposal match;
  - pays the current payout address;
  - blocked on a loss;
  - the floor applies while a vault is configured and anyone is owed;
  - `deploy` requires the floor and a seeded vault.
- **Disputes** (spec 7, ADR 0011):
  - guest only;
  - DELIVERED and inside GRACE;
  - `0 < contested <= principal`;
  - `y` is crystallised into pending at open, and the uncontested part settles with the fee;
  - only the snapshotted arbitrator can resolve;
  - `DEFAULT_TIMEOUT` is reserved;
  - the deadline is extended by frozen time after opening;
  - yield is deferred on `lossDebt`.
- **Roles and timelocks** (spec 3.3, 3.4):
  - `proposeFeeBps` is bounded by `maxFeeBps` and is 7 days;
  - effective values are promoted before overwrite (ADR 0007 §5), including the factory's
    `proposeFeeRecipient`;
  - the fee recipient is read at settlement, and the arbitrator is snapshotted at deposit;
  - owner setters cannot touch booking terms;
  - `renounceOwnership` is disabled in both contracts;
  - the rebalancer can only move funds between the escrow and its vault.
- **EIP-712:**
  - the type string, including the appended `Cutoff` type and array hashing, matches the spec 4.1
    struct;
  - the domain is bound to the clone address and chain ID;
  - `EIP712Upgradeable` in 5.6.1 recomputes the separator with `address(this)` and
    `block.chainid`, so there is no stale cache on a fork;
  - `bookingId = hashStruct` is not affected by signature malleability;
  - replay is prevented by `BookingExists` and by the signer being read live (rotation invalidates
    old quotes);
  - ERC-1271 goes through `SignatureChecker.isValidSignatureNowCalldata`.
- **Permit:** the try/catch absorbs a front-run permit, and the permit is for `msg.sender` only.
- **Clones:**
  - the implementation calls `_disableInitializers()`;
  - `initialize` runs in the same transaction as `Clones.clone`;
  - OpenZeppelin parents use ERC-7201 namespaced storage, and the reentrancy guard is transient;
  - libraries are called by DELEGATECALL, and Solidity's library call-protection blocks direct calls
    to state-changing library functions.
- **Freeze budget** (ADR 0007 §3): cumulative, capped, and permissionless unfreeze after the budget
  (see R1 and R5 for the gaps).

**Ruled out** (false-positive candidates):
- **Donation-driven yield:** the donor loses the funds.
- **Owner turning owner credits into guest credits during a loss:** no path exists.
- **Yield sniping by a quote holder:** vesting needs a completed stay, and the principal then goes to
  the owner.
- **Guard 5 before `accrue`:** conservative, and in the spec's order.
- **`yieldUnallocated` underflow:** proved above.
- **Reentrancy through the vault or USDC:** `nonReentrant` on every state-changing function, and CEI
  in `claim`.
- **Inflation attack:** the seed, offset and `VaultMintedNoShares` bound the residual (ADR 0013 §1).
