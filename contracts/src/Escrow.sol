// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    EIP712Upgradeable
} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {
    IEscrow,
    Quote,
    Cutoff,
    Booking,
    BookingState,
    Outcome,
    EscrowInit,
    Dispute,
    DisputeReason
} from "./interfaces/IEscrow.sol";
import {IEscrowFactory} from "./interfaces/IEscrowFactory.sol";
import {QuoteLib} from "./libraries/QuoteLib.sol";
import {SettlementLib} from "./libraries/SettlementLib.sol";
import {Params} from "./libraries/Params.sol";
import {BookingLib} from "./libraries/BookingLib.sol";
import {LedgerLib, Ledger} from "./libraries/LedgerLib.sol";
import {DisputeLib} from "./libraries/DisputeLib.sol";

/// @title Escrow
/// @notice One per property owner, deployed by `EscrowFactory` as an EIP-1167 clone (docs/adr/0005).
/// Holds guests' USDC prepayments against server-signed quotes until the stay completes
/// (docs/chain-spec.md sections 3 and 4).
/// @dev C1: bookings, claims, roles. C2: yield accumulator with a high-water-mark baseline, loss
/// recognition and absorption, reserve, deploy and redeem (spec 6; docs/adr/0009, 0010).
/// Disputes (C3) use `totalDisputed` and `totalPendingYield`.
///
/// Books identity, exact after every state-changing call (tested as an invariant):
///   lastAssets + lossDebt == totalOpenPrincipal + totalDisputed + totalClaimable
///                            + totalPendingYield + reserve + yieldUnallocated
contract Escrow is
    IEscrow,
    Initializable,
    EIP712Upgradeable,
    Ownable2StepUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient
{
    using SafeERC20 for IERC20;

    string internal constant EIP712_NAME = "BookingEscrow";
    string internal constant EIP712_VERSION = "1";

    // ------------------------------------------------------------------------------------------
    // Configuration

    IEscrowFactory public factory;
    IERC20 public usdc;
    IERC4626 public vault;

    address public payoutAddress;
    address public quoteSigner;
    address public rebalancer;

    uint16 public maxFeeBps; // fixed at creation
    uint16 public feeBps;
    uint16 public pendingFeeBps;
    uint64 public pendingFeeAt; // 0 if nothing pending
    uint16 public guestYieldBps;
    uint16 public maxDeployBps;

    address public arbitrator;
    address public pendingArbitrator;
    uint64 public pendingArbitratorAt;

    uint256 public minNightlyAtomic;
    uint256 public maxOpenPrincipalAtomic; // spec 12.3 escrowed-value cap (docs/adr/0007)

    // ------------------------------------------------------------------------------------------
    // Accounting (spec 6.1). All of it lives in one struct so the linked LedgerLib can operate on
    // it (docs/adr/0010). Getters below keep the field names.

    Ledger internal _l;
    mapping(bytes32 => Booking) internal _bookings;
    mapping(bytes32 => Cutoff[]) internal _cutoffs;
    mapping(bytes32 => Dispute) internal _disputes; // C3

    /// @notice True after writeOffVault: accounting stops reading the vault (docs/adr/0013 §3).
    bool public vaultWrittenOff;

    // ------------------------------------------------------------------------------------------

    modifier onlyGuardian() {
        if (msg.sender != factory.guardian()) revert NotGuardian();
        _;
    }

    /// Either party may act on a broken vault; the owner absorbs a write-off first (spec 6.4), and
    /// the platform may act for guests (docs/adr/0013 §3).
    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner() && msg.sender != factory.guardian()) revert NotOwnerOrGuardian();
        _;
    }

    modifier onlyFactoryAdmin() {
        if (msg.sender != factory.owner()) revert NotFactoryAdmin();
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by the factory in the clone's creation transaction.
    function initialize(EscrowInit calldata p) external initializer {
        if (
            p.owner == address(0) || p.payoutAddress == address(0) || p.quoteSigner == address(0)
                || p.usdc == address(0) || p.arbitrator == address(0)
        ) revert ZeroAddress();
        if (p.maxFeeBps > Params.MAX_FEE_BPS || p.feeBps > p.maxFeeBps) revert FeeAboveMax();
        if (p.minNightlyAtomic == 0) revert ZeroMinNightly();

        __EIP712_init(EIP712_NAME, EIP712_VERSION);
        __Ownable_init(p.owner);
        __Pausable_init();

        factory = IEscrowFactory(msg.sender);
        usdc = IERC20(p.usdc);
        vault = IERC4626(p.vault);
        payoutAddress = p.payoutAddress;
        quoteSigner = p.quoteSigner;
        maxFeeBps = p.maxFeeBps;
        feeBps = p.feeBps;
        arbitrator = p.arbitrator;
        guestYieldBps = Params.DEFAULT_GUEST_YIELD_BPS;
        maxDeployBps = Params.DEFAULT_MAX_DEPLOY_BPS;
        maxOpenPrincipalAtomic = p.maxOpenPrincipalAtomic;
        minNightlyAtomic = p.minNightlyAtomic;

        emit PayoutAddressSet(p.payoutAddress);
        emit QuoteSignerRotated(p.quoteSigner);
        emit GuestYieldBpsSet(Params.DEFAULT_GUEST_YIELD_BPS);
        emit MaxDeployBpsSet(Params.DEFAULT_MAX_DEPLOY_BPS);
        emit MaxOpenPrincipalSet(p.maxOpenPrincipalAtomic);
        emit MinNightlySet(p.minNightlyAtomic);
    }

    // ==========================================================================================
    // Deposit (spec 4.2)

    /// @inheritdoc IEscrow
    function deposit(Quote calldata q, bytes calldata quoteSig) external nonReentrant returns (bytes32) {
        return _deposit(q, quoteSig);
    }

    /// @inheritdoc IEscrow
    /// @dev The permit is attempted inside try/catch: if someone front-runs it, the allowance is
    /// already in place and the deposit proceeds (spec 4.2).
    function depositWithPermit(
        Quote calldata q,
        bytes calldata quoteSig,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32) {
        try IERC20Permit(address(usdc))
            .permit(msg.sender, address(this), q.priceAtomic, permitDeadline, v, r, s) {}
            catch {}
        return _deposit(q, quoteSig);
    }

    function _deposit(Quote calldata q, bytes calldata quoteSig) internal returns (bytes32 bookingId) {
        bookingId = QuoteLib.hash(q);

        // 1
        if (!SignatureChecker.isValidSignatureNowCalldata(quoteSigner, _hashTypedDataV4(bookingId), quoteSig))
        {
            revert InvalidQuoteSignature();
        }
        // 2
        if (msg.sender != q.guest) revert NotQuoteGuest();
        // 3
        if (block.timestamp > q.expiresAt) revert QuoteExpired();
        // 4
        if (_bookings[bookingId].state != BookingState.NONE) revert BookingExists();
        // 5
        _requireNotPaused();
        if (_l.lossDebt != 0) revert LossDebtOutstanding();
        // 6
        if (!(block.timestamp < q.checkInUtc && q.checkInUtc < q.checkOutUtc)) revert InvalidStayTimes();
        // 7
        uint256 nights = Math.ceilDiv(q.checkOutUtc - q.checkInUtc, 1 days);
        if (nights > Params.MAX_NIGHTS) revert InvalidNights();
        // 8
        if (q.priceAtomic < minNightlyAtomic * nights) revert PriceBelowFloor();
        // 9
        if (q.feeBps != effectiveFeeBps()) revert FeeMismatch();
        // 10
        if (q.guestYieldBps != guestYieldBps) revert GuestYieldMismatch();
        // 11
        if (!QuoteLib.validCurve(q.cutoffs, q.finalBps, q.checkInUtc)) revert InvalidCutoffs();
        // escrowed-value cap (spec 12.3, docs/adr/0007)
        if (_l.totalOpenPrincipal + q.priceAtomic > maxOpenPrincipalAtomic) revert EscrowCapExceeded();

        // 12: accrue, record, then pull exactly priceAtomic and check the balance delta.
        _accrue();
        _promoteTimelocks();
        BookingLib.record(_bookings, _cutoffs, bookingId, q, arbitrator, _l.accYieldPerUnit);
        _l.totalOpenPrincipal += q.priceAtomic;
        _l.lastAssets += q.priceAtomic;
        _pullExact(q.priceAtomic);
    }

    // ==========================================================================================
    // Cancel and settle (spec 3.5, 4.3, 4.4, 4.6)

    /// @inheritdoc IEscrow
    function cancelByGuest(bytes32 bookingId) external nonReentrant {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _escrowed(bookingId);
        if (msg.sender != b.guest) revert NotGuest();
        uint256 t = _bookingNow(b);
        if (t >= b.checkOutUtc) revert NotCancellable();
        uint16 bps = QuoteLib.refundBps(_cutoffs[bookingId], b.finalBps, b.checkInUtc, t);
        emit BookingCancelled(bookingId, Outcome.CANCELLED_BY_GUEST, bps);
        _settle(bookingId, b, bps, false, Outcome.CANCELLED_BY_GUEST);
    }

    /// @inheritdoc IEscrow
    function cancelByProperty(bytes32 bookingId) external onlyOwner nonReentrant {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _escrowed(bookingId);
        if (block.timestamp >= b.checkInUtc) revert PropertyCancelTooLate();
        emit BookingCancelled(bookingId, Outcome.CANCELLED_BY_PROPERTY, Params.BPS);
        _settle(bookingId, b, Params.BPS, false, Outcome.CANCELLED_BY_PROPERTY);
    }

    /// @inheritdoc IEscrow
    function settle(bytes32 bookingId) external nonReentrant {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _escrowed(bookingId);
        // Shifted with the guest's dispute window, so settlement cannot pre-empt a dispute the guest
        // may still open after a freeze (docs/adr/0015 §1).
        if (_bookingNow(b) < uint256(b.checkOutUtc) + Params.GRACE) revert SettleTooEarly();
        _settle(bookingId, b, 0, true, Outcome.COMPLETED);
    }

    /// @dev Spec 4.4, run once per ending. Credits balances; never transfers. Fee recipient is read
    /// at settlement; the arbitrator was snapshotted at deposit (spec 3.4).
    function _settle(bytes32 bookingId, Booking storage b, uint256 refundBps, bool vested, Outcome outcome)
        private
    {
        LedgerLib.settle(_l, b, bookingId, refundBps, vested, outcome, factory.feeRecipient());
    }

    /// @dev The booking's clock: real time minus the time it spent frozen. A freeze stops the guest's
    /// policy clock and GRACE, as ADR 0011 already does for the dispute deadline (docs/adr/0015 §1;
    /// Aave's liquidation grace period after an unpause is the same principle).
    /// `cancelByProperty` keeps real time: an owner cannot evict a guest mid-stay.
    function _bookingNow(Booking storage b) private view returns (uint256) {
        return block.timestamp - b.frozenTotal;
    }

    function _escrowed(bytes32 bookingId) private view returns (Booking storage b) {
        b = _bookings[bookingId];
        if (b.state == BookingState.NONE) revert UnknownBooking();
        if (b.state != BookingState.ESCROWED) revert BookingNotEscrowed();
    }

    // ==========================================================================================
    // Disputes (spec 7; docs/adr/0011)

    /// @inheritdoc IEscrow
    /// @dev Guest only (D8). DELIVERED (check-out passed, stored state ESCROWED, not frozen) and
    /// before checkOut + GRACE. 0 < contested <= principal.
    function openDispute(bytes32 bookingId, uint256 contestedAtomic, bytes32 evidenceHash)
        external
        nonReentrant
    {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _escrowed(bookingId);
        uint256 t = _bookingNow(b);
        if (t < b.checkOutUtc) revert NotDelivered();
        if (t >= uint256(b.checkOutUtc) + Params.GRACE) revert DisputeTooLate();
        if (msg.sender != b.guest) revert NotGuest();
        if (contestedAtomic == 0 || contestedAtomic > b.principalAtomic) revert InvalidContested();
        DisputeLib.open(
            _l, b, _disputes[bookingId], bookingId, contestedAtomic, evidenceHash, factory.feeRecipient()
        );
    }

    /// @inheritdoc IEscrow
    /// @dev Only the arbitrator snapshotted on this booking (spec 3.4). `reasonCode` is a
    /// `DisputeReason` other than DEFAULT_TIMEOUT.
    function resolve(bytes32 bookingId, uint16 guestBps, uint8 reasonCode) external nonReentrant {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _disputed(bookingId);
        if (msg.sender != b.arbitrator) revert NotArbitrator();
        if (guestBps > Params.BPS) revert BpsOutOfRange();
        if (reasonCode >= uint8(DisputeReason.DEFAULT_TIMEOUT)) revert InvalidReasonCode();
        DisputeLib.resolve(
            _l, b, _disputes[bookingId], bookingId, guestBps, reasonCode, factory.feeRecipient()
        );
    }

    /// @inheritdoc IEscrow
    /// @dev Permissionless once `disputeDeadline` has passed; resolves for the owner (guestBps 0),
    /// so an unresponsive arbitrator cannot strand funds (spec 7).
    function resolveByDefault(bytes32 bookingId) external nonReentrant {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _disputed(bookingId);
        if (block.timestamp < disputeDeadline(bookingId)) revert DisputeWindowOpen();
        DisputeLib.resolve(
            _l,
            b,
            _disputes[bookingId],
            bookingId,
            0,
            uint8(DisputeReason.DEFAULT_TIMEOUT),
            factory.feeRecipient()
        );
    }

    function _disputed(bytes32 bookingId) private view returns (Booking storage b) {
        b = _bookings[bookingId];
        if (b.state != BookingState.DISPUTED) revert NotDisputed();
    }

    /// @notice openedAt + DISPUTE_WINDOW, extended by time the booking spent frozen after the dispute
    /// opened (ADR 0011). While a freeze is ongoing it is not yet included (and nothing can resolve).
    /// 0 if the booking was never disputed.
    function disputeDeadline(bytes32 bookingId) public view returns (uint256) {
        Dispute storage d = _disputes[bookingId];
        if (d.openedAt == 0) return 0;
        return
            uint256(d.openedAt) + Params.DISPUTE_WINDOW + (_bookings[bookingId].frozenTotal - d.frozenAtOpen);
    }

    function getDispute(bytes32 bookingId) external view returns (Dispute memory) {
        return _disputes[bookingId];
    }

    // ==========================================================================================
    // Claims (spec 4.5)

    /// @inheritdoc IEscrow
    /// @dev Pays min(claimable, liquid) and leaves the rest claimable. Zero claimable is a no-op,
    /// so a [cancelByGuest, claim] batch cannot fail on a 0% refund (docs/adr/0003, 0007).
    /// While lossDebt > 0 only the guest bucket is paid; a caller holding only owner or fee credits
    /// reverts (spec 4.5).
    function claim() external nonReentrant returns (uint256 paid) {
        _accrue();
        _promoteTimelocks();
        paid = LedgerLib.claim(
            _l, usdc, _activeVault(), vaultWrittenOff ? vault : IERC4626(address(0)), msg.sender, msg.sender == payoutAddress
        );
    }

    // ==========================================================================================
    // Guardian (spec 3.3, 3.5; docs/adr/0007)

    /// @inheritdoc IEscrow
    /// @dev Moves no funds and changes no accounting parameter, so like pause it does not read the
    /// vault: a broken vault must not stop the guardian (docs/adr/0013 §2, 0015 §3).
    function freezeBooking(bytes32 bookingId) external onlyGuardian nonReentrant {
        Booking storage b = _bookings[bookingId];
        BookingState s = b.state;
        if (s != BookingState.ESCROWED && s != BookingState.DISPUTED) revert NotFreezable();
        if (b.frozenTotal >= Params.MAX_FREEZE_DURATION) revert FreezeBudgetExhausted();
        b.frozenFrom = s;
        b.frozenSince = uint40(block.timestamp);
        b.state = BookingState.FROZEN;
        emit BookingFrozen(bookingId, s);
    }

    /// @inheritdoc IEscrow
    /// @dev The guardian may unfreeze at any time; anyone may once the booking's remaining freeze
    /// budget is used up. Time frozen stops the booking's clock (docs/adr/0015 §1). No vault read.
    function unfreezeBooking(bytes32 bookingId) external nonReentrant {
        Booking storage b = _bookings[bookingId];
        if (b.state != BookingState.FROZEN) revert NotFrozen();
        uint256 elapsed = block.timestamp - b.frozenSince;
        uint256 remaining = Params.MAX_FREEZE_DURATION - b.frozenTotal;
        if (elapsed < remaining && msg.sender != factory.guardian()) revert NotGuardian();
        b.frozenTotal += uint32(Math.min(elapsed, remaining));
        BookingState to = b.frozenFrom;
        b.state = to;
        b.frozenFrom = BookingState.NONE;
        b.frozenSince = 0;
        emit BookingUnfrozen(bookingId, to, b.frozenTotal);
    }

    /// @inheritdoc IEscrow
    function pauseDeposits() external onlyGuardian nonReentrant {
        _pause();
    }

    /// @inheritdoc IEscrow
    function unpauseDeposits() external onlyGuardian nonReentrant {
        _unpause();
    }

    // ==========================================================================================
    // Owner configuration (spec 3.3). Instant; none affects an existing booking's terms.

    function setPayoutAddress(address a) external onlyOwner nonReentrant {
        if (a == address(0)) revert ZeroAddress();
        _accrue();
        payoutAddress = a;
        emit PayoutAddressSet(a);
    }

    function setQuoteSigner(address a) external onlyOwner nonReentrant {
        if (a == address(0)) revert ZeroAddress();
        _accrue();
        quoteSigner = a;
        emit QuoteSignerRotated(a);
    }

    function setGuestYieldBps(uint16 bps) external onlyOwner nonReentrant {
        if (bps > Params.BPS) revert BpsOutOfRange();
        _accrue();
        guestYieldBps = bps;
        emit GuestYieldBpsSet(bps);
    }

    /// @dev Never zero: the floor is what bounds a compromised quote signer (spec 3.3).
    function setMinNightlyAtomic(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroMinNightly();
        _accrue();
        minNightlyAtomic = amount;
        emit MinNightlySet(amount);
    }

    function setMaxDeployBps(uint16 bps) external onlyOwner nonReentrant {
        if (bps > Params.BPS - Params.MIN_BUFFER_BPS) revert BpsOutOfRange();
        _accrue();
        maxDeployBps = bps;
        emit MaxDeployBpsSet(bps);
    }

    /// @dev address(0) disables rebalancing.
    function setRebalancer(address a) external onlyOwner nonReentrant {
        _accrue();
        rebalancer = a;
        emit RebalancerSet(a);
    }

    function setMaxOpenPrincipal(uint256 amount) external onlyOwner nonReentrant {
        _accrue();
        maxOpenPrincipalAtomic = amount;
        emit MaxOpenPrincipalSet(amount);
    }

    /// @dev Renouncing would strand owner-only functions (cancelByProperty, and C2's topUpLoss).
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ==========================================================================================
    // Factory admin, timelocked (spec 3.3, 3.4)

    /// @inheritdoc IEscrow
    function proposeFeeBps(uint16 newFeeBps) external onlyFactoryAdmin nonReentrant {
        if (newFeeBps > maxFeeBps) revert FeeAboveMax();
        _accrue();
        _promoteTimelocks(); // never overwrite a change that is already effective (review 0001 #13)
        uint64 effectiveAt = uint64(block.timestamp + Params.FEE_CHANGE_DELAY);
        pendingFeeBps = newFeeBps;
        pendingFeeAt = effectiveAt;
        emit FeeChangeProposed(newFeeBps, effectiveAt);
    }

    /// @inheritdoc IEscrow
    function proposeArbitrator(address newArbitrator) external onlyFactoryAdmin nonReentrant {
        if (newArbitrator == address(0)) revert ZeroAddress();
        _accrue();
        _promoteTimelocks();
        uint64 effectiveAt = uint64(block.timestamp + Params.ARBITRATOR_DELAY);
        pendingArbitrator = newArbitrator;
        pendingArbitratorAt = effectiveAt;
        emit ArbitratorChangeProposed(newArbitrator, effectiveAt);
    }

    /// @dev Lazy timelocks: pending values become current once effective (spec 3.4).
    function _promoteTimelocks() private {
        if (pendingFeeAt != 0 && block.timestamp >= pendingFeeAt) {
            feeBps = pendingFeeBps;
            pendingFeeBps = 0;
            pendingFeeAt = 0;
        }
        if (pendingArbitratorAt != 0 && block.timestamp >= pendingArbitratorAt) {
            arbitrator = pendingArbitrator;
            pendingArbitrator = address(0);
            pendingArbitratorAt = 0;
        }
    }

    // ==========================================================================================
    // Hooks for C2

    /// @dev Spec 6.1 with the high-water-mark baseline (docs/adr/0009); see LedgerLib.accrue.
    function _accrue() internal {
        LedgerLib.accrue(_l, usdc, _activeVault());
    }

    /// @dev The vault accounting reads: none once written off (docs/adr/0013 §3).
    function _activeVault() internal view returns (IERC4626) {
        return vaultWrittenOff ? IERC4626(address(0)) : vault;
    }

    // ==========================================================================================
    // Yield deployment (spec 6.3)

    modifier onlyRebalancer() {
        if (msg.sender != rebalancer || msg.sender == address(0)) revert NotRebalancer();
        _;
    }

    /// @inheritdoc IEscrow
    function deploy(uint256 assets) external onlyRebalancer nonReentrant {
        if (vaultWrittenOff) revert VaultIsWrittenOff();
        _accrue();
        LedgerLib.deploy(_l, usdc, vault, assets, maxDeployBps);
    }

    /// @inheritdoc IEscrow
    /// @dev Allowed during a loss: the rebalancer may always move funds back to idle (spec 6.4).
    /// While written off, redeeming is still allowed: Yearn's "all possible assets should be removed"
    /// (docs/adr/0015 §2). The value lands in idle, which accounting counts.
    function redeem(uint256 assets) external onlyRebalancer nonReentrant {
        _accrue();
        if (address(vault) == address(0)) revert NoVault();
        if (assets == 0) revert ZeroAmount();
        LedgerLib.pullFromVault(vault, assets);
    }

    // ==========================================================================================
    // Loss handling (spec 6.4; docs/adr/0009, 0010)

    /// @inheritdoc IEscrow
    function observeShortfall() external nonReentrant {
        _accrue();
    }

    /// @inheritdoc IEscrow
    function recogniseLoss() external nonReentrant {
        _accrue();
        LedgerLib.recogniseLoss(_l, usdc, _activeVault());
    }

    /// @inheritdoc IEscrow
    /// @dev Yearn V3 `force_revoke_strategy` / Morpho Vault V2 `removeAdapter` pattern. The flag is
    /// set before accrue() because accrue() cannot read a broken vault (a documented exception to
    /// money rule 4). The position then shows as an observed shortfall: guests are paid first from
    /// idle, and after LOSS_CONFIRMATION_WINDOW it is recognised reserve -> owner -> lossDebt.
    function writeOffVault() external onlyOwnerOrGuardian nonReentrant {
        if (address(vault) == address(0)) revert NoVault();
        if (vaultWrittenOff) revert VaultIsWrittenOff();
        vaultWrittenOff = true;
        emit VaultWrittenOff(msg.sender);
        _accrue();
    }

    /// @inheritdoc IEscrow
    /// @dev Accounting reads the vault again (reverts if it is still broken). Recovered value is a
    /// gain: it repays lossDebt first, then is distributed as yield (Yearn: "the loss will be
    /// credited as profit").
    function recoverVault() external onlyOwnerOrGuardian nonReentrant {
        if (!vaultWrittenOff) revert VaultNotWrittenOff();
        vaultWrittenOff = false;
        emit VaultRecovered(msg.sender);
        _accrue();
    }

    /// @inheritdoc IEscrow
    function topUpLoss(uint256 amount) external onlyOwner nonReentrant {
        _accrue();
        uint256 debt = _l.lossDebt;
        if (debt == 0) revert NoLossDebt();
        uint256 take = Math.min(amount, debt);
        if (take == 0) revert ZeroAmount();
        _l.lossDebt = debt - take;
        _l.lastAssets += take;
        emit LossToppedUp(take, debt - take);
        _pullExact(take);
    }

    // ==========================================================================================
    // Reserve (spec 6.5)

    /// @inheritdoc IEscrow
    function fundReserve(uint256 amount) external onlyOwner nonReentrant {
        _accrue();
        if (amount == 0) revert ZeroAmount();
        _l.reserve += amount;
        _l.lastAssets += amount;
        emit ReserveFunded(amount);
        _pullExact(amount);
    }

    /// @inheritdoc IEscrow
    /// @dev A new proposal replaces the old one; proposing 0 cancels.
    function proposeReserveWithdrawal(uint256 amount, uint8 reasonCode) external onlyOwner nonReentrant {
        _accrue();
        _l.pendingReserveWithdrawal = amount;
        _l.pendingReserveReason = reasonCode;
        emit ReserveWithdrawalProposed(amount, reasonCode);
    }

    /// @inheritdoc IEscrow
    /// @dev The guardian confirms the exact proposal, so it cannot be swapped underneath them.
    /// Pays the current payout address; blocked while a loss is active (docs/adr/0009).
    function confirmReserveWithdrawal(uint256 amount, uint8 reasonCode) external onlyGuardian nonReentrant {
        _accrue();
        LedgerLib.withdrawReserve(
            _l, usdc, _activeVault(), amount, reasonCode, payoutAddress, address(vault) != address(0)
        );
    }

    /// @dev Pulls exactly `amount` from the caller and checks the balance delta (deposit guard 12).
    function _pullExact(uint256 amount) private {
        uint256 before = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - before != amount) revert TransferAmountMismatch();
    }

    // ==========================================================================================
    // Views

    function hashQuote(Quote calldata q) external pure returns (bytes32) {
        return QuoteLib.hash(q);
    }

    function quoteDigest(Quote calldata q) external view returns (bytes32) {
        return _hashTypedDataV4(QuoteLib.hash(q));
    }

    function effectiveFeeBps() public view returns (uint16) {
        return (pendingFeeAt != 0 && block.timestamp >= pendingFeeAt) ? pendingFeeBps : feeBps;
    }

    function effectiveArbitrator() public view returns (address) {
        return
            (pendingArbitratorAt != 0 && block.timestamp >= pendingArbitratorAt)
                ? pendingArbitrator
                : arbitrator;
    }

    function bookingState(bytes32 bookingId) external view returns (BookingState s) {
        Booking storage b = _bookings[bookingId];
        s = b.state;
        if (s == BookingState.ESCROWED && _bookingNow(b) >= b.checkOutUtc) s = BookingState.DELIVERED;
    }

    function getBooking(bytes32 bookingId) external view returns (Booking memory) {
        return _bookings[bookingId];
    }

    function getCutoffs(bytes32 bookingId) external view returns (Cutoff[] memory) {
        return _cutoffs[bookingId];
    }

    /// @notice Refund bps if the guest cancelled now. Reverts when not cancellable.
    function refundBpsNow(bytes32 bookingId) external view returns (uint16) {
        Booking storage b = _escrowed(bookingId);
        uint256 t = _bookingNow(b);
        if (t >= b.checkOutUtc) revert NotCancellable();
        return QuoteLib.refundBps(_cutoffs[bookingId], b.finalBps, b.checkInUtc, t);
    }

    function claimableOf(address account) external view returns (uint256) {
        return _l.guestClaimable[account] + _l.feeClaimable[account]
            + (account == payoutAddress ? _l.ownerClaimable : 0);
    }

    function totalAssets() public view returns (uint256) {
        return LedgerLib.totalAssets(usdc, _activeVault());
    }

    /// @notice Assets below the booked baseline, not yet recognised as a loss.
    function shortfall() external view returns (uint256) {
        uint256 assets = totalAssets();
        return _l.lastAssets > assets ? _l.lastAssets - assets : 0;
    }

    function pendingYieldOf(address account) external view returns (uint256) {
        return _l.pendingGuestYield[account] + (account == payoutAddress ? _l.pendingOwnerYield : 0);
    }

    // ---------------------------------------------------------------------------- ledger getters

    function totalOpenPrincipal() external view returns (uint256) {
        return _l.totalOpenPrincipal;
    }

    function totalDisputed() external view returns (uint256) {
        return _l.totalDisputed;
    }

    function totalPendingYield() external view returns (uint256) {
        return _l.totalPendingYield;
    }

    function totalClaimable() external view returns (uint256) {
        return _l.totalClaimable;
    }

    function reserve() external view returns (uint256) {
        return _l.reserve;
    }

    function lossDebt() external view returns (uint256) {
        return _l.lossDebt;
    }

    function accYieldPerUnit() external view returns (uint256) {
        return _l.accYieldPerUnit;
    }

    function lastAssets() external view returns (uint256) {
        return _l.lastAssets;
    }

    function yieldUnallocated() external view returns (uint256) {
        return _l.yieldUnallocated;
    }

    function ownerClaimable() external view returns (uint256) {
        return _l.ownerClaimable;
    }

    function pendingOwnerYield() external view returns (uint256) {
        return _l.pendingOwnerYield;
    }

    function shortfallSince() external view returns (uint40) {
        return _l.shortfallSince;
    }

    function pendingReserveWithdrawal() external view returns (uint256 amount, uint8 reasonCode) {
        return (_l.pendingReserveWithdrawal, _l.pendingReserveReason);
    }

    function guestClaimable(address account) external view returns (uint256) {
        return _l.guestClaimable[account];
    }

    function feeClaimable(address account) external view returns (uint256) {
        return _l.feeClaimable[account];
    }

    function pendingGuestYield(address account) external view returns (uint256) {
        return _l.pendingGuestYield[account];
    }
}
