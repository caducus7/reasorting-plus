# Direct Booking Platform: Chain Spec (canonical)

**Status:** canonical and standalone. This is the only chain document agents read. It merges
`booking-platform-spec-v2.md` with `chain-spec-v3-delta.md` and corrects four errors found in
v3 during the merge (section 15.2). Where any earlier document disagrees, this one wins.
Amended by the accepted ADRs listed in section 16; amended text is marked "(ADR NNNN)".

**Scope:** the chain workstream only: contracts, quote service, indexer, channel sync,
rebalancer, and the stub API. The guest agent, widget, checkout UI and owner dashboard are
specified in `agent-spec-v1.md` and built by a separate workstream. Section 11 is the boundary.

**Conventions**
- USDC atomic units (6 decimals) everywhere. No floats in contracts or money paths.
- Basis points: 10,000 = 100%.
- "Owner" is the property owner who controls an escrow. "Platform" is the operator that
  deploys the factory and receives the booking fee.
- Legal and regulatory clearance is handled separately by the project owner and is **not** an
  engineering gate. Do not add compliance features that this spec does not ask for.

---

## 1. What this is

A direct booking engine for independent property owners. Guests book on the owner's website,
through a conversational agent or a standard checkout, and pay in USDC on Base. Funds sit in an
escrow contract belonging to that owner until the stay completes. Idle float earns yield in the
meantime, and the yield is shared between the guest and the owner.

**Pilot:** one luxury villa in Crete, one bookable unit. The contracts are multi-owner from day
one through the factory. Operations are single-owner until the pilot completes.

**Positioning.** The competitive set is direct booking engines and channel managers. The owner
case, in order of weight: lower cost than OTA commission; stablecoin settlement with no
chargebacks; yield on prepayment float; an AI concierge. Yield is a feature, not the headline.

---

## 2. Settled decisions

| Decision | Value |
|---|---|
| Chain | Base mainnet; Base Sepolia for testnet. Fork tests against Base mainnet |
| Token | Native USDC only |
| Custody | One escrow per owner, deployed by `EscrowFactory` as EIP-1167 clones |
| Upgrades | None. Immutable clones. New versions via a new implementation in the factory; owners migrate by draining |
| Guest payers | Crypto-native; smart wallets with passkeys expected |
| Agent autonomy | Agent prepares, guest signs. The agent never holds keys or spends |
| Arbitration | Centralised multisig |
| Yield split | Guest and owner only. `guestYieldBps` default 5,000, owner-configurable. Owner takes the remainder |
| Platform revenue | Booking fee only. No yield share |
| Fee | `feeBps` of the amount the owner retains, deducted from the owner's side, paid to the platform fee recipient |
| Yield vesting | Guest share vests only on a completed stay with no refund to the guest |
| Non-vested yield | Goes to the owner (D3 default) |
| Loss absorption | Owner. Guest claims are paid first. The platform is never a backstop |
| Reserve | Optional, owner-funded. No yield skim |
| Term locking | Price, cutoffs, `feeBps`, `guestYieldBps` and arbitrator are fixed per booking at deposit |
| Overlap prevention | Off-chain only. The contract guarantees a booking's terms, not that the room was free |

---

## 3. Contract architecture

### 3.1 Why one escrow per owner

One escrow per owner means each owner holds their own guests' prepayments. A bug, freeze or loss
is contained to one owner, and the platform is never the loss absorber for anyone else's float.
Pooling saves almost nothing: every Aave supplier earns the same rate.

### 3.2 Contracts

```
EscrowFactory        deploys EIP-1167 clones of the current Escrow implementation;
                     holds platform-level config (fee recipient, defaults, MAX_FEE_BPS)
Escrow               one per owner; bookings, claims, disputes, yield accounting, loss handling
IYieldAdapter        interface
  NullAdapter        holds USDC idle
  MockYieldAdapter   testnet and demos; settable yield rate and withdrawable liquidity
  AaveV3Adapter      production; tested only on a Base mainnet fork
```

There is no on-chain policy registry. Cancellation policies are materialised off-chain and
committed inside a signed quote (section 5). The human-readable policy is published off-chain and
referenced by `policyHash`.

### 3.3 Roles

| Role | Scope | Set by | Powers | Cannot |
|---|---|---|---|---|
| `factoryAdmin` | Factory | Deployer; must be a Safe | Propose `feeBps` per escrow (timelocked); propose fee recipient (timelocked); propose arbitrator changes (timelocked); set defaults and implementation for **new** escrows | Move funds; change anything on existing bookings |
| `owner` | Escrow | Factory at creation | Set payout address, rotate `quoteSigner`, set `guestYieldBps`, set `minNightlyAtomic`, set `maxDeployBps`, fund reserve, `topUpLoss`, set `rebalancer` | Move escrowed funds; touch open disputes; change fee |
| `quoteSigner` | Escrow | Owner | Sign quotes (EOA via KMS, or ERC-1271 contract) | Anything on-chain directly |
| `arbitrator` | Per booking | Snapshotted from escrow at deposit | `resolve` on that booking's dispute only | Send funds to any address not stored on the booking |
| `guardian` | Escrow | Factory default | `pauseDeposits`, `unpauseDeposits`, `freezeBooking`, `unfreezeBooking`; co-sign reserve withdrawal | Move any funds |
| `rebalancer` | Escrow | Owner | `deploy`, `redeem` within on-chain caps | Move funds anywhere except between escrow and its own adapter |

`quoteSigner` is the most sensitive off-chain key: a compromised signer can issue quotes at any
price down to the floor. The contract bounds the damage with `priceAtomic >= minNightlyAtomic *
nights` and the economic equality checks in section 4.2. Keep the key in a managed KMS, never on
an application server's disk.

### 3.4 Economic configuration

