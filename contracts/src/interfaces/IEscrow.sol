// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Quote cutoff: refund `refundBps` if cancelled before `cutoffUtc` (spec 4.1).
struct Cutoff {
    uint40 cutoffUtc;
    uint16 refundBps;
}

/// @notice Server-signed booking quote (spec 4.1). `bookingId = hashStruct(quote)` under EIP-712.
struct Quote {
    bytes32 resourceId;
    uint40 checkInUtc;
    uint40 checkOutUtc;
    uint256 priceAtomic;
    uint16 feeBps; // must equal effectiveFeeBps() at deposit
    uint16 guestYieldBps; // must equal guestYieldBps at deposit
    bytes32 policyHash;
    Cutoff[] cutoffs; // earliest first, 1..8
    uint16 finalBps; // refund from checkIn until checkOut
    address guest;
    uint40 expiresAt;
    bytes32 salt;
}

/// @notice Stored booking state (spec 3.5). DELIVERED is never stored; `bookingState()` derives it
/// from time for an ESCROWED booking at or after check-out.
enum BookingState {
    NONE,
    ESCROWED,
    DELIVERED,
    FROZEN,
    DISPUTED,
    SETTLED
}

/// @notice How a booking reached SETTLED. Mirrors the `/v1` `outcome` field (docs/adr/0002).
/// @notice Fixed dispute reason codes (spec 7). `DEFAULT_TIMEOUT` is reserved for `resolveByDefault`;
/// arbitrators use the others (docs/adr/0011).
enum DisputeReason {
    NOT_AS_DESCRIBED,
    ACCESS_OR_CHECK_IN_FAILURE,
    CLEANLINESS_OR_MAINTENANCE,
    SAFETY_OR_HEALTH,
    AMENITY_MISSING,
    BILLING_ERROR,
    OTHER,
    DEFAULT_TIMEOUT
}

/// @notice Per-booking dispute record (C3). The uncontested part settles at open.
struct Dispute {
    uint256 contestedAtomic;
    uint256 yieldAtomic; // booking yield crystallised at open, split at resolution
    uint40 openedAt;
    uint32 frozenAtOpen; // booking.frozenTotal when opened; later freezes extend the deadline
}

enum Outcome {
    COMPLETED,
    CANCELLED_BY_GUEST,
    CANCELLED_BY_PROPERTY,
    DISPUTE_RESOLVED
}

/// @notice Stored per-booking terms, fixed at deposit (spec 4.2). Cutoffs are read with `getCutoffs`.
struct Booking {
    address guest;
    uint40 checkInUtc;
    uint40 checkOutUtc;
    uint16 feeBps;
    BookingState state;
    address arbitrator; // snapshotted at deposit (spec 3.4)
    uint16 guestYieldBps;
    uint16 finalBps;
    BookingState frozenFrom; // state to restore on unfreeze (docs/adr/0007)
    uint40 frozenSince;
    uint32 frozenTotal; // cumulative seconds frozen (docs/adr/0007)
    bytes32 resourceId;
    uint256 principalAtomic;
    uint256 accAtDeposit;
}

/// @notice Initialiser arguments, supplied by the factory in the same transaction as the clone.
struct EscrowInit {
    address owner;
    address payoutAddress;
    address quoteSigner;
    address usdc;
    address vault; // ERC-4626 over USDC, or address(0) for no yield (docs/adr/0008)
    address arbitrator;
    uint16 maxFeeBps;
    uint16 feeBps;
    uint256 maxOpenPrincipalAtomic;
    uint256 minNightlyAtomic; // > 0: the price floor that bounds a compromised quote signer (spec 3.3)
}

interface IEscrowEvents {
    // --- bookings (C1) ---
    event BookingDeposited(
        bytes32 indexed bookingId,
        address indexed guest,
        bytes32 indexed resourceId,
        uint40 checkInUtc,
        uint40 checkOutUtc,
        uint256 principalAtomic,
        uint16 feeBps,
        uint16 guestYieldBps,
        bytes32 policyHash,
        Cutoff[] cutoffs,
        uint16 finalBps,
        address arbitrator,
        uint256 accAtDeposit
    );
    event BookingCancelled(bytes32 indexed bookingId, Outcome outcome, uint16 refundBps);
    /// @dev All six settlement figures (spec 4.4, 4.7). refund + ownerPrin + fee == principal settled;
    /// guestY + ownerY == y. `feeRecipient` is the address the fee was credited to.
    event BookingSettled(
        bytes32 indexed bookingId,
        Outcome outcome,
        uint256 principalAtomic,
        uint256 refund,
        uint256 ownerPrincipal,
        uint256 fee,
        uint256 y,
        uint256 guestYield,
        uint256 ownerYield,
        address feeRecipient
    );
    event BookingFrozen(bytes32 indexed bookingId, BookingState from);
    event BookingUnfrozen(bytes32 indexed bookingId, BookingState to, uint32 frozenTotal);

