// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {YieldTestBase} from "../utils/YieldTestBase.sol";
import {Quote, BookingState} from "../../src/interfaces/IEscrow.sol";

/// @notice Proof-of-concept tests for review 0004 (docs/reviews/0004-contracts-spec-review.md).
/// Each test asserts the property a guest would expect. Against the current code each one FAILS
/// on purpose, to show the finding. None of them changes `src/`.
contract Review0004Test is YieldTestBase {
    // ------------------------------------------------------------------------------------------
    // R1: a guardian freeze does not stop the refund-policy clock. A booking frozen while the guest
    // is in the 100% tier comes back after the 30-day budget in the 0% tier, and the guest cannot
    // cancel while it is frozen. Spec 3.3: the guardian "cannot move any funds".

    function test_R1_freezeAcrossCutoffsCutsGuestRefund() public {
        Quote memory q = _quote(); // check-in T0+60d; 100% until T0+30d, 50% / 25% / then 0% from T0+53d
        bytes32 id = _deposit(q);

        // Day 29: the guest is in the 100% tier. The guardian freezes the booking.
        vm.warp(T0 + 29 days);
        assertEq(escrow.refundBpsNow(id), 10_000, "guest is in the 100% tier when frozen");
        vm.prank(guardian);
        escrow.freezeBooking(id);

        // The guest tries to cancel while frozen and cannot.
        vm.prank(guest);
        vm.expectRevert(BookingNotEscrowed.selector);
        escrow.cancelByGuest(id);

        // Budget used up: anyone unfreezes at day 59. The guest cancels immediately.
        vm.warp(T0 + 59 days);
        escrow.unfreezeBooking(id);
        vm.prank(guest);
        escrow.cancelByGuest(id);

        // Expected: the refund the guest was entitled to when the guardian froze the booking.
        // Actual: 0, because the policy clock ran through every cutoff while the booking was frozen.
        assertEq(escrow.guestClaimable(guest), q.priceAtomic, "R1: freeze moved the guest's refund to the owner");
    }

    /// Same mechanism at the other end of the stay (already raised as a spec concern in the C3
    /// handoff, repeated here so the fix is tested together): the freeze runs out GRACE, so the guest
    /// loses the right to open a dispute.
    function test_R1_freezeAcrossGraceRemovesDisputeRight() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);

        vm.warp(uint256(q.checkOutUtc) + 1 hours); // delivered, inside GRACE
        vm.prank(guardian);
        escrow.freezeBooking(id);

        vm.warp(uint256(q.checkOutUtc) + 1 hours + 30 days);
        escrow.unfreezeBooking(id);

        // Expected: the guest still has the GRACE time that was left when the booking was frozen.
        // Actual: reverts DisputeTooLate.
        vm.prank(guest);
        escrow.openDispute(id, q.priceAtomic, keccak256("evidence"));
        assertEq(uint8(escrow.bookingState(id)), uint8(BookingState.DISPUTED), "R1: dispute right lost to freeze");
    }

    // ------------------------------------------------------------------------------------------
    // R2: writeOffVault works on a healthy vault, takes effect at once, and only the owner or the
    // guardian can undo it. While it lasts, guest refunds are paid from idle only (10% buffer plus
    // reserve) and the rebalancer cannot redeem. Guest principal in a working vault is locked for
    // as long as the owner (or a guardian aligned with the owner) chooses.

    function test_R2_healthyVaultWriteOffLocksGuestRefund() public {
        Quote memory q = _quote();
        bytes32 id = _deposit(q);
        _deployMax(); // 90% of liabilities into the vault; the vault stays healthy throughout

        vm.prank(owner);
        escrow.writeOffVault();

        // The vault is fully liquid for the escrow's position.
        assertGe(vault.maxWithdraw(address(escrow)), q.priceAtomic * 9 / 10 - 2, "vault is healthy");

        // Nobody but the owner or guardian can recover, and the rebalancer cannot redeem.
        vm.prank(guest);
        vm.expectRevert(NotOwnerOrGuardian.selector);
        escrow.recoverVault();
        vm.prank(rebalancer);
        vm.expectRevert(VaultIsWrittenOff.selector);
        escrow.redeem(1 * USDC);

        // The guest cancels in the 100% tier and claims.
        vm.prank(guest);
        escrow.cancelByGuest(id);
        vm.prank(guest);
        uint256 paid = escrow.claim();

        // Expected: the full refund, because the vault can pay it.
        // Actual: only the idle buffer and reserve (561 USDC of 5,600).
        assertEq(paid, q.priceAtomic, "R2: healthy-vault write-off withholds the guest's refund");
    }
}