```solidity
// Factory (immutable in the implementation)
uint16 constant MAX_FEE_BPS          = 2_000;     // absolute ceiling for any escrow
uint32 constant FEE_CHANGE_DELAY     = 7 days;
uint32 constant FEE_RECIPIENT_DELAY  = 7 days;
uint32 constant ARBITRATOR_DELAY     = 7 days;

// Factory (mutable, timelocked)
address feeRecipient;           // read at settlement by every escrow
address pendingFeeRecipient;
uint64  pendingFeeRecipientAt;

// Per escrow
uint16 immutable-at-init maxFeeBps;  // <= MAX_FEE_BPS, fixed at creation, owner consents
uint16 feeBps;
uint16 pendingFeeBps;
uint64 pendingFeeAt;                 // 0 if nothing pending
uint16 guestYieldBps;                // owner-set, 0..10_000, instant
address arbitrator;                  // current; snapshotted onto each booking at deposit
address pendingArbitrator;
uint64  pendingArbitratorAt;
```

Timelocked values apply lazily and are pure functions of time:

```solidity
function effectiveFeeBps() public view returns (uint16) {
    return (pendingFeeAt != 0 && block.timestamp >= pendingFeeAt) ? pendingFeeBps : feeBps;
}
```

Promote pending values into current storage on the next state-changing call. Emit an event when a
change is proposed, carrying `effectiveAt`, so the indexer can compute the effective value at any
block without calls.

**Why the owner's split change is instant and the fee change is timelocked.** The split only
affects quotes the owner's own signer will issue. The fee is set by a different party and taken
from the owner's money, so the owner gets notice, and `maxFeeBps` is a hard ceiling no timelock can
exceed.

**Why the fee recipient is read at settlement.** If the platform's fee address is compromised, the
replacement should receive future settlements. A fee already credited as a claim belongs to the
address it was credited to.

**Why the arbitrator is snapshotted per booking.** The guest agreed to an arbitrator when they
paid. Without the snapshot, a change proposed after the booking would govern its dispute.

### 3.5 Booking states

```
ESCROWED ──cancelByGuest (now < checkOut)─────────────▶ SETTLED
    │     ──cancelByProperty (now < checkIn)───────────▶ SETTLED
    │     ──freezeBooking──▶ FROZEN ──unfreezeBooking──▶ ESCROWED
    │
    └── now >= checkOut: DELIVERED (derived from time, no transaction)
            │
            ├── openDispute (now < checkOut + GRACE) ──▶ DISPUTED
            │                                              │
            │                    resolve / resolveByDefault│
            │                                              ▼
            └── settle (permissionless, now >= checkOut + GRACE) ──▶ SETTLED
```

- `DELIVERED` is derived from time. Nobody asserts delivery.
- `SETTLED` credits claimable balances. It never transfers.
- `FROZEN` halts every transition on the booking, including time-derived delivery and settlement.
  The guardian may freeze an `ESCROWED` or `DISPUTED` booking; unfreeze restores the frozen-from
  state. Each booking has a cumulative 30-day freeze budget, after which anyone may unfreeze and it
  cannot be frozen again (ADR 0007).
  It never moves funds. **A freeze stops the booking's clock** (ADR 0015 §1). Cancellation tiers,
  delivery, the dispute window and settlement all run on `now − frozenTotal`, so the guest keeps the
  time they were locked out of. `cancelByProperty` keeps real time.
- `cancelByGuest` is allowed until `checkOut`. Before `checkIn` the refund comes from the cutoffs;
  from `checkIn` onward (no-show or early departure) it is `finalBps`.
- `cancelByProperty` refunds 100% of principal regardless of policy.

---

## 4. Escrow core (work package C1)

### 4.1 Quote

The escrow verifies a quote signed by its `quoteSigner` under EIP-712, with the domain bound to
the escrow's address and chain ID. Verify with OpenZeppelin `SignatureChecker` so the signer may be
an EOA (KMS) or an ERC-1271 contract.

```solidity
struct Cutoff { uint40 cutoffUtc; uint16 refundBps; }

struct Quote {
    bytes32  resourceId;
    uint40   checkInUtc;
    uint40   checkOutUtc;
    uint256  priceAtomic;
    uint16   feeBps;          // must equal effectiveFeeBps() at deposit
    uint16   guestYieldBps;   // must equal guestYieldBps at deposit
    bytes32  policyHash;      // published human-readable policy
    Cutoff[] cutoffs;         // earliest first, 1..8
    uint16   finalBps;        // refund from checkIn until checkOut
    address  guest;           // bound when the guest confirms
    uint40   expiresAt;
    bytes32  salt;
}

bookingId = EIP-712 hashStruct(quote)
```

### 4.2 Deposit

Two entry points. Both run the same guards and the same storage write.

```solidity
// Primary. Requires prior allowance. Smart wallets batch approve + deposit in one call bundle
// (ERC-4337 user operation or EIP-5792 wallet_sendCalls).
function deposit(Quote calldata q, bytes calldata quoteSig) external;

// EOA convenience. Calls USDC permit inside try/catch, then proceeds if allowance suffices,
// so a front-run permit cannot grief the deposit.
function depositWithPermit(Quote calldata q, bytes calldata quoteSig,
                           uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) external;
```

Why the permit path is secondary: USDC's `permit` validates smart-wallet signatures only for
deployed wallets, and a new passkey wallet is often undeployed at first use. The batched path works
for both cases. Confirm the exact permit interface of Base USDC on the fork before implementing the
second entry point.

Guards, in order, all reverting with custom errors:

1. `SignatureChecker.isValidSignatureNow(quoteSigner, digest, quoteSig)`
2. `msg.sender == q.guest`
3. `block.timestamp <= q.expiresAt`
4. `bookingId` unused
5. `depositsPaused == false` and `lossDebt == 0`
6. `block.timestamp < q.checkInUtc < q.checkOutUtc`
7. `nights = ceilDiv(checkOut - checkIn, 1 days)`, `1 <= nights <= MAX_NIGHTS`
8. `q.priceAtomic >= minNightlyAtomic * nights`
9. `q.feeBps == effectiveFeeBps()` (so a signer cannot waive the platform fee)
10. `q.guestYieldBps == guestYieldBps` (so a stale quote cannot carry old terms)
11. Cutoffs: `1 <= length <= 8`, `cutoffUtc` strictly increasing, all `< checkInUtc`,
    `refundBps` non-increasing, every value `<= 10_000`, `finalBps <= last refundBps`
12. `accrue()`, then `transferFrom` of exactly `priceAtomic`; check the balance delta equals
    `priceAtomic`

Store per booking: `guest`, `resourceId`, `checkInUtc`, `checkOutUtc`, `principalAtomic`,
`feeBps`, `guestYieldBps`, `arbitrator`, packed cutoffs, `finalBps`, `state`, `accAtDeposit`.

A quote issued just before a config change reverts at guard 9 or 10. The quote service re-quotes
and the guest sees the new terms before signing again (section 5.2).

### 4.3 Refund maths

```
refundBps(now):
    if now >= checkOut: revert NotCancellable
    if now >= checkIn:  return finalBps
    for c in cutoffs:   if now < c.cutoffUtc: return c.refundBps
    return finalBps

cancelByProperty:       refundBps = 10_000
delivered settlement:   refundBps = 0
```

### 4.4 Settlement maths

Every path that ends a booking (cancel, settle, dispute resolution) runs `accrue()` first and then
this function once. For disputes, see section 7 for how the principal is split across two calls.

```
refund    = ceilDiv(principal * refundBps, 10_000)        // guest rounds UP
retained  = principal - refund
fee       = retained * feeBps / 10_000                    // rounds DOWN
ownerPrin = retained - fee

y = principal * (accYieldPerUnit - accAtDeposit) / 1e18   // booking's realised yield

vested = (outcome is delivered settlement)
      or (outcome is dispute resolved with guestBps == 0, incl. resolveByDefault)

if vested:
    guestY = y * guestYieldBps / 10_000                   // rounds DOWN
    ownerY = y - guestY
else:
    // INTENTIONAL: guest's yield share goes to the owner on every non-vested outcome,
    // including cancelByProperty and disputes the guest wins (decision D3). Do not "fix".
    guestY = 0
    ownerY = y

guestClaimable[guest]           += refund + guestY
ownerClaimable                  += ownerPrin + ownerY   // paid to the current payoutAddress (ADR 0007)
feeClaimable[feeRecipient()]    += fee
```

**Fee basis (D1).** On a completed stay `refund = 0`, so the fee is exactly `feeBps` of the booking
price. On a partial refund, the fee applies only to what the owner retains. A fee on the gross price
could exceed the owner's share of a 95% refund and make the owner's payout negative.

**The fee never applies to yield (D2).**

**While `lossDebt > 0`**, `y` for bookings settling is still computed but the owner's and guest's
yield credits are deferred into `pendingYield` until the debt is repaid (section 6.4). Principal
settlement is unaffected.

Fuzzed equalities, per booking and summed:

```
refund + ownerPrin + fee == principal
guestY + ownerY          == y
fee <= retained
```

### 4.5 Claims

```solidity
function claim() external;   // pays min(claimable[msg.sender], liquid available)
```

- `claim` redeems from the vault when idle funds are short, bounded by `maxWithdraw(escrow)`, best
  effort: a failing vault call pays from idle funds and never reverts the claim (ADR 0016).
- If the adapter cannot supply the full amount, it pays what it can and leaves the rest
  claimable. **Crediting never reverts.** Only the transfer can be partial.
- While `lossDebt > 0` **or a shortfall is observed** (ADR 0009), only guest credits are paid. A
  caller holding only owner or fee credits reverts. Guest claims proceed, first from idle funds, then
  from the vault. A claim with nothing claimable returns 0 (ADR 0007).
- A USDC-blacklisted address keeps its claim pending. There is no redirect function.

### 4.6 Settle

`settle(bookingId)` is permissionless once `now >= checkOut + GRACE` and the booking is not
disputed or frozen. A property never depends on the guest to release funds.

### 4.7 Events

Events must carry enough data to rebuild both projections (section 10) without contract calls.
Minimum set: `EscrowCreated`, `BookingDeposited` (full terms), `BookingCancelled`,
`BookingSettled` (all six settlement figures), `DisputeOpened`, `DisputeResolved`,
`Claimed` (requested and paid), `Deployed`, `Redeemed`, `YieldAccrued`, `LossRecognised`,
`LossRepaid`, `LossToppedUp`, `ReserveFunded`, `ReserveWithdrawn`, `FeeChangeProposed`
(with `effectiveAt`), `FeeRecipientProposed`, `ArbitratorChangeProposed`, `GuestYieldBpsSet`,
`MinNightlySet`, `PayoutAddressSet`, `QuoteSignerRotated`, `RebalancerSet`,
`Paused`, `Unpaused` (OpenZeppelin Pausable, ADR 0007), `BookingFrozen`, `BookingUnfrozen`,
`MaxDeployBpsSet`, `MaxOpenPrincipalSet`.

---

## 5. Quote service (work package C5)

### 5.1 Materialisation

Owner policies are written in the property's local terms, for example "full refund until 18:00
local, 30 days before arrival". The service converts each rule to an absolute UTC instant using the
property's IANA time zone at quote time. The contract never sees a time zone or DST.

Policy validation runs here and again on-chain (guard 11). The service rejects a policy that would
produce a non-monotonic curve before it reaches a guest.

### 5.2 Two-step issuance