    // --- claims (C1) ---
    event Claimed(address indexed account, uint256 requested, uint256 paid);

    // --- disputes (C3) ---
    /// @dev Carries the uncontested settlement figures (refund 0) and the crystallised yield, so the
    /// ledger is rebuilt without calls (docs/adr/0011).
    event DisputeOpened(
        bytes32 indexed bookingId,
        uint256 contestedAtomic,
        bytes32 evidenceHash,
        uint256 uncontestedOwnerPrincipal,
        uint256 uncontestedFee,
        uint256 y,
        address feeRecipient
    );
    event DisputeResolved(
        bytes32 indexed bookingId,
        uint16 guestBps,
        uint8 reasonCode,
        uint256 refund,
        uint256 ownerPrincipal,
        uint256 fee,
        uint256 y,
        uint256 guestYield,
        uint256 ownerYield,
        address feeRecipient
    );

    // --- yield, loss, reserve (C2) ---
    event Deployed(uint256 assets);
    event Redeemed(uint256 assets);
    /// @dev `gain` is after lossDebt repayment; `toReserve` is the part credited to the reserve
    /// because no principal was open (docs/adr/0010).
    event YieldAccrued(uint256 gain, uint256 toReserve, uint256 accYieldPerUnit);
    /// @dev `fromOwner` covers the owner claim bucket and the owner's deferred yield (docs/adr/0010).
    event LossRecognised(uint256 loss, uint256 fromReserve, uint256 fromOwner, uint256 toDebt);
    event ShortfallObserved(uint256 shortfall);
    event ShortfallCleared();
    event YieldDeferred(bytes32 indexed bookingId, uint256 guestYield, uint256 ownerYield);
    event PendingYieldReleased(address indexed account, uint256 amount);
    event ReserveWithdrawalProposed(uint256 amount, uint8 reasonCode);
    event LossRepaid(uint256 amount, uint256 lossDebt);
    event LossToppedUp(uint256 amount, uint256 lossDebt);
    event ReserveFunded(uint256 amount);
    event ReserveWithdrawn(uint256 amount, uint8 reasonCode);

    // --- configuration (C1) ---
    event FeeChangeProposed(uint16 feeBps, uint64 effectiveAt);
    event ArbitratorChangeProposed(address arbitrator, uint64 effectiveAt);
    event GuestYieldBpsSet(uint16 guestYieldBps);
    event MinNightlySet(uint256 minNightlyAtomic);
    event PayoutAddressSet(address payoutAddress);
    event QuoteSignerRotated(address quoteSigner);
    event RebalancerSet(address rebalancer);
    event MaxDeployBpsSet(uint16 maxDeployBps);
    event MaxOpenPrincipalSet(uint256 maxOpenPrincipalAtomic);
    // Deposit pausing uses OpenZeppelin Pausable's `Paused(account)` / `Unpaused(account)`
    // in place of spec 4.7's DepositsPaused / DepositsUnpaused (docs/adr/0007).
}

interface IEscrowErrors {
    // deposit guards, spec 4.2 order
    error InvalidQuoteSignature(); // 1
    error NotQuoteGuest(); // 2
    error QuoteExpired(); // 3
    error BookingExists(); // 4
    error LossDebtOutstanding(); // 5 (pause uses OZ EnforcedPause)
    error InvalidStayTimes(); // 6
    error InvalidNights(); // 7
    error PriceBelowFloor(); // 8
    error FeeMismatch(); // 9
    error GuestYieldMismatch(); // 10
    error InvalidCutoffs(); // 11
    error EscrowCapExceeded(); // cap (docs/adr/0007)
    error TransferAmountMismatch(); // 12

