// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Vm} from "forge-std/Vm.sol";
import {YieldTestBase} from "../utils/YieldTestBase.sol";
import {MockVault} from "../utils/Mocks.sol";
import {IEscrowEvents, BookingState, Quote} from "../../src/interfaces/IEscrow.sol";

/// Regression tests for the review 0004 fixes (docs/adr/0015), beyond the reviewer's own PoCs in
/// test/review/Review0004.t.sol, which now pass.
contract Review0004FixesTest is YieldTestBase {
    // ================================================================== R1: the booking's clock

    /// Settlement moves with the tolled dispute window, so nobody can settle a booking while its
    /// guest may still open a dispute.
    function test_R1_settleCannotPreemptTolledDisputeWindow() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        vm.warp(uint256(q.checkOutUtc) + 1 hours);
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.warp(block.timestamp + 10 days);
        vm.prank(guardian);
        escrow.unfreezeBooking(id);

        vm.warp(uint256(q.checkOutUtc) + 72 hours); // real GRACE over, booking clock 10 days behind
        vm.expectRevert(SettleTooEarly.selector);
        escrow.settle(id);
        vm.warp(uint256(q.checkOutUtc) + 10 days + 2 hours); // booking clock: 2 hours into GRACE
        vm.expectRevert(SettleTooEarly.selector);
        escrow.settle(id);
        vm.prank(guest);
        escrow.openDispute(id, 1 * USDC, keccak256("evidence")); // still inside the tolled window
        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.DISPUTED));
    }

    /// The owner-side bound keeps real time: a freeze does not let an owner cancel a guest mid-stay.
    function test_R1_cancelByPropertyKeepsRealTime() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        vm.warp(uint256(q.checkInUtc) - 10 days); // 25% tier (cutoffs at -30d, -14d, -7d)
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.warp(block.timestamp + 12 days);
        vm.prank(guardian);
        escrow.unfreezeBooking(id); // real time is past check-in; the booking clock is not
        vm.prank(owner);
        vm.expectRevert(PropertyCancelTooLate.selector);
        escrow.cancelByProperty(id);
        assertEq(escrow.refundBpsNow(id), 2_500, "guest keeps the tier they had when frozen");
    }

    // ================================================================== R5: freeze without the vault

    function test_R5_freezeAndUnfreezeWorkWithABrokenVault() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        _deployMax();
        vault.setBroken(true);
        uint256 la = escrow.lastAssets();
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        assertEq(escrow.lastAssets(), la, "no accounting change");
    }

    // ================================================================== R7: no yield during a loss

    function test_R7_yieldDeferredDuringObservedShortfallAndReleasedAfter() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        _deployMax();
        _gain(100 * USDC);
        escrow.observeShortfall(); // distributes the gain
        _loss(10 * USDC); // below the booked high-water mark: a shortfall >= MIN_LOSS_ATOMIC
        escrow.observeShortfall();
        assertGt(escrow.shortfallSince(), 0);

        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        vm.recordLogs();
        escrow.settle(id);
        assertTrue(_emitted(IEscrowEvents.YieldDeferred.selector), "yield deferred while a loss is active");
        assertEq(escrow.claimableOf(guest), 0, "guest yield is not claimable ahead of other guests' principal");
        assertGt(escrow.pendingYieldOf(guest), 0);

        _gain(20 * USDC); // the vault recovers: the shortfall clears
        escrow.observeShortfall();
        assertEq(escrow.shortfallSince(), 0);
        uint256 pending = escrow.pendingYieldOf(guest);
        vm.prank(guest);
        assertEq(escrow.claim(), pending, "released and paid once no loss is active");
        _assertBooksBalance();
    }

    // ================================================================== R2: write-off keeps paying

    /// After a healthy vault is written off and the "loss" recognised, a guest claim still pulls from
    /// the vault, and the pulled value comes back as a gain that repays lossDebt first (ADR 0013 §3).
    function test_R2_claimPullsFromWrittenOffVaultAndRecoveryRepaysDebt() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        _deployMax();
        vm.prank(owner);
        escrow.writeOffVault();
        vm.warp(block.timestamp + 6 hours);
        escrow.recogniseLoss();
        uint256 debt = escrow.lossDebt();
        assertGt(debt, 0);

        vm.prank(guest);
        escrow.cancelByGuest(id);
        vm.recordLogs();
        vm.prank(guest);
        assertEq(escrow.claim(), q.priceAtomic, "the full refund, pulled from the written-off vault");
        // The pulled value is booked inside the claim, before paying: a gain that repays debt first.
        assertTrue(_emitted(IEscrowEvents.LossRepaid.selector), "pulled value repays lossDebt first");
        assertLt(escrow.lossDebt(), debt);
        _assertBooksBalance();
    }

    /// Idle already covers the claim: the written-off vault is not touched.
    function test_R2_writtenOffClaimCoveredByIdleSkipsTheVault() public {
        _deposit(_quote());
        address g2 = makeAddr("guest2");
        Quote memory small = _quoteFor(g2, uint40(T0 + 60 days), uint40(T0 + 61 days), 100 * USDC);
        bytes32 id2 = _deposit(small);
        _deployMax(); // idle is 10% of 5,700 plus the reserve: more than 100
        vm.prank(owner);
        escrow.writeOffVault();
        vm.prank(g2);
        escrow.cancelByGuest(id2); // 100% tier: 100 USDC
        uint256 shares = vault.balanceOf(address(escrow));
        vm.prank(g2);
        assertEq(escrow.claim(), 100 * USDC);
        assertEq(vault.balanceOf(address(escrow)), shares, "vault untouched");
    }

    /// The written-off vault reports nothing withdrawable: the claim pays idle and keeps the rest.
    function test_R2_writtenOffVaultWithNoLiquidityPaysIdleOnly() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        _deployMax();
        vm.prank(owner);
        escrow.writeOffVault();
        vault.setWithdrawLimit(0);
        vm.prank(guest);
        escrow.cancelByGuest(id);
        uint256 idle = usdc.balanceOf(address(escrow));
        vm.prank(guest);
        assertEq(escrow.claim(), idle);
        assertEq(escrow.claimableOf(guest), q.priceAtomic - idle, "the rest stays credited");
    }

    function _emitted(bytes32 topic) internal returns (bool) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == topic) return true;
        }
        return false;
    }
}