1. **Offer.** Returns an unsigned offer for display, with a 25-minute price lock and a soft hold on
   the room in the calendar projection.
2. **Prepare.** When the guest confirms and connects a wallet, the service re-checks availability
   against every imported channel calendar, reads the escrow's live `effectiveFeeBps()` and
   `guestYieldBps`, binds `guest`, signs, and returns the signed quote plus the call bundle.

Rules:
- If a fee change is pending, `expiresAt` is capped at `pendingFeeAt - 60s`, so no quote can straddle
  a fee change.
- A deposit reverting with the fee or split mismatch error triggers a fresh prepare, never a retry of
  the same quote.
- One active soft hold per resource per date range. Excess requests for the same slot queue or fail.
- The guest's email is collected at prepare and stored off-chain against `bookingId`. It never goes
  on-chain.

### 5.3 Service API (the boundary with the agent workstream)

HTTP, JSON, versioned under `/v1`. Money fields are strings of atomic units. C0 stubs this exact API
in week 1. Changes need both workstreams to agree.

```
GET  /v1/availability?checkIn&checkOut&guests
  → [{ resourceId, name, nights, priceAtomic, policyId }]

POST /v1/offers   { resourceId, checkIn, checkOut, guests, locale, sessionId? }
  → { offerId, priceAtomic, checkInLocal, checkOutLocal, tz, policyId,
      renderedPolicy, refundCurve: [{ untilLocal, refundBps }], expiresAt }

POST /v1/offers/{offerId}/prepare   { guestAddress, email, sessionId? }
  → { bookingId, quote, quoteSig, calls: [{ to, data, value }], expiresAt }
  | 409 { error: "unavailable" } | 409 { error: "terms_changed" }

GET  /v1/bookings/{bookingId}                    (guest auth)
  → { state, checkInLocal, checkOutLocal, priceAtomic, refundIfCancelledNowAtomic,
      accruedYieldAtomic, guestYieldBps, txHash }

POST /v1/bookings/{bookingId}/cancel-preview     (guest auth)
  → { refundAtomic, refundBps, guestYieldForfeitedAtomic, calls: [...] }

GET  /v1/yield/terms?offerId|bookingId
  → { guestYieldBps, vestingRule, apyEstimateBps, estimatedGuestYieldAtomic,
      protocol, asOf }
```

- The agent's "quote" in `agent-spec-v1.md` is an `offerId` here; its `prepare_booking` produces a
  checkout link carrying `offerId` and `sessionId`, and the checkout page calls `prepare`.
- `feeBps` never appears in agent-facing responses. It is inside `quote` in the prepare response,
  which only the checkout page consumes. `/v1/yield/terms` returns everything; the agent layer
  filters by its disclosure allowlist.
- `estimatedGuestYieldAtomic` uses the deployment window in section 8 and is always labelled an
  estimate.
- Guest auth: a short-lived JWT issued by the checkout backend after Sign-In with Ethereum for the
  booking's guest address, or after a magic link to the booking email (decision D7).

---

## 6. Yield (work packages C2, C4, C8)

### 6.1 Attribution: accumulator over realised yield

Principal stays nominal and is never share-priced, so a loss cannot quietly reduce what a guest is
owed. Realised gains are distributed pro rata over open principal, the same pattern staking
contracts use.

```solidity
uint256 totalOpenPrincipal;   // ESCROWED + DELIVERED-unsettled + FROZEN bookings
uint256 totalDisputed;        // contested principal awaiting resolution
uint256 totalPendingYield;    // crystallised or deferred yield not yet credited
uint256 totalClaimable;
uint256 reserve;
uint256 lossDebt;
uint256 accYieldPerUnit;      // scaled 1e18
uint256 lastAssets;           // idle + adapter.totalAssets() after last accrual
```

```
accrue():                          // first line of every function that moves funds or changes an
                                   // accounting parameter; pure flags (pause) are exempt (ADR 0013)
    assets = idle + adapter.totalAssets()
    delta  = assets - lastAssets   // signed
    if delta > 0:
        if lossDebt > 0: repay = min(delta, lossDebt); lossDebt -= repay; delta -= repay
        if delta > 0:
            if totalOpenPrincipal == 0: reserve += delta
            else: accYieldPerUnit += delta * 1e18 / totalOpenPrincipal
        lastAssets = assets
    if delta < 0: shortfall observed; lastAssets is NOT lowered (ADR 0009). Only recogniseLoss(),
                  after LOSS_CONFIRMATION_WINDOW, lowers it and books the loss (section 6.4).

On every inflow or outflow (deposit, claim, reserve funding, top-up): update lastAssets by the
exact amount moved, so only real yield counts as gain.
```

Division remainder from `accYieldPerUnit` stays unallocated in the escrow. INV-4 tolerates it.

### 6.2 Split

Section 4.4. Guest share `guestYieldBps` on vested outcomes, owner takes the remainder, platform
takes none.

### 6.3 On-chain deployment caps

```solidity
function deploy(uint256 amount) external onlyRebalancer;
function redeem(uint256 amount) external onlyRebalancer;

// liabilities = totalOpenPrincipal + totalDisputed + totalPendingYield + totalClaimable
// deploy reverts unless, after the move:
//   lossDebt == 0
//   vault.totalSupply() >= MIN_VAULT_SUPPLY           // seeded vault, re-checked (ADR 0013 §1)
//   reserve >= RESERVE_FLOOR                           // owner-funded 1 USDC floor (ADR 0013 §5)
//   the vault is not written off (ADR 0013 §3)
//   idle >= liabilities * MIN_BUFFER_BPS / 10_000      // default 1_000
//   deployed <= liabilities * maxDeployBps / 10_000    // owner-set, default 9_000
```

Everything smarter lives in the off-chain rebalancer, because it needs data the contract cannot sum
cheaply. A compromised rebalancer key can reduce yield or liquidity; it cannot extract funds.

