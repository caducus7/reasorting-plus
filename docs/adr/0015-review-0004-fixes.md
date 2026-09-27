# 0015: fixes from the independent contracts review (review 0004)

**Status:** Accepted. The project owner said "do the recommended calls and continue", and set the
standing rule that every fix follows audited prior art.

**Amends:** spec 3.5 (frozen time), 6.4 (yield deferral), 6.5 and 6.6 (write-off liquidity), and
ADR 0013 §3.

**Interfaces:** no `IEscrow` or `IEscrowFactory` change. The ABIs are regenerated and unchanged.

**Source:** [review 0004](../reviews/0004-contracts-spec-review.md). Its PoCs
(`contracts/test/review/Review0004.t.sol`) failed as stated before the fixes and pass after.

## 1. A freeze stops the booking's clock (R1, Medium)

**Change.** Every booking time check now runs on the **booking's clock**,
`block.timestamp − frozenTotal`, except the owner's:

| Check | Clock |
|---|---|
| `cancelByGuest`: refund tier and the `NotCancellable` bound | booking clock |
| `openDispute`: `NotDelivered` / `DisputeTooLate` | booking clock |
| `settle`: `SettleTooEarly` | booking clock |
| `bookingState`, `refundBpsNow` views | booking clock |
| `cancelByProperty`: `PropertyCancelTooLate` | **real time**, so an owner cannot evict a guest mid-stay |

**Why `settle` moves too.** The review suggested leaving it on real time. That leaves a hole: while
the guest's shifted dispute window is open, anyone could settle first and remove the dispute right.

**Precedent.**
- Aave's `setReservePause(asset, paused, gracePeriod)` sets a liquidation grace period on unpause
  (`PoolConfigurator.sol:239-256`), enforced in `ValidationLogic.sol:274-277`. Users are not
  penalised for time they were locked out.
- ADR 0011 §3 already extends the dispute deadline by frozen time.

**Bound.** The total shift is bounded by the 30-day freeze budget (ADR 0007).

**Known consequence.** If a freeze starts before check-in and overlaps the stay, the guest's policy
clock lags the real stay. The guest may cancel during the stay at the tier they held when frozen.
The platform chose to freeze, so the owner, not the guest, carries that cost.

The C5 quote service previews refunds on the same clock (`frozenTotal` in its read model).

## 2. A written-off vault still pays out (R2, Medium)

**Change.** While `vaultWrittenOff`:
- `redeem` stays allowed;
- `claim` first pulls what the vault can pay towards the claim, best effort (`_pullStranded`):
  - `maxWithdraw` and `withdraw` are each wrapped in try/catch, and the balance delta is measured;
  - the pulled value is booked by an accrue **before** paying. Before recognition it narrows the
    shortfall. After recognition it is a gain that repays `lossDebt` first (ADR 0013 §3).

A write-off of a healthy vault therefore no longer withholds guest refunds. A broken vault simply
yields nothing.

**Precedent.**
- Yearn V3 `force_revoke_strategy`: "All possible assets should be removed from the strategy first"
  (`VaultV3.vy:1777-1788`). `_update_debt` measures the actual amount withdrawn
  (`:1057-1064`).
- MetaMorpho uses try/catch to skip a market whose withdraw reverts, rather than failing the user's
  exit (`MetaMorphoV1_1.sol:839-840`).
- Valuation reads stay live and are never wrapped (review 0002).

**Found while testing.** Paying the pulled value without booking it first underflowed `lastAssets`
after a recognised loss. The accrue-before-pay step fixes that, and a test covers it.

**Rejected alternatives.**
- **A timelock on writing off a readable vault** (MetaMorpho `submitMarketRemoval`). With withdrawals
  still working, a timelock would only delay the response to a compromised-but-readable vault. The
  owner allowed privileged action.
- **A permissionless `recoverVault`.** It could re-enable a compromised vault's valuation.

## 3. Freeze and unfreeze do not read the vault (R5, Low)

`freezeBooking` and `unfreezeBooking` no longer call `accrue()`. They move no funds and change no
accounting parameter, so they follow the rule ADR 0013 §2 set for pause (Aave's pause does not sync
indexes). A broken vault no longer blocks the guardian's freeze, or the permissionless unfreeze
after the budget.

## 4. No yield is paid during an observed shortfall (R7, Low)

Settlement and dispute resolution now defer yield credits whenever a loss is **active**: `lossDebt >
0` **or** a shortfall is observed. Before, only `lossDebt > 0` deferred them. Deferred yield is
released on claim once no loss is active, which was already the rule for release. Yield can
therefore never be paid ahead of guest principal during a loss (ADR 0009 guests-first).

## 5. Findings accepted without a code change

| Finding | Disposition |
|---|---|
| R3 (Low): the value cap counts open principal only, and the owner sets it | Accepted. The owner and platform hold privileged powers by decision. Recorded as a spec concern. |
| R4 (Low): deposits during an observed shortfall or write-off | Accepted as specified. Spec 6.4 gates deposits on `lossDebt` only, and deposits add no exposure to the missing assets. Recorded as a spec concern. |
| R6 (Low): `createEscrow` cannot pin the implementation, vault or arbitrator | Accepted: platform-privileged, per the owner. |
| R8 (Info): exact ERC-4626 trust | Accepted. Vaults are factory-approved (ADR 0013 §1). The new stranded-vault path measures balance deltas. |
| R9 (Info): merged claim buckets in events | For C6: the indexer replicates the contract's debit order (guest, then fee, then owner). Noted in the C6 brief. |

## Tests

- `test/review/Review0004.t.sol`: the reviewer's 3 PoCs now pass. In the R2 PoC, the one line that
  asserted `redeem` reverts now asserts that it succeeds.
- `test/unit/Review0004Fixes.t.sol`, 7 tests:
  - settle cannot pre-empt a tolled dispute;
  - property cancel keeps real time;
  - freeze works with a broken vault;
  - yield is deferred during a shortfall and released after;
  - a written-off vault pays the full refund, and the recovery repays debt;
  - the idle-only early return;
  - a vault with no liquidity.
- Tests updated to the amended rule:
  - `test_unfreeze_restoresClockDerivedState`, `test_freezeBeforeOpenDoesNotExtend`,
    `test_F3_accessAndStateGuards`;
  - the C9 adversarial freeze-budget test;
  - the C1 `EscrowHandler`, which now uses the booking clock;
  - C9's model: booking clock, no accrue in freeze/unfreeze, yield deferred while a loss is active,
    and the drain waiting out frozen time.
