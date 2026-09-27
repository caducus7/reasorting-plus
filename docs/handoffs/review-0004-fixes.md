# Review 0004 fixes handoff

## Done

- **Review merged.** The independent contracts review (review 0004, a separate agent that wrote no
  code) is merged. Its three PoCs reproduced as stated, then pass after the fixes.
- **Fixes**, per [ADR 0015](../adr/0015-review-0004-fixes.md), each with audited prior art:
  - **R1:** a freeze stops the booking's clock. `settle` moves with it; `cancelByProperty` keeps
    real time.
  - **R2:** a written-off vault still pays out. `redeem` is allowed, and `claim` pulls best effort.
    The pulled value is booked before paying.
  - **R5:** freeze and unfreeze do not read the vault.
  - **R7:** yield is deferred while any loss is active.
- **Accepted as designed** (the owner allowed privileged powers): R3, R4, R6, R8. R9 is passed to
  C6's brief.
- **Quote service:** the refund previews (`GET /v1/bookings`, cancel-preview) use the booking clock.
- **Docs:** spec 3.5 and 6.4, the ADR table, CLAUDE.md "designs that look like bugs", ADR 0013 §3
  (amendment note), and review 0004 (disposition).

## Not done

- The fork test for the stranded-vault path against the real Aave wrapper is left to C4 (D5 still
  open).

## Tests

```
cd contracts
forge test                                  240 passed, 0 failed, 1 skipped (fork, needs BASE_RPC_URL)
FOUNDRY_PROFILE=ci forge test               238 passed, 0 failed, 1 skipped; 27 invariants at
                                            1,000 runs, 0 reverts (run before the last 2 unit tests)
BASE_RPC_URL=https://mainnet.base.org forge test --match-path 'test/fork/*'   7 passed
forge coverage (no fork)                    100% lines/statements/branches/functions on Escrow,
                                            EscrowFactory and every library (LedgerLib 46/46 branches)
forge build --sizes                         Escrow 21,812 B (2,764 B under EIP-170)
slither src --exclude-dependencies          38 results; 5 are new, all triaged below

cd services && pnpm -r test                 abi up to date (ABIs unchanged); quote-service 73 passed
cd services/apps/quote-service && pnpm test:anvil   5 passed
```

**Slither's new results:**
- `_pullStranded`: "strict equality" (`pull == 0`, benign); "unused return" (deliberate: the
  balance delta is measured instead, per Yearn); "reentrancy" (the vault call precedes the booking
  accrue; `claim` is `nonReentrant` and the vault is factory-approved).
- `_bookingNow`: timestamp use (by design).

**Test changes that follow the amended spec** (listed in ADR 0015 §Tests): three unit tests, one
C9 adversarial test, the C1 handler and C9's model. No property was weakened; each test asserts
the new timing or behaviour explicitly.

## Deviations from spec

None. The spec is amended by ADR 0015.

## Spec concerns

- **R3:** the escrowed-value cap does not bound unclaimed refunds or disputed amounts, and the owner
  sets it alone.
- **R4:** deposits are accepted during an observed shortfall or a write-off.
- **From the review:** in a pure liquidity crunch there is no guest-first rule, and the guardian
  would need the same independence from the owner that spec 7 asks of the arbitrator.
- **R1 trade-off:** if a freeze that began before check-in overlaps the stay, the guest can cancel
  mid-stay at the tier they held when frozen. The owner carries the platform's freeze.

## Interfaces changed

None. `IEscrow`, `IEscrowFactory`, the events and the ABIs are unchanged.

## Blocked

Nothing.