### 6.4 Loss handling

A loss is recognised when `adapter.totalAssets()` stays below its expected value for
`LOSS_CONFIRMATION_WINDOW` (6 hours). Shortfall is absorbed in order by:

1. `reserve`, down to zero
2. the owner payout address's unclaimed `claimable` balance
3. `lossDebt`, recorded

While `lossDebt > 0`:

- deposits revert (guard 5)
- owner payout and fee recipient claims revert (also while a shortfall is observed, ADR 0009)
- `deploy` reverts; the rebalancer may only redeem
- gains repay `lossDebt` before any distribution
- yield credits on settlement are deferred into `totalPendingYield`, also while a shortfall is
  observed (ADR 0015 §4)
- bookings still settle and guest principal claims proceed, first from idle, then from the adapter
- the owner clears the debt with `topUpLoss(amount)`

**Broken vault (ADR 0013 §3).** If the vault's views revert, every accrue-first function reverts.
The owner or guardian calls `writeOffVault()`: accounting stops reading the vault, the position
shows as an observed shortfall and is recognised through the order above after the window.
`recoverVault()` reads it again; recovered value repays `lossDebt` first, then is yield.

**Guest claims are paid first. That is a priority rule, not a guarantee.** If a loss exceeds what
the escrow and adapter hold and the owner never tops up, the last guests to claim are short. For the
pilot, the owner is the project owner and will cover it. Before a second owner is onboarded,
decision D4 applies.

Required test: no sequence of valid operations reduces any guest's credited refund or principal
claim below the policy-derived figure.

### 6.5 Reserve

Owner-funded via `fundReserve(amount)`; required up to `RESERVE_FLOOR` (1 USDC) before any
`deploy`, and a withdrawal may not take it below the floor while a vault is configured and anyone else
is owed. Sub-threshold rounding dust therefore falls on the reserve, not the last claimant (ADR 0013
§5). It also receives gains that accrue while
`totalOpenPrincipal == 0`. Spending is limited to loss absorption. Withdrawal requires both owner and
guardian, pays the current `payoutAddress`, is blocked while `lossDebt > 0` or a shortfall is
observed, and emits `ReserveWithdrawn(amount, reasonCode)` (ADR 0009).

### 6.6 Adapters

**The adapter is an ERC-4626 vault over USDC (ADR 0008).** The escrow holds vault shares; the
factory rejects a vault whose `asset()` is not USDC, or with fewer than `MIN_VAULT_SUPPLY` shares
outstanding. Approve only rate-priced vaults (Aave StataTokenV2) or OpenZeppelin ERC-4626 vaults with
`_decimalsOffset() >= 6` and a burned seed (ADR 0013 §1). Withdrawals are bounded by
`maxWithdraw(escrow)` and always use the escrow as both `receiver` and `owner`. Assets are
`previewRedeem(balanceOf(escrow))`.

- **No vault** (`address(0)`): funds stay idle. Replaces NullAdapter.
- **Mock vault** (OpenZeppelin `ERC4626` with a yield and loss injector, decimals offset 12, seeded
  to `0xdEaD` at deploy): settable rate and withdrawal limit. Testnet and all
  demos run on this: months of accrual in minutes, and a liquidity crunch on demand. Aave testnet
  rates are meaningless; do not demo on them.
- **Aave:** Aave's own ERC-4626 wrapper, StataTokenV2 (`AaveV3Base.USDC_STATA_TOKEN`), used directly
  with no adapter of ours (ADR 0016, D5). Tested only on a pinned Base mainnet fork. The market's
  available liquidity for the rebalancer is Aave's view `Pool.getVirtualUnderlyingBalance(USDC)`.
  The wrapper's pause leaves `maxWithdraw` non-zero while `withdraw` reverts (an EIP-4626
  deviation), so `claim` pulls best effort and never relies on `maxWithdraw` succeeding (4.5).

### 6.7 Rebalancer policy (work package C8)

Off-chain, per escrow. Pilot defaults:

| Rule | Value |
|---|---|
| Must stay liquid | All claimables, disputed and pending amounts, plus principal of every booking with check-in within `MIN_LEAD_TIME` (14 days), including bookings in stay or awaiting settlement |
| Floor | At least `MIN_BUFFER_BPS` of liabilities (the on-chain cap) |
| Minimum move | 500 USDC |
| Deploy only from | Deposits at the `finalized` head |
| Liquidity gate | Deploy only if market available liquidity >= 20x our position after the move; redeem all if it falls below 5x |
| Utilisation | Monitoring and alerting only, not a gate |
| USDC price | Halt deployment on a move beyond ±1%. **Do not auto-redeem on a depeg.** Redeeming during a depeg locks in the loss |

**Why utilisation is not a gate.** A snapshot of the Aave V3 Base USDC market (checked September
2026, snapshot date not shown) had roughly 178.9M supplied and 161.6M borrowed: about 90% utilisation
and about 17M available. An 82% gate would keep funds idle most of the time. What matters is whether
our position can exit, so measure available liquidity directly. Pull 90 days of history before
fixing the 20x and 5x thresholds.

---

## 7. Disputes (work package C3)

```solidity
function openDispute(bytes32 bookingId, uint256 contestedAtomic, bytes32 evidenceHash) external;
function resolve(bytes32 bookingId, uint16 guestBps, uint8 reasonCode) external;  // booking's arbitrator only
function resolveByDefault(bytes32 bookingId) external;   // permissionless after DISPUTE_WINDOW
```

- The guest (D8) may open a dispute while the booking is `DELIVERED` and before
  `checkOut + GRACE`.
