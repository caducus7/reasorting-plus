// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {Quote, Booking, BookingState, Outcome} from "../../src/interfaces/IEscrow.sol";

contract LifecycleTest is EscrowTestBase {
    bytes32 internal id;
    // Timestamps from the deposited quote (a Quote with a dynamic array cannot be copied to storage
    // under the legacy code generator).
    Times internal q;

    struct Times {
        uint40 checkInUtc;
        uint40 checkOutUtc;
        uint40[3] cut;
    }
    uint256 internal constant P = 5_600 * USDC;

    function setUp() public override {
        super.setUp();
        Quote memory quote = _quote();
        id = _deposit(quote);
        q = Times(
            quote.checkInUtc,
            quote.checkOutUtc,
            [quote.cutoffs[0].cutoffUtc, quote.cutoffs[1].cutoffUtc, quote.cutoffs[2].cutoffUtc]
        );
    }

    function _state() internal view returns (BookingState) {
        return escrow.bookingState(id);
    }

    // ------------------------------------------------------------------ cancelByGuest (spec 4.3)

    function _cancelAt(uint256 t) internal returns (uint256 refund) {
        vm.warp(t);
        uint256 before = escrow.guestClaimable(guest);
        vm.prank(guest);
        escrow.cancelByGuest(id);
        refund = escrow.guestClaimable(guest) - before;
    }

    function test_cancel_beforeFirstCutoff_full() public {
        assertEq(_cancelAt(q.cut[0] - 1), P);
    }

    function test_cancel_atFirstCutoffSecond_dropsToNextTier() public {
        // "now < cutoffUtc" is strict: at the cutoff second the next tier applies.
        assertEq(_cancelAt(q.cut[0]), P / 2);
    }

    function test_cancel_lastTier() public {
        assertEq(_cancelAt(q.cut[2] - 1), P / 4);
    }

    function test_cancel_afterLastCutoff_final() public {
        assertEq(_cancelAt(q.cut[2]), 0);
    }

    function test_cancel_atCheckIn_final() public {
        assertEq(_cancelAt(q.checkInUtc), 0);
    }

    function test_cancel_atCheckOutMinus1_allowed() public {
        assertEq(_cancelAt(q.checkOutUtc - 1), 0);
        assertEq(uint8(_state()), uint8(BookingState.SETTLED));
    }

    function test_cancel_atCheckOut_reverts() public {
        vm.warp(q.checkOutUtc);
        vm.prank(guest);
        vm.expectRevert(NotCancellable.selector);
        escrow.cancelByGuest(id);
    }

    function test_cancel_onlyGuest() public {
        vm.prank(owner);
        vm.expectRevert(NotGuest.selector);
        escrow.cancelByGuest(id);
    }

    function test_cancel_unknownBooking() public {
        vm.prank(guest);
        vm.expectRevert(UnknownBooking.selector);
        escrow.cancelByGuest(bytes32(uint256(1)));
    }

    function test_cancel_twiceReverts() public {
        _cancelAt(block.timestamp);
        vm.prank(guest);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.cancelByGuest(id);
    }

    function test_cancel_figuresAndEvents() public {
        vm.warp(q.cut[2] - 1); // 25% tier: before the 7-day cutoff
        vm.expectEmit(address(escrow));
        emit BookingCancelled(id, Outcome.CANCELLED_BY_GUEST, 2_500);
        vm.expectEmit(address(escrow));
        // refund 1,400; retained 4,200; fee 5% of retained = 210; owner 3,990; no yield in C1
        emit BookingSettled(
            id, Outcome.CANCELLED_BY_GUEST, P, 1_400 * USDC, 3_990 * USDC, 210 * USDC, 0, 0, 0, feeTo
        );
        vm.prank(guest);
        escrow.cancelByGuest(id);
        assertEq(escrow.guestClaimable(guest), 1_400 * USDC);
        assertEq(escrow.ownerClaimable(), 3_990 * USDC);
        assertEq(escrow.feeClaimable(feeTo), 210 * USDC);
        assertEq(escrow.totalOpenPrincipal(), 0);
        assertEq(escrow.totalClaimable(), P);
    }

    function test_refundBpsNow() public {
        assertEq(escrow.refundBpsNow(id), 10_000);
        vm.warp(q.checkInUtc);
        assertEq(escrow.refundBpsNow(id), 0);
        vm.warp(q.checkOutUtc);
        vm.expectRevert(NotCancellable.selector);
        escrow.refundBpsNow(id);
    }

    // ------------------------------------------------------------------ cancelByProperty

    function test_propertyCancel_fullRefundNoFee() public {
        vm.warp(q.checkInUtc - 1);
        vm.prank(owner);
        escrow.cancelByProperty(id);
        assertEq(escrow.guestClaimable(guest), P);
        assertEq(escrow.feeClaimable(feeTo), 0);
        assertEq(escrow.ownerClaimable(), 0);
    }

    function test_propertyCancel_atCheckInReverts() public {
        vm.warp(q.checkInUtc);
        vm.prank(owner);
        vm.expectRevert(PropertyCancelTooLate.selector);
        escrow.cancelByProperty(id);
    }

    function test_propertyCancel_onlyOwner() public {
        vm.prank(guest);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guest));
        escrow.cancelByProperty(id);
    }

    // ------------------------------------------------------------------ delivery and settle (spec 3.5, 4.6)

    function test_deliveredIsDerivedFromTime() public {
        vm.warp(q.checkOutUtc - 1);
        assertEq(uint8(_state()), uint8(BookingState.ESCROWED));
        vm.warp(q.checkOutUtc);
        assertEq(uint8(_state()), uint8(BookingState.DELIVERED));
    }

    function test_settle_tooEarlyAtGraceMinus1() public {
        vm.warp(uint256(q.checkOutUtc) + 72 hours - 1);
        vm.expectRevert(SettleTooEarly.selector);
        escrow.settle(id);
    }

    function test_settle_permissionlessAtGrace() public {
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        vm.prank(makeAddr("anyone"));
        escrow.settle(id);
        assertEq(escrow.guestClaimable(guest), 0);
        assertEq(escrow.feeClaimable(feeTo), 280 * USDC); // 5% of the full price
        assertEq(escrow.ownerClaimable(), 5_320 * USDC);
        assertEq(uint8(_state()), uint8(BookingState.SETTLED));
    }

    function test_settle_feeRecipientReadAtSettlement() public {
        address newFeeTo = makeAddr("newFeeTo");
        vm.prank(admin);
        factory.proposeFeeRecipient(newFeeTo);
        vm.warp(uint256(q.checkOutUtc) + 72 hours); // > 7 days later: new recipient effective
        escrow.settle(id);
        assertEq(escrow.feeClaimable(newFeeTo), 280 * USDC);
        assertEq(escrow.feeClaimable(feeTo), 0);
    }

    function test_settle_usesFeeLockedAtDeposit() public {
        vm.prank(admin);
        escrow.proposeFeeBps(1_000);
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        assertEq(escrow.effectiveFeeBps(), 1_000);
        escrow.settle(id);
        assertEq(escrow.feeClaimable(feeTo), 280 * USDC, "5% locked at deposit, not the new 10%");
    }

    // ------------------------------------------------------------------ freeze (spec 3.5, docs/adr/0007)

    function _freeze() internal {
        vm.prank(guardian);
        escrow.freezeBooking(id);
    }

    function test_frozen_blocksCancelAndSettle() public {
        _freeze();
        vm.prank(guest);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.cancelByGuest(id);
        vm.prank(owner);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.cancelByProperty(id);
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        assertEq(uint8(_state()), uint8(BookingState.FROZEN), "freeze halts time-derived delivery");
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.settle(id);
    }

    /// Amended by docs/adr/0015 §1: frozen time stops the booking's clock (capped by the 30-day
    /// budget), so the guest keeps the time they were locked out of.
    function test_unfreeze_restoresClockDerivedState() public {
        _freeze();
        vm.warp(uint256(q.checkOutUtc) + 72 hours); // frozen across check-out and GRACE
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        assertEq(uint8(_state()), uint8(BookingState.ESCROWED), "booking clock is 30 days behind");
        vm.expectRevert(SettleTooEarly.selector);
        escrow.settle(id);
        vm.warp(uint256(q.checkOutUtc) + 30 days);
        assertEq(uint8(_state()), uint8(BookingState.DELIVERED));
        vm.warp(uint256(q.checkOutUtc) + 72 hours + 30 days);
        escrow.settle(id);
    }

    function test_freeze_onlyGuardian() public {
        vm.prank(owner);
        vm.expectRevert(NotGuardian.selector);
        escrow.freezeBooking(id);
    }

    function test_freeze_notFreezableWhenSettled() public {
        _cancelAt(block.timestamp);
        vm.prank(guardian);
        vm.expectRevert(NotFreezable.selector);
        escrow.freezeBooking(id);
    }

    function test_unfreeze_notFrozen() public {
        vm.prank(guardian);
        vm.expectRevert(NotFrozen.selector);
        escrow.unfreezeBooking(id);
    }

    function test_unfreeze_permissionlessAfterBudget() public {
        _freeze();
        vm.warp(block.timestamp + 30 days - 1);
        vm.prank(guest);
        vm.expectRevert(NotGuardian.selector);
        escrow.unfreezeBooking(id);
        vm.warp(block.timestamp + 1);
        vm.prank(guest);
        escrow.unfreezeBooking(id);
        assertEq(escrow.getBooking(id).frozenTotal, 30 days);
        vm.prank(guardian);
        vm.expectRevert(FreezeBudgetExhausted.selector);
        escrow.freezeBooking(id);
    }

    function test_freeze_budgetIsCumulative() public {
        _freeze();
        vm.warp(block.timestamp + 20 days);
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        _freeze();
        vm.warp(block.timestamp + 10 days); // 20 + 10 = budget used
        vm.prank(makeAddr("anyone"));
        escrow.unfreezeBooking(id);
        assertEq(escrow.getBooking(id).frozenTotal, 30 days);
    }

    function test_freeze_guardianRotationIsLive() public {
        address newGuardian = makeAddr("newGuardian");
        vm.prank(admin);
        factory.setGuardian(newGuardian);
        vm.prank(guardian);
        vm.expectRevert(NotGuardian.selector);
        escrow.freezeBooking(id);
        vm.prank(newGuardian);
        escrow.freezeBooking(id);
    }

    /// Disputes are C3's; the stored state is set directly to test freeze-from-DISPUTED (docs/adr/0007).
    function test_freeze_fromDisputedRestoresDisputed() public {
        // `_bookings` is at slot 26 (forge inspect Escrow storageLayout); Booking.state is byte 0 of word 1.
        uint256 slot1 = uint256(keccak256(abi.encode(id, uint256(26)))) + 1;
        bytes32 word = vm.load(address(escrow), bytes32(slot1));
        vm.store(
            address(escrow),
            bytes32(slot1),
            (word & ~bytes32(uint256(0xff))) | bytes32(uint256(BookingState.DISPUTED))
        );
        assertEq(uint8(escrow.getBooking(id).state), uint8(BookingState.DISPUTED));
        _freeze();
        assertEq(uint8(escrow.getBooking(id).frozenFrom), uint8(BookingState.DISPUTED));
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        assertEq(uint8(escrow.getBooking(id).state), uint8(BookingState.DISPUTED));
    }
}