    // lifecycle
    error UnknownBooking();
    error BookingNotEscrowed();
    error NotGuest();
    error NotCancellable();
    error PropertyCancelTooLate();
    error SettleTooEarly();
    error NotFreezable();
    error NotFrozen();
    error FreezeBudgetExhausted();

    // roles and config
    error NotGuardian();
    error NotFactoryAdmin();
    error ZeroAddress();
    error BpsOutOfRange();
    error FeeAboveMax();
    error RenounceDisabled();
    error ZeroMinNightly();

    // yield, loss, reserve (C2)
    error NotRebalancer();
    error NoVault();
    error ShortfallPending();
    error BufferBreached();
    error DeployCapExceeded();
    error NoLossToRecognise();
    error LossWindowOpen();
    error NoLossDebt();
    error ReserveInsufficient();
    error ReserveProposalMismatch();
    error ZeroAmount();
    error VaultMintedNoShares();

    // disputes (C3)
    error NotDelivered();
    error DisputeTooLate();
    error InvalidContested();
    error NotDisputed();
    error NotArbitrator();
    error InvalidReasonCode();
    error DisputeWindowOpen();
}

interface IEscrow is IEscrowEvents, IEscrowErrors {
    // --- bookings ---
    function deposit(Quote calldata q, bytes calldata quoteSig) external returns (bytes32 bookingId);
    function depositWithPermit(
        Quote calldata q,
        bytes calldata quoteSig,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 bookingId);
    function cancelByGuest(bytes32 bookingId) external;
    function cancelByProperty(bytes32 bookingId) external;
    function settle(bytes32 bookingId) external;
    function claim() external returns (uint256 paid);

    // --- guardian ---
    function freezeBooking(bytes32 bookingId) external;
    function unfreezeBooking(bytes32 bookingId) external;
    function pauseDeposits() external;
    function unpauseDeposits() external;

    // --- owner ---
    function setPayoutAddress(address payoutAddress) external;
    function setQuoteSigner(address quoteSigner) external;
    function setGuestYieldBps(uint16 guestYieldBps) external;
    function setMinNightlyAtomic(uint256 minNightlyAtomic) external;
    function setMaxDeployBps(uint16 maxDeployBps) external;
    function setRebalancer(address rebalancer) external;
    function setMaxOpenPrincipal(uint256 maxOpenPrincipalAtomic) external;

    // --- factory admin (timelocked) ---
    function proposeFeeBps(uint16 feeBps) external;
    function proposeArbitrator(address arbitrator) external;

    // --- yield, loss, reserve (C2) ---
    function deploy(uint256 assets) external; // rebalancer
    function redeem(uint256 assets) external; // rebalancer
    function observeShortfall() external; // permissionless: runs accrue()
    function recogniseLoss() external; // permissionless, after LOSS_CONFIRMATION_WINDOW
    function topUpLoss(uint256 amount) external; // owner
    function fundReserve(uint256 amount) external; // owner
    function proposeReserveWithdrawal(uint256 amount, uint8 reasonCode) external; // owner
    function confirmReserveWithdrawal(uint256 amount, uint8 reasonCode) external; // guardian

    // --- disputes (C3) ---
    function openDispute(bytes32 bookingId, uint256 contestedAtomic, bytes32 evidenceHash) external; // guest
    function resolve(bytes32 bookingId, uint16 guestBps, uint8 reasonCode) external; // booking's arbitrator
    function resolveByDefault(bytes32 bookingId) external; // permissionless after the window

    // --- views ---
    function hashQuote(Quote calldata q) external pure returns (bytes32 bookingId);
    function quoteDigest(Quote calldata q) external view returns (bytes32);
    function effectiveFeeBps() external view returns (uint16);
    function effectiveArbitrator() external view returns (address);
    function bookingState(bytes32 bookingId) external view returns (BookingState);
    function getBooking(bytes32 bookingId) external view returns (Booking memory);
    function getCutoffs(bytes32 bookingId) external view returns (Cutoff[] memory);
    function refundBpsNow(bytes32 bookingId) external view returns (uint16);
    function claimableOf(address account) external view returns (uint256);
    function totalAssets() external view returns (uint256);
    function shortfall() external view returns (uint256);
    function pendingYieldOf(address account) external view returns (uint256);
    function getDispute(bytes32 bookingId) external view returns (Dispute memory);
    function disputeDeadline(bytes32 bookingId) external view returns (uint256);
}