- `contestedAtomic <= principal`.
- **Partial settlement.** On `openDispute`: run `accrue()`, crystallise the booking's yield `y` into
  `totalPendingYield`, remove the booking from `totalOpenPrincipal`, move `contestedAtomic` into
  `totalDisputed`, and settle the uncontested remainder immediately as a delivered stay (refund 0,
  fee applies). Yield for the whole booking waits for the resolution.
- **Resolution.** `guestBps` of the contested amount is refunded to the guest; the rest settles to
  the owner with the fee applied to what the owner retains. Yield follows section 4.4: vested if
  `guestBps == 0`, otherwise the guest's share goes to the owner.
- **Deadline default.** After `DISPUTE_WINDOW` (14 days) anyone may call `resolveByDefault`, which
  resolves with `guestBps = 0`. An unresponsive arbitrator cannot strand funds. Time the booking
  spends frozen after the dispute opens extends the deadline (ADR 0011).
- **No recipient parameter.** `resolve` credits the booking's stored guest and the owner bucket
  (ADR 0007). A
  compromised arbitrator can misallocate one contested amount and nothing else.
- `reasonCode` is a fixed enumeration.
- No dispute bond.

**Known gap (D8).** The escrow holds no security deposit, and once a stay is delivered every unit of
principal is already the owner's except what the policy refunds (zero). An owner-opened dispute
therefore has nothing to claim. Either add an optional damage deposit to the quote, or restrict
`openDispute` to the guest. Default: guest only, until D8 is decided.

The arbitrator Safe on testnet can be 2-of-3 with the project owner's keys. Before mainnet it needs a
signer set with a majority independent of the platform and the owner, because for the pilot villa
those are the same person.

---

## 8. Villa economics

Deployment window per booking is roughly `(checkIn - 14 days) - depositTime`, because principal must
be liquid from 14 days before check-in. At most 90% of it is deployed (`MIN_BUFFER_BPS`). Aave V3 Base
USDC supply APY was about 4.18% in the snapshot above. Rates move; recompute before quoting any
figure.

Example: booking made 60 days before check-in, so 46 days deployed at 90%.

| Booking value | APY | Gross yield | Guest (50%) | Owner (50%) |
|---|---|---|---|---|
| 5,000 USDC | 4.18% | ~24 | ~12 | ~12 |
| 10,000 USDC | 4.18% | ~47 | ~24 | ~24 |
| 10,000 USDC | 3.00% | ~34 | ~17 | ~17 |
| 20,000 USDC | 4.18% | ~95 | ~47 | ~47 |

Per year, illustrative: 800/night at 50% occupancy is about 146,000 in room revenue. Gross yield is
about 690, roughly 345 each, about 0.5% of revenue.

For the villa, yield is a feature and a demonstration, not revenue. An external audit costs many
years of it. The justification is the platform. Replace these assumptions with the villa's real
rate, occupancy and lead-time distribution before the numbers go anywhere.

---

## 9. Channel sync (work package C7)

Availability can only be correct off-chain because most double bookings come from other channels.

**MVP: iCal both ways, per resource.**
- Import each external channel's iCal feed, polling every 5 minutes
- Export an iCal feed of our escrowed bookings for each channel to import
- Imported events block availability in the calendar projection immediately

**Residual race.** External channels poll our feed on their own schedule. A room can be sold
elsewhere between our last import and a guest's deposit. The prepare re-check narrows the window but
cannot close it.

**Conflict runbook.** If an imported event overlaps an `ESCROWED` booking:
1. Owner alert immediately (INV-3)
2. The owner decides which booking to honour
3. If ours is cancelled, it goes through `cancelByProperty`: full refund
4. Log every conflict. A rising rate means the poll interval or channel setup needs work

After MVP, a channel manager API replaces iCal.

---

## 10. Indexer, projections, reconciliation (work package C6)

### 10.1 Framework first

Do not hand-roll chain ingestion. Evaluate Ponder and Envio against these requirements and record the
choice in an ADR:

- Rollback to a common ancestor on reorg, with re-indexing
- Access to `unsafe`, `safe` and `finalized` heads so actions can wait for the right one
- Idempotent handlers keyed on `(chainId, txHash, logIndex)`
- Full replay from genesis into a separate schema

If a framework meets all four, use it. If not, document the gap and build only that part.

### 10.2 Which head each action waits for

| Action | Head |
|---|---|
| Show the guest "booking received" | `unsafe` + 2 blocks |
| Mark the room sold and export to iCal | `safe` |
| Credit claimable balances in the ledger | `finalized` |
| Send the confirmation email | `finalized` |
| Count funds as deployable | `finalized` |

### 10.3 Projections

The event log is the only source of truth. The calendar projection (our bookings plus imported
channel events) and the double-entry ledger projection are both rebuilt from it. Neither may hold
state that replay cannot reproduce. A nightly job rebuilds the ledger from scratch into a separate
schema and diffs it against production; any difference is a failure.

### 10.4 Invariants

```
INV-1  solvency (hard)
       idle + adapter.totalAssets() + lossDebt >= totalOpenPrincipal + totalDisputed + totalClaimable
       page when the gap is >= MIN_LOSS_ATOMIC (ERC-4626 rounding is below it; ADR 0013 §4)

INV-2  solvency (full)
       idle + adapter.totalAssets() + lossDebt
         >= liabilities + reserve + unpaid accrued yield

INV-3  calendar
       every ESCROWED booking appears in the calendar projection and the iCal export, and no
       imported external event overlaps an ESCROWED booking

INV-4  yield conservation
       total yield credited + pending <= total realised gain since deployment

INV-5  liquidity
       idle >= the rebalancer's required liquid amount (section 6.7)

INV-6  settlement conservation (per booking, on every BookingSettled / DisputeResolved)
       refund + ownerPrin + fee == principal settled, and guestY + ownerY == y
```

