// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Vm} from "forge-std/Vm.sol";
import {YieldTestBase} from "../utils/YieldTestBase.sol";
import {IEscrowEvents, Quote, BookingState, Dispute, DisputeReason} from "../../src/interfaces/IEscrow.sol";

contract DisputeTest is YieldTestBase {
    uint256 internal constant P = 5_600 * USDC;
    uint256 internal constant VAULT_ROUNDING = 3;
    uint8 internal constant REASON = uint8(DisputeReason.NOT_AS_DESCRIBED);

    bytes32 internal id;
    uint40 internal checkOut;

    function setUp() public override {
        super.setUp();
        Quote memory q = _quote(); // 5,600 USDC, check-out T0 + 67 days
        id = _deposit(q);
        checkOut = q.checkOutUtc;
    }

    function _open(uint256 contested) internal {
        vm.prank(guest);
        escrow.openDispute(id, contested, keccak256("evidence"));
    }

    function _toDelivered() internal {
        vm.warp(uint256(checkOut) + 1 hours);
    }

    function _resolve(uint16 guestBps) internal {
        vm.prank(arb);
        escrow.resolve(id, guestBps, REASON);
    }

    // ================================================================== open (spec 7)

    function test_open_settlesUncontestedAndCrystallisesYield() public {
        _deployMax();
        _gain(80 * USDC);
        _toDelivered();
        vm.recordLogs();
        _open(1_000 * USDC);
        (uint256 contested,, uint256 ownerPrin, uint256 fee, uint256 y, address feeRecipient) =
            _openedFromLogs();

        assertEq(contested, 1_000 * USDC);
        assertEq(fee, 230 * USDC, "5% of the uncontested 4,600");
        assertEq(ownerPrin, 4_370 * USDC);
        assertEq(feeRecipient, feeTo);
        assertApproxEqAbs(y, 80 * USDC, VAULT_ROUNDING);

        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.DISPUTED));
        assertEq(escrow.totalOpenPrincipal(), 0);
        assertEq(escrow.totalDisputed(), 1_000 * USDC);
        assertEq(escrow.ownerClaimable(), 4_370 * USDC);
        assertEq(escrow.feeClaimable(feeTo), 230 * USDC);
        assertEq(escrow.guestClaimable(guest), 0, "delivered stay: no refund on the uncontested part");
        assertEq(escrow.totalPendingYield(), y, "yield waits for resolution");

        Dispute memory d = escrow.getDispute(id);
        assertEq(d.contestedAtomic, 1_000 * USDC);
        assertEq(d.yieldAtomic, y);
        assertEq(d.openedAt, block.timestamp);
        assertEq(escrow.disputeDeadline(id), block.timestamp + 14 days);
        _assertBooksBalance();
    }

    function test_open_wholePrincipalContested() public {
        _toDelivered();
        _open(P);
        assertEq(escrow.ownerClaimable(), 0);
        assertEq(escrow.feeClaimable(feeTo), 0);
        assertEq(escrow.totalDisputed(), P);
        _assertBooksBalance();
    }

    // ------------------------------------------------------------------ open guards

    function test_open_guards() public {
        vm.prank(guest);
        vm.expectRevert(UnknownBooking.selector);
        escrow.openDispute(bytes32(uint256(1)), 1, 0);

        vm.prank(guest);
        vm.expectRevert(NotDelivered.selector); // before check-out
        escrow.openDispute(id, 1, 0);

        _toDelivered();
        vm.prank(owner);
        vm.expectRevert(NotGuest.selector); // D8: guest only
        escrow.openDispute(id, 1, 0);

        vm.startPrank(guest);
        vm.expectRevert(InvalidContested.selector);
        escrow.openDispute(id, 0, 0);
        vm.expectRevert(InvalidContested.selector);
        escrow.openDispute(id, P + 1, 0);
        vm.stopPrank();
    }

    function test_open_windowBoundaries() public {
        vm.warp(checkOut); // exactly at check-out: DELIVERED
        _open(1);
        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.DISPUTED));
    }

    function test_open_lastSecondThenTooLate() public {
        vm.warp(uint256(checkOut) + 72 hours - 1);
        uint256 snap = vm.snapshotState();
        _open(1);
        vm.revertToState(snap);
        vm.warp(uint256(checkOut) + 72 hours);
        vm.prank(guest);
        vm.expectRevert(DisputeTooLate.selector);
        escrow.openDispute(id, 1, 0);
    }

    function test_open_frozenCannotBeDisputed() public {
        _toDelivered();
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.prank(guest);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.openDispute(id, 1, 0);
    }

    function test_open_settledOrAlreadyDisputedReverts() public {
        _toDelivered();
        _open(10 * USDC);
        vm.prank(guest);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.openDispute(id, 1, 0);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.settle(id);
    }

    // ================================================================== resolve

    function test_resolve_partialGuestWin_noYieldToGuest() public {
        _deployMax();
        _gain(80 * USDC);
        _toDelivered();
        _open(1_000 * USDC);
        uint256 y = escrow.getDispute(id).yieldAtomic;
        vm.recordLogs();
        _resolve(5_000);
        (uint256 refund, uint256 ownerPrin, uint256 fee, uint256 ry, uint256 guestY, uint256 ownerY) =
            _resolvedFromLogs();
        assertEq(refund, 500 * USDC);
        assertEq(fee, 25 * USDC, "5% of the owner's retained 500");
        assertEq(ownerPrin, 475 * USDC);
        assertEq(ry, y);
        assertEq(guestY, 0, "D3: guest won, guest yield share goes to the owner");
        assertEq(ownerY, y);
        assertEq(escrow.guestClaimable(guest), 500 * USDC);
        assertEq(escrow.ownerClaimable(), 4_370 * USDC + 475 * USDC + y);
        assertEq(escrow.feeClaimable(feeTo), 255 * USDC);
        assertEq(escrow.totalDisputed(), 0);
        assertEq(escrow.totalPendingYield(), 0);
        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.SETTLED));
        _assertBooksBalance();
    }

    function test_resolve_ownerWins_yieldVests() public {
        _deployMax();
        _gain(80 * USDC);
        _toDelivered();
        _open(1_000 * USDC);
        uint256 y = escrow.getDispute(id).yieldAtomic;
        _resolve(0);
        assertEq(escrow.guestClaimable(guest), y / 2, "vested: guestYieldBps 50%, rounded down");
        _assertBooksBalance();
    }

    function test_resolve_refundRoundsUp() public {
        _toDelivered();
        _open(3);
        _resolve(3_333); // 33.33% of 3 = 0.9999 -> 1
        assertEq(escrow.guestClaimable(guest), 1);
    }

    function test_resolve_guards() public {
        _toDelivered();
        vm.prank(arb);
        vm.expectRevert(NotDisputed.selector);
        escrow.resolve(id, 0, REASON);

        _open(100 * USDC);
        vm.prank(guest);
        vm.expectRevert(NotArbitrator.selector);
        escrow.resolve(id, 10_000, REASON);
        vm.prank(owner);
        vm.expectRevert(NotArbitrator.selector);
        escrow.resolve(id, 0, REASON);

        vm.startPrank(arb);
        vm.expectRevert(BpsOutOfRange.selector);
        escrow.resolve(id, 10_001, REASON);
        vm.expectRevert(InvalidReasonCode.selector);
        escrow.resolve(id, 0, uint8(DisputeReason.DEFAULT_TIMEOUT)); // reserved for resolveByDefault
        vm.expectRevert(InvalidReasonCode.selector);
        escrow.resolve(id, 0, 200);
        escrow.resolve(id, 0, uint8(DisputeReason.OTHER));
        vm.expectRevert(NotDisputed.selector); // twice
        escrow.resolve(id, 0, REASON);
        vm.stopPrank();
    }

    function test_resolve_frozenCannotBeResolved_thenCan() public {
        _toDelivered();
        _open(100 * USDC);
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.prank(arb);
        vm.expectRevert(NotDisputed.selector);
        escrow.resolve(id, 0, REASON);
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.DISPUTED));
        _resolve(10_000);
        assertEq(escrow.guestClaimable(guest), 100 * USDC);
    }

    // ================================================================== resolveByDefault

    function test_resolveByDefault_windowAndAnyCaller() public {
        _toDelivered();
        _open(100 * USDC);
        uint256 deadline = escrow.disputeDeadline(id);
        vm.warp(deadline - 1);
        vm.expectRevert(DisputeWindowOpen.selector);
        escrow.resolveByDefault(id);
        vm.warp(deadline);
        vm.recordLogs();
        vm.prank(makeAddr("anyone"));
        escrow.resolveByDefault(id);
        (uint16 guestBps, uint8 reason) = _resolvedBpsReason();
        assertEq(guestBps, 0);
        assertEq(reason, uint8(DisputeReason.DEFAULT_TIMEOUT));
        assertEq(escrow.guestClaimable(guest), 0);
        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.SETTLED));
        _assertBooksBalance();
    }

    function test_resolveByDefault_notDisputed() public {
        assertEq(escrow.disputeDeadline(id), 0, "no dispute, no deadline");
        vm.expectRevert(NotDisputed.selector);
        escrow.resolveByDefault(id);
    }

    /// Frozen time extends the dispute deadline (ADR 0011): the window cannot lapse while the
    /// arbitrator is blocked by a freeze.
    function test_freezeExtendsDisputeDeadline() public {
        _toDelivered();
        _open(100 * USDC);
        uint256 openedAt = block.timestamp;
        vm.warp(openedAt + 3 days);
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.warp(openedAt + 20 days); // frozen for 17 days, past the unextended deadline
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        assertEq(escrow.disputeDeadline(id), openedAt + 14 days + 17 days);
        vm.expectRevert(DisputeWindowOpen.selector);
        escrow.resolveByDefault(id); // the owner cannot win by default right after unfreezing
        _resolve(10_000); // the arbitrator still gets the time it was denied
        assertEq(escrow.guestClaimable(guest), 100 * USDC);
    }

    /// A freeze before the dispute does not count; only freezes after it opens extend the deadline.
    function test_freezeBeforeOpenDoesNotExtend() public {
        vm.prank(guardian);
        escrow.freezeBooking(id);
        vm.warp(block.timestamp + 5 days);
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
        _toDelivered();
        vm.expectRevert(NotDelivered.selector); // the booking's clock is 5 days behind (ADR 0015 §1)
        vm.prank(guest);
        escrow.openDispute(id, 1, keccak256("e"));
        vm.warp(block.timestamp + 5 days);
        _open(1);
        assertEq(escrow.disputeDeadline(id), block.timestamp + 14 days, "the earlier freeze adds nothing after opening");
    }

    // ================================================================== brief test 1: conservation

    function testFuzz_conservationAcrossSplit(uint256 contested, uint16 guestBps, uint256 gainAmt) public {
        contested = bound(contested, 1, P);
        guestBps = uint16(bound(guestBps, 0, 10_000));
        gainAmt = bound(gainAmt, 0, 500 * USDC);
        _deployMax();
        _gain(gainAmt);
        _toDelivered();
        vm.recordLogs();
        _open(contested);
        Split memory f;
        (,, f.ownerU, f.feeU, f.y,) = _openedFromLogs();
        vm.recordLogs();
        _resolve(guestBps);
        (f.refund, f.ownerC, f.feeC, f.ry, f.guestY, f.ownerY) = _resolvedFromLogs();
        _checkSplit(f, contested, guestBps);
    }

    /// Figures from the two settlements of one disputed booking.
    struct Split {
        uint256 ownerU;
        uint256 feeU;
        uint256 y;
        uint256 refund;
        uint256 ownerC;
        uint256 feeC;
        uint256 ry;
        uint256 guestY;
        uint256 ownerY;
    }

    function _checkSplit(Split memory f, uint256 contested, uint16 guestBps) internal view {
        assertEq(f.refund + f.ownerU + f.ownerC + f.feeU + f.feeC, P, "refund + ownerPrin + fee == principal");
        assertEq(f.ry, f.y);
        assertEq(f.guestY + f.ownerY, f.y, "guestY + ownerY == y");
        assertLe(f.feeU, P - contested, "fee <= retained (uncontested)");
        assertLe(f.feeC, contested - f.refund, "fee <= retained (contested)");
        assertEq(f.refund, (contested * guestBps + 9_999) / 10_000, "guest refund rounds up");
        if (guestBps != 0) assertEq(f.guestY, 0, "D3");
        _assertBooksBalance();
    }

    // ================================================================== brief test 2: blast radius

    /// A compromised arbitrator, acting at random, can move only the contested amounts (and their
    /// crystallised yield) of bookings that snapshotted it, and only to that booking's guest, the owner
    /// bucket and the fee recipient. Bookings snapshotting another arbitrator, undisputed bookings and
    /// already-settled uncontested parts are untouched.
    function testFuzz_arbitratorBlastRadius(uint256[4] memory contestedSeed, uint256[12] memory actions) public {
        _blastSetup(contestedSeed);
        _blastSnapshot();
        for (uint256 k; k < actions.length; ++k) {
            _blastAct(actions[k]);
        }
        _blastCheck();
    }

    // blast-radius state (kept in storage so the unoptimised coverage build stays within stack limits)
    address[5] internal bg;
    bytes32[5] internal bids;
    uint256[5] internal bGuestBefore;
    uint256 internal bTotalBefore;
    uint256 internal bOwnerBefore;
    uint256 internal bFeeBefore;

    function _blastSetup(uint256[4] memory contestedSeed) internal {
        bg[0] = guest; // booking `id` from setUp, arbitrator A (= arb)
        bids[0] = id;
        for (uint256 i = 1; i < 5; ++i) {
            bg[i] = makeAddr(string.concat("bg", vm.toString(i)));
        }
        bids[1] = _deposit(_quoteFor(bg[1], uint40(T0 + 60 days), uint40(T0 + 67 days), 3_000 * USDC)); // A
        bids[4] = _deposit(_quoteFor(bg[4], uint40(T0 + 60 days), uint40(T0 + 67 days), 2_000 * USDC)); // A, undisputed
        vm.prank(admin);
        escrow.proposeArbitrator(makeAddr("arbB"));
        vm.warp(block.timestamp + 7 days);
        bids[2] = _deposit(_quoteFor(bg[2], uint40(T0 + 60 days), uint40(T0 + 67 days), 4_000 * USDC)); // B
        bids[3] = _deposit(_quoteFor(bg[3], uint40(T0 + 60 days), uint40(T0 + 67 days), 1_000 * USDC)); // B
        _deployMax();
        _gain(300 * USDC);
        _toDelivered();
        for (uint256 i; i < 4; ++i) {
            uint256 c = bound(contestedSeed[i], 1, escrow.getBooking(bids[i]).principalAtomic);
            vm.prank(bg[i]);
            escrow.openDispute(bids[i], c, 0);
        }
    }

    function _blastSnapshot() internal {
        bTotalBefore = escrow.totalClaimable();
        bOwnerBefore = escrow.ownerClaimable();
        bFeeBefore = escrow.feeClaimable(feeTo);
        for (uint256 i; i < 5; ++i) {
            bGuestBefore[i] = escrow.guestClaimable(bg[i]);
        }
    }

    /// Arbitrator A tries to resolve a random booking with random terms.
    function _blastAct(uint256 action) internal {
        uint256 target = action % 5;
        uint16 bps = uint16(bound(action >> 8, 0, 10_000));
        uint8 reason = uint8((action >> 40) % 7);
        vm.prank(arb);
        try escrow.resolve(bids[target], bps, reason) {
            assertTrue(target < 2, "A resolved a booking it was not snapshotted on");
        } catch {}
    }

    function _blastCheck() internal view {
        // Bookings snapshotting B remain disputed; the undisputed booking is untouched.
        assertEq(uint8(escrow.bookingState(bids[2])), uint8(BookingState.DISPUTED));
        assertEq(uint8(escrow.bookingState(bids[3])), uint8(BookingState.DISPUTED));
        assertEq(uint8(escrow.getBooking(bids[4]).state), uint8(BookingState.ESCROWED));
        for (uint256 i = 2; i < 5; ++i) {
            assertEq(escrow.guestClaimable(bg[i]), bGuestBefore[i], "other guests untouched");
        }
        // Everything A moved is bounded by A's bookings' contested amounts and their yield.
        uint256 resolved;
        for (uint256 i; i < 2; ++i) {
            if (escrow.bookingState(bids[i]) == BookingState.SETTLED) {
                Dispute memory d = escrow.getDispute(bids[i]);
                resolved += d.contestedAtomic + d.yieldAtomic;
                assertLe(escrow.guestClaimable(bg[i]) - bGuestBefore[i], d.contestedAtomic + d.yieldAtomic);
            }
        }
        uint256 moved = escrow.totalClaimable() - bTotalBefore;
        assertEq(moved, resolved, "claimable grew by exactly the resolved contested amounts and yield");
        uint256 toKnown = (escrow.ownerClaimable() - bOwnerBefore) + (escrow.feeClaimable(feeTo) - bFeeBefore)
            + (escrow.guestClaimable(bg[0]) - bGuestBefore[0]) + (escrow.guestClaimable(bg[1]) - bGuestBefore[1]);
        assertEq(toKnown, moved, "only to the booking's guest, the owner bucket and the fee recipient");
        assertEq(escrow.claimableOf(arb), 0, "the arbitrator receives nothing");
        _assertBooksBalance();
    }

    // ================================================================== brief test 3: snapshot

    function test_snapshot_laterArbitratorCannotResolve_oldCan() public {
        address newArb = makeAddr("newArb");
        vm.prank(admin);
        escrow.proposeArbitrator(newArb);
        vm.warp(block.timestamp + 7 days);
        assertEq(escrow.effectiveArbitrator(), newArb);
        _toDelivered();
        _open(100 * USDC);
        vm.prank(newArb);
        vm.expectRevert(NotArbitrator.selector);
        escrow.resolve(id, 10_000, REASON);
        _resolve(10_000); // the snapshotted (old) arbitrator
        assertEq(escrow.guestClaimable(guest), 100 * USDC);
    }

    // ================================================================== acceptance: lossDebt

    /// A dispute during lossDebt: yield is deferred and the guest's principal refund is paid.
    function test_disputeDuringLossDebt() public {
        address g2 = makeAddr("guest2");
        bytes32 id2 = _deposit(_quoteFor(g2, uint40(T0 + 200 days), uint40(T0 + 202 days), P));
        _deployMax();
        _gain(80 * USDC);
        escrow.observeShortfall();
        _loss(3_000 * USDC);
        escrow.observeShortfall();
        vm.warp(block.timestamp + 6 hours);
        escrow.recogniseLoss();
        assertGt(escrow.lossDebt(), 0);

        _toDelivered();
        _open(1_000 * USDC);
        uint256 y = escrow.getDispute(id).yieldAtomic;
        assertGt(y, 0);
        _resolve(0); // owner wins: yield vests, but is deferred while in debt
        assertEq(escrow.pendingGuestYield(guest), y / 2);
        assertEq(escrow.guestClaimable(guest), 0);
        _assertBooksBalance();

        // Same during debt with a guest win: principal refund is credited and paid now.
        vm.warp(T0 + 202 days + 1 hours);
        vm.prank(g2);
        escrow.openDispute(id2, 2_000 * USDC, 0);
        vm.prank(arb);
        escrow.resolve(id2, 10_000, REASON);
        assertEq(escrow.guestClaimable(g2), 2_000 * USDC);
        vm.prank(g2);
        assertEq(escrow.claim(), 2_000 * USDC, "guest principal paid during debt");
        _assertBooksBalance();
    }

    // ================================================================== log helpers

    function _openedFromLogs()
        internal
        returns (
            uint256 contested,
            bytes32 evidence,
            uint256 ownerPrin,
            uint256 fee,
            uint256 y,
            address feeRecipient
        )
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEscrowEvents.DisputeOpened.selector) {
                return abi.decode(logs[i].data, (uint256, bytes32, uint256, uint256, uint256, address));
            }
        }
        revert("no DisputeOpened");
    }

    function _resolvedFromLogs()
        internal
        returns (uint256 refund, uint256 ownerPrin, uint256 fee, uint256 y, uint256 guestY, uint256 ownerY)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEscrowEvents.DisputeResolved.selector) {
                (,, refund, ownerPrin, fee, y, guestY, ownerY,) = abi.decode(
                    logs[i].data,
                    (uint16, uint8, uint256, uint256, uint256, uint256, uint256, uint256, address)
                );
                return (refund, ownerPrin, fee, y, guestY, ownerY);
            }
        }
        revert("no DisputeResolved");
    }

    function _resolvedBpsReason() internal returns (uint16 guestBps, uint8 reason) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEscrowEvents.DisputeResolved.selector) {
                (guestBps, reason,,,,,,,) = abi.decode(
                    logs[i].data,
                    (uint16, uint8, uint256, uint256, uint256, uint256, uint256, uint256, address)
                );
                return (guestBps, reason);
            }
        }
        revert("no DisputeResolved");
    }
}
