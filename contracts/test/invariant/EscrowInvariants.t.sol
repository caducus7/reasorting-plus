// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {EscrowHandler} from "./EscrowHandler.sol";
import {Quote, Cutoff, Booking, BookingState} from "../../src/interfaces/IEscrow.sol";

/// Brief tests 2, 3 and 4 as invariants over random action sequences.
contract EscrowInvariantsTest is EscrowTestBase {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new EscrowHandler(escrow, factory, usdc, owner, admin, guardian, signerKey);
        vm.prank(owner);
        escrow.setMinNightlyAtomic(1);
        targetContract(address(handler));
    }

    /// Test 2, solvency: assets cover open principal plus everything credited.
    function invariant_solvency() public view {
        assertGe(
            usdc.balanceOf(address(escrow)) + 0, // no vault in C1 flows
            escrow.totalOpenPrincipal() + escrow.totalClaimable(),
            "INV-1: assets < liabilities"
        );
    }

    /// Accounting is exact in C1 (no yield): assets == deposited - paid out.
    function invariant_conservation() public view {
        assertEq(usdc.balanceOf(address(escrow)), handler.ghostDeposited() - handler.ghostPaidOut());
        assertEq(escrow.totalOpenPrincipal(), handler.ghostOpenPrincipal(), "open principal drift");
        assertEq(
            escrow.totalOpenPrincipal() + escrow.totalClaimable(),
            handler.ghostDeposited() - handler.ghostPaidOut(),
            "liabilities != assets"
        );
    }

    /// Test 3: every guest credit equals the spec formula at the time of cancellation, and a guest's
    /// credit only ever falls by what the guest was paid.
    function invariant_guestNeverShortChanged() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        for (uint256 i; i < handler.guestCount(); ++i) {
            address g = handler.guests(i);
            assertEq(
                escrow.guestClaimable(g),
                handler.ghostGuestCredited(g) - handler.ghostGuestPaid(g),
                "guest credit reduced other than by payment"
            );
        }
    }

    /// Test 4: no call after deposit changes a stored booking term.
    function invariant_termsImmutable() public view {
        for (uint256 i; i < handler.idCount(); ++i) {
            bytes32 id = handler.ids(i);
            Quote memory q = handler.quoteOf(id);
            Booking memory b = escrow.getBooking(id);
            assertEq(b.guest, q.guest);
            assertEq(b.checkInUtc, q.checkInUtc);
            assertEq(b.checkOutUtc, q.checkOutUtc);
            assertEq(b.principalAtomic, q.priceAtomic);
            assertEq(b.feeBps, q.feeBps);
            assertEq(b.guestYieldBps, q.guestYieldBps);
            assertEq(b.finalBps, q.finalBps);
            assertEq(b.resourceId, q.resourceId);
            assertTrue(b.arbitrator != address(0));
            Cutoff[] memory cs = escrow.getCutoffs(id);
            assertEq(cs.length, q.cutoffs.length);
            for (uint256 j; j < cs.length; ++j) {
                assertEq(cs[j].cutoffUtc, q.cutoffs[j].cutoffUtc);
                assertEq(cs[j].refundBps, q.cutoffs[j].refundBps);
            }
        }
    }

    function invariant_bucketsSumToTotalClaimable() public view {
        uint256 sum = escrow.ownerClaimable() + escrow.feeClaimable(factory.feeRecipient());
        for (uint256 i; i < handler.guestCount(); ++i) {
            sum += escrow.guestClaimable(handler.guests(i));
        }
        assertEq(sum, escrow.totalClaimable());
    }
}