| Breach | Response |
|---|---|
| INV-1 | Page immediately; guardian pauses deposits; halt deployment |
| INV-2 | Loss handling (6.4); halt deployment |
| INV-3 | Alert the owner; conflict runbook |
| INV-4 | Page; accumulator is wrong; halt yield payouts |
| INV-5 | Halt deployment; redeem |
| INV-6 | Page; halt new deposits via guardian |

INV-1, INV-4 and INV-6 have no warning band. Any breach is a page.

The indexer also serves the read side of the Service API (section 5.3): booking status, refund if
cancelled now, accrued yield.

---

## 11. Boundary with the agent workstream

The agent workstream consumes only the Service API in section 5.3 and the read projections. It never
calls contracts, never holds keys, and never receives `feeBps`. The checkout page is built by the
agent workstream (their A3) and submits the `calls` bundle from `prepare` via the guest's wallet.
Acceptance for the chain side: with the agent service switched off, a guest can search, get an offer,
prepare, pay, cancel and check status end to end.

---

## 12. Delivery plan

### 12.1 Work packages

| ID | Package | Depends on |
|---|---|---|
| C0 | Stub Service API returning fixtures | Nothing; **week 1** |
| C1 | Factory, escrow core, quotes, deposit, cancel, settle, claims, config, events | Nothing |
| C2 | Accumulator, deploy caps, loss handling, reserve | C1 types |
| C3 | Disputes | C1 types |
| C4 | Adapters: Null, Mock, Aave | C2 interface |
| C5 | Quote service and Service API | C1 ABI |
| C6 | Indexer, projections, invariants, read API | C1-C3 ABIs |
| C7 | iCal import and export | C6 |
| C8 | Rebalancer | C4, C6 |
| C9 | Independent invariant and adversarial test suite | C1-C3 ABIs and this spec only |

C1 goes first and fixes the types. C2, C3 and C5 then run in parallel. C4 and C8 are the long pole
for yield; nothing in booking depends on them, because NullAdapter works from day one.

### 12.2 Integration milestones

| Milestone | Gate |
|---|---|
| I0 | Agent completes a booking conversation against C0 stubs |
| I1 | Plain checkout books, cancels and shows status on Base Sepolia with the agent switched off |
| I2 | Guest signs a real testnet booking from the chat |
| I3 | iCal round trip with a real listing; a forced conflict triggers INV-3 |
| I4 | MockYieldAdapter accrual visible via `/v1/bookings` and the owner digest |
| I5 | At least four weeks running alongside the villa's real bookings, diffed weekly |

### 12.3 Before mainnet, none optional

- External audit, all high and medium findings resolved
- A contract-enforced cap on total escrowed value per escrow, at a level the owner could cover
- Arbitrator, guardian and factoryAdmin Safes with real signer sets; rotation tested
- `ops/runbook.md` complete enough for someone else to run: redemption, every invariant breach,
  channel conflicts, indexer recovery, loss top-up
- I5 complete, with the policy model confirmed against how the villa actually cancels

---

## 13. Parameters

| Parameter | Default | Where |
|---|---|---|
| `GRACE` | 72 hours | Escrow constant |
| `DISPUTE_WINDOW` | 14 days | Escrow constant |
| `MAX_NIGHTS` | 60 | Escrow constant |
| `MIN_BUFFER_BPS` | 1,000 | Escrow constant |
| `maxDeployBps` | 9,000 | Owner-set, <= 10,000 - `MIN_BUFFER_BPS` |
| `LOSS_CONFIRMATION_WINDOW` | 6 hours | Escrow constant |
| `MAX_FREEZE_DURATION` | 30 days, cumulative per booking | Escrow constant (ADR 0007) |
| `minNightlyAtomic` | Set at escrow creation, never 0 | Owner-set (ADR 0007) |
| `maxOpenPrincipalAtomic` | From the admin's approval | Owner-set cap, spec 12.3 (ADR 0007) |
| `MAX_FEE_BPS` | 2,000 | Factory constant |
| `maxFeeBps` | Set at escrow creation | Per escrow, immutable |
| `FEE_CHANGE_DELAY`, `FEE_RECIPIENT_DELAY`, `ARBITRATOR_DELAY` | 7 days each | Factory constants |
| `guestYieldBps` | 5,000 | Owner-set |
| `MIN_LEAD_TIME` | 14 days | Rebalancer |
| Offer lock | 25 minutes | Quote service |

---

## 14. Open decisions

| ID | Decision | Default the agents build | Blocks |
|---|---|---|---|
| D1 | Fee on partial refunds | On the retained amount | Decided |
| D2 | Fee on the owner's yield share | No | Decided |
| D3 | Guest yield share on owner cancellation and guest-won disputes | To owner | Decided |
| D4 | Mandatory owner reserve for third-party owners | Not for the pilot; required before a second owner | Second owner |
| D5 | Aave raw pool or vault wrapper | StataTokenV2, no adapter of ours ([ADR 0016](adr/0016-aave-integration.md)) | Decided |
| D6 | Indexing framework | Ponder, plus a head tracker and deep-reorg replay ([ADR 0014](adr/0014-indexing-framework.md), [0017](adr/0017-indexer-design.md)) | Decided |
| D7 | Who issues guest auth tokens | Checkout backend (agent workstream A3) | C5 read endpoints |
| D8 | Owner-opened disputes: add a damage deposit, or guest-only | Guest only | C3 |
| D9 | Arbitrator rotation for existing bookings if the Safe is compromised | None; snapshot is final | C1 |

---

## 15. Changes

### 15.1 From v2

