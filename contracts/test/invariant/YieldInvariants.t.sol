// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {YieldTestBase} from "../utils/YieldTestBase.sol";
import {YieldHandler} from "./YieldHandler.sol";
import {console2} from "forge-std/console2.sol";

/// C2 invariants (brief tests 1 and 4, spec 10.4 INV-1/2/4, ADR 0009 properties) over random
/// sequences that include gains, losses, liquidity crunches and the full loss lifecycle.
/// forge-config: default.invariant.depth = 120
/// forge-config: ci.invariant.depth = 150
contract YieldInvariantsTest is YieldTestBase {
    YieldHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new YieldHandler(escrow, factory, usdc, vault, owner, guardian, rebalancer, signerKey);
        targetContract(address(handler));
    }

    /// The books identity (LedgerLib header), exactly.
    function invariant_booksBalance() public view {
        _assertBooksBalance();
    }

    /// Solvency counting unrecognised shortfall and lossDebt (ADR 0009); INV-2 when neither exists.
    function invariant_solvency() public view {
        uint256 obligations = escrow.totalOpenPrincipal() + escrow.totalDisputed() + escrow.totalClaimable()
            + escrow.totalPendingYield() + escrow.reserve() + escrow.yieldUnallocated();
        assertGe(escrow.totalAssets() + escrow.lossDebt() + escrow.shortfall(), obligations, "solvency");
        if (escrow.lossDebt() == 0 && escrow.shortfall() == 0) {
            assertGe(escrow.totalAssets(), obligations, "INV-2");
        }
    }

    /// INV-4 / brief test 1: yield credited plus still unallocated never exceeds realised gain.
    function invariant_yieldConservation() public view {
        assertLe(handler.ghostYieldCrystallised() + escrow.yieldUnallocated(), handler.ghostGain(), "INV-4");
    }

    /// Brief test 4: no guest credit is ever reduced (by a loss or anything but payment), refunds match
    /// the spec, D3 holds, and no owner or fee money leaves during an active loss.
    function invariant_guestPriority() public view {
        assertEq(handler.violations(), 0, handler.lastViolation());
        assertEq(handler.ownerPaidDuringLoss(), 0, "owner or fee paid during an active loss");
        for (uint256 i; i < handler.guestCount(); ++i) {
            address g = handler.guests(i);
            assertEq(
                escrow.guestClaimable(g) + escrow.pendingGuestYield(g),
                handler.ghostGuestCredited(g) - handler.ghostGuestPaid(g),
                "guest credit changed other than by payment"
            );
        }
    }

    /// Path coverage, logged once per run: shows the loss machinery is actually exercised.
    function afterInvariant() external view {
        console2.log("deployed", handler.nDeployed(), "recognised", handler.nRecognised());
        console2.log("debtStates", handler.nDebtStates(), "settled", handler.nSettled());
        console2.log("deferred", handler.nDeferred(), "ownerBlocked", handler.nOwnerBlocked());
        console2.log("reserveWithdrawn", handler.nReserveWithdrawn(), "gain", handler.ghostGain());
    }
}
