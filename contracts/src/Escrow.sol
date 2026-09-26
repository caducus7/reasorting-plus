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

import {IEscrow, Quote, Cutoff, Booking, BookingState, Outcome, EscrowInit} from "./interfaces/IEscrow.sol";
import {IEscrowFactory} from "./interfaces/IEscrowFactory.sol";
import {QuoteLib} from "./libraries/QuoteLib.sol";
import {SettlementLib} from "./libraries/SettlementLib.sol";
import {Params} from "./libraries/Params.sol";

/// @title Escrow
/// @notice One per property owner, deployed by `EscrowFactory` as an EIP-1167 clone (docs/adr/0005).
/// Holds guests' USDC prepayments against server-signed quotes until the stay completes
/// (docs/chain-spec.md sections 3 and 4).
/// @dev Work package C1. Yield accounting (C2) and disputes (C3) plug into `_accrue`,
/// `_crystalliseYield` and the accounting fields declared below.
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
    // Accounting (spec 6.1). C2 and C3 own the fields C1 leaves at zero.

    uint256 public totalOpenPrincipal;
    uint256 public totalDisputed;
    uint256 public totalPendingYield;
    uint256 public totalClaimable;
    uint256 public reserve;
    uint256 public lossDebt;
    uint256 public accYieldPerUnit;
    uint256 public lastAssets;

    /// @notice Claim buckets (docs/adr/0007). The owner's bucket is not keyed by address, so
    /// changing the payout address cannot strand credits or escape the lossDebt gate.
    mapping(address => uint256) public guestClaimable;
    mapping(address => uint256) public feeClaimable;
    uint256 public ownerClaimable;

    mapping(bytes32 => Booking) internal _bookings;
    mapping(bytes32 => Cutoff[]) internal _cutoffs;

    // ------------------------------------------------------------------------------------------

    modifier onlyGuardian() {
        if (msg.sender != factory.guardian()) revert NotGuardian();
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
        if (lossDebt != 0) revert LossDebtOutstanding();
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
        if (totalOpenPrincipal + q.priceAtomic > maxOpenPrincipalAtomic) revert EscrowCapExceeded();

        // 12: accrue, record, then pull exactly priceAtomic and check the balance delta.
        _accrue();
        _promoteTimelocks();
        address bookingArbitrator = arbitrator;
        uint256 acc = accYieldPerUnit;
        _store(bookingId, q, bookingArbitrator, acc);
        totalOpenPrincipal += q.priceAtomic;
        lastAssets += q.priceAtomic;

        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), q.priceAtomic);
        if (usdc.balanceOf(address(this)) - balanceBefore != q.priceAtomic) revert TransferAmountMismatch();

        _emitDeposited(bookingId, q, bookingArbitrator, acc);
    }

    function _store(bytes32 bookingId, Quote calldata q, address bookingArbitrator, uint256 acc) private {
        Booking storage b = _bookings[bookingId];
        b.guest = q.guest;
        b.checkInUtc = q.checkInUtc;
        b.checkOutUtc = q.checkOutUtc;
        b.feeBps = q.feeBps;
        b.state = BookingState.ESCROWED;
        b.arbitrator = bookingArbitrator;
        b.guestYieldBps = q.guestYieldBps;
        b.finalBps = q.finalBps;
        b.resourceId = q.resourceId;
        b.principalAtomic = q.priceAtomic;
        b.accAtDeposit = acc;
        Cutoff[] storage cs = _cutoffs[bookingId];
        for (uint256 i; i < q.cutoffs.length; ++i) {
            cs.push(q.cutoffs[i]);
        }
    }

    function _emitDeposited(bytes32 bookingId, Quote calldata q, address bookingArbitrator, uint256 acc)
        private
    {
        emit BookingDeposited(
            bookingId,
            q.guest,
            q.resourceId,
            q.checkInUtc,
            q.checkOutUtc,
            q.priceAtomic,
            q.feeBps,
            q.guestYieldBps,
            q.policyHash,
            q.cutoffs,
            q.finalBps,
            bookingArbitrator,
            acc
        );
    }

    // ==========================================================================================
    // Cancel and settle (spec 3.5, 4.3, 4.4, 4.6)

    /// @inheritdoc IEscrow
    function cancelByGuest(bytes32 bookingId) external nonReentrant {
        _accrue();
        _promoteTimelocks();
        Booking storage b = _escrowed(bookingId);
        if (msg.sender != b.guest) revert NotGuest();
        if (block.timestamp >= b.checkOutUtc) revert NotCancellable();
        uint16 bps = QuoteLib.refundBps(_cutoffs[bookingId], b.finalBps, b.checkInUtc, block.timestamp);
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
        if (block.timestamp < uint256(b.checkOutUtc) + Params.GRACE) revert SettleTooEarly();
        _settle(bookingId, b, 0, true, Outcome.COMPLETED);
    }

    /// @dev Spec 4.4, run once per ending. Credits balances; never transfers.
    function _settle(bytes32 bookingId, Booking storage b, uint256 refundBps, bool vested, Outcome outcome)
        private
    {
        uint256 principal = b.principalAtomic;
        uint256 y = _crystalliseYield(bookingId);
        SettlementLib.Figures memory f =
            SettlementLib.compute(principal, refundBps, b.feeBps, y, b.guestYieldBps, vested);

        b.state = BookingState.SETTLED;
        totalOpenPrincipal -= principal;

        // Fee recipient is read at settlement; the arbitrator was snapshotted at deposit (spec 3.4).
        address feeTo = factory.feeRecipient();
        guestClaimable[b.guest] += f.refund + f.guestYield;
        ownerClaimable += f.ownerPrincipal + f.ownerYield;
        feeClaimable[feeTo] += f.fee;
        totalClaimable += principal + y;

        emit BookingSettled(
            bookingId,
            outcome,
            principal,
            f.refund,
            f.ownerPrincipal,
            f.fee,
            y,
            f.guestYield,
            f.ownerYield,
            feeTo
        );
    }

    function _escrowed(bytes32 bookingId) private view returns (Booking storage b) {
        b = _bookings[bookingId];
        if (b.state == BookingState.NONE) revert UnknownBooking();
        if (b.state != BookingState.ESCROWED) revert BookingNotEscrowed();
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

        uint256 g = guestClaimable[msg.sender];
        uint256 f = feeClaimable[msg.sender];
        uint256 o = msg.sender == payoutAddress ? ownerClaimable : 0;
        if (lossDebt != 0) {
            if (g == 0 && (f != 0 || o != 0)) revert LossDebtOutstanding();
            f = 0;
            o = 0;
        }
        uint256 requested = g + f + o;
        if (requested == 0) return 0;

        // Checks: size the vault pull from views only, so every state write precedes every
        // external call (checks-effects-interactions).
        uint256 idle = usdc.balanceOf(address(this));
        uint256 pull;
        if (idle < requested && address(vault) != address(0)) {
            pull = Math.min(requested - idle, vault.maxWithdraw(address(this)));
        }
        paid = Math.min(requested, idle + pull);

        // Effects: guest bucket first, then fee, then owner.
        uint256 left = paid;
        uint256 fromGuest = Math.min(left, g);
        guestClaimable[msg.sender] = g - fromGuest;
        left -= fromGuest;
        uint256 fromFee = Math.min(left, f);
        feeClaimable[msg.sender] -= fromFee;
        left -= fromFee;
        ownerClaimable -= left;
        totalClaimable -= paid;
        lastAssets -= paid;
        emit Claimed(msg.sender, requested, paid);

        // Interactions. The vault receiver is always the escrow itself (CLAUDE.md money rule 3).
        if (pull != 0) {
            vault.withdraw(pull, address(this), address(this));
            emit Redeemed(pull);
        }
        if (paid != 0) usdc.safeTransfer(msg.sender, paid);
    }

    // ==========================================================================================
    // Guardian (spec 3.3, 3.5; docs/adr/0007)

    /// @inheritdoc IEscrow
    function freezeBooking(bytes32 bookingId) external onlyGuardian nonReentrant {
        _accrue();
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
    /// budget is used up. Time frozen does not extend GRACE (spec 3.5).
    function unfreezeBooking(bytes32 bookingId) external nonReentrant {
        _accrue();
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

    /// @dev C1: tracks assets only. C2 replaces this with the accumulator (spec 6.1).
    function _accrue() internal {
        lastAssets = _totalAssets();
    }

    /// @dev C1: no yield. C2 returns principal * (accYieldPerUnit - accAtDeposit) / 1e18.
    function _crystalliseYield(bytes32) internal pure returns (uint256) {
        return 0;
    }

    function _totalAssets() internal view returns (uint256 assets) {
        assets = usdc.balanceOf(address(this));
        if (address(vault) != address(0)) assets += vault.previewRedeem(vault.balanceOf(address(this)));
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
        if (s == BookingState.ESCROWED && block.timestamp >= b.checkOutUtc) s = BookingState.DELIVERED;
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
        if (block.timestamp >= b.checkOutUtc) revert NotCancellable();
        return QuoteLib.refundBps(_cutoffs[bookingId], b.finalBps, b.checkInUtc, block.timestamp);
    }

    function claimableOf(address account) external view returns (uint256) {
        return
            guestClaimable[account] + feeClaimable[account] + (account == payoutAddress ? ownerClaimable : 0);
    }

    function totalAssets() external view returns (uint256) {
        return _totalAssets();
    }
}