| Area | v2 | Now |
|---|---|---|
| Pilot | 100-key resort | One villa, one unit |
| Split | Guest 25 / reserve 10 / platform 15 / owner remainder | Guest `guestYieldBps` (5,000) / owner remainder |
| Platform revenue | Yield share plus fee | Fee only |
| Non-vested yield | To reserve | To owner |
| Reserve | Seed, 10% skim, forfeitures; seeded before mainnet | Optional, owner-funded |
| Quote | `feeBps <= maxFeeBps` | `feeBps == effectiveFeeBps()`, plus `guestYieldBps` equality |
| Fee changes | Unspecified | factoryAdmin, 7-day timelock, per-escrow `maxFeeBps` ceiling |
| Fee recipient | Unspecified | Factory-level, 7-day timelock, read at settlement |
| Arbitrator | Escrow-level, timelocked, not applied to open disputes | Snapshotted per booking at deposit |
| Deposit | Single `permit (v, r, s)` path | Allowance path first (smart wallet batch); permit path for EOAs, try/catch |
| Quote signature | `recover == quoteSigner` | `SignatureChecker` (EOA or ERC-1271) |
| During `lossDebt` | Only yield payouts deferred | Also blocks deposits, owner and fee claims, deploys |
| Disputes | Yield handling unspecified; owner may open | Yield crystallised at open; owner-open gated by D8 |
| Buffer | 30% on-chain, 7 days of refunds off-chain | 10% on-chain; liquidity rule in 6.7 |
| Utilisation | 82% deploy gate, 90% redeem | Alert only; absolute liquidity gate |
| Invariants | INV-1 to INV-5 | Liabilities include disputed and pending; INV-6 added |
| Legal gates | Counsel before C1; counsel and tax before mainnet | Removed from engineering gates |
| Service API | Agent tool list | HTTP contract in 5.3 that both workstreams build against |

### 15.2 Corrections to `chain-spec-v3-delta.md`

| v3 said | Correct | Effect |
|---|---|---|
| v2 quotes had no economic fields | v2 already carried `feeBps` | Changelog fixed; v2's `maxFeeBps` kept as per-escrow ceiling |
| Principal deployed until 14 days before check-**out** (53 days in the example) | v2's rule is 14 days before check-**in** (46 days), and refund exposure peaks there | Economics recomputed: ~47 not ~61 on a 10,000 booking |
| "Freeze unwind" as a non-vested outcome | Freeze never settles; it only halts | Removed |
| Dispute outcomes vs vesting unspecified | Crystallise at open; vested only if `guestBps == 0` | Section 7 |

---

## 16. Accepted ADRs amending this spec

| ADR | Amends |
|---|---|
| [0001](adr/0001-v1-wire-formats.md) to [0004](adr/0004-v1-booking-policy-fields.md) | 5.3 `/v1` wire formats, booking `state`/`outcome`, claim path, policy on bookings (agent-workstream sign-off pending) |
| [0005](adr/0005-escrow-deployment-pattern.md) | 2: clones confirmed; proxies rejected |
| [0006](adr/0006-toolchain-and-dependencies.md) | Toolchain pins |
| [0007](adr/0007-c1-defaults-for-review-findings.md) | 3.3 to 3.5, 4.2, 4.4, 4.5, 4.7, 12.3, 13: owner claim bucket, onboarding, freeze budget, value cap, price floor, timelock promotion |
| [0008](adr/0008-yield-adapter-is-erc4626.md) | 6.6: adapter is ERC-4626 |
| [0010](adr/0010-c2-accounting-structure.md) | 6.1 to 6.5: Ledger struct and linked libraries, pending-yield release, 1 USDC loss threshold, owner deferred yield absorbs losses |
| [0011](adr/0011-disputes.md) | 7: reason enum, frozen time extends the dispute deadline, `DisputeOpened` figures |
| [0009](adr/0009-loss-window-and-remaining-defaults.md) | 6.1, 6.4, 6.5, 4.5: high-water-mark baseline, shortfall gating, reserve recipient; bookingId keying off-chain |
| [0014](adr/0014-indexing-framework.md) | 10.1, 14 (D6): Ponder; head tracker for real `safe`/`finalized` tags; deep-reorg halt triggers a full replay |
| [0015](adr/0015-review-0004-fixes.md) | 3.5, 6.4 to 6.6: a freeze stops the booking's clock; a written-off vault still pays out (best effort, booked before paying); freeze needs no vault read; yield deferred during an observed shortfall |
| [0013](adr/0013-vault-safety-c9-findings.md) | 6.1, 6.3 to 6.6, 10.4: seeded vaults only, pause is a pure flag, privileged vault write-off/recovery, INV-1 band, owner-funded reserve floor |
| [0019](adr/0019-rebalancer-price-and-execution.md) | 6.7, 10.2: Chainlink USDC/USD (24 h heartbeat, 90,000 s staleness) with the L2 sequencer check; Aave virtual balance as market liquidity; finalised-only deployable idle; one transaction in flight, same-nonce replacement or cancel, revert cooldown; dry run by default |
| [0018](adr/0018-ical-channel-sync.md) | 9, 10.2, 10.4 (INV-3): ical.js parsing and export, nights normalisation, SSRF-safe fetching, import/back-off/staleness, one INV-3 alert per conflict, safe-gated export with HMAC URLs and UIDs |
| [0017](adr/0017-indexer-design.md) | 10.2 to 10.4, ADR 0012 §3/§7 calendar rows: projection only in Ponder tables; worker-derived escrow calendar rows (cancellation frees a slot at safe; a safe deposit reorged out keeps it); head milestones and outboxes; lag monitor; replay diff; read API |
| [0016](adr/0016-aave-integration.md) | 4.5, 6.6, 14 (D5): Aave via StataTokenV2; claim pulls from the vault best effort |
| [0012](adr/0012-quote-service-policies.md) | 5.1 to 5.3: DST materialisation rules, holds and one live quote per offer, 900 s feed staleness, fee-straddle cap, 409 on offers (docs only), guest JWT claims (agent-workstream sign-off pending), shared calendar tables |
