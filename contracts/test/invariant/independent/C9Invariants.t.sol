// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {IEscrow} from "../../../src/interfaces/IEscrow.sol";
import {IEscrowViews, IFactoryAdmin} from "./C9Base.sol";
import {C9Handler} from "./handlers/C9Handler.sol";
import {C9Usdc} from "./mocks/C9Usdc.sol";
import {C9Vault} from "./mocks/C9Vault.sol";

/// @notice C9 independent invariant suite (briefs/C9-independent-invariants.md). Each invariant is
/// named after the brief's property number and the spec section it enforces.
contract C9IndependentInvariants is StdInvariant, Test {
    C9Handler internal h;
    IEscrow internal esc;
    IEscrowViews internal v;
    C9Usdc internal usdc;
    C9Vault internal vault;
    address internal escAddr;

    function setUp() public {
        h = new C9Handler();
        escAddr = h.escrowAddr();
        esc = IEscrow(escAddr);
        v = IEscrowViews(escAddr);
        usdc = C9Usdc(h.tokenAddr());
        vault = C9Vault(h.vaultAddr());

        h.ownerFundReserve(1e6); // operator funds the reserve floor before deploying (ADR 0013 §5)
        targetContract(address(h));
        bytes4[] memory s = new bytes4[](35);
        s[0] = C9Handler.guestDeposit.selector;
        s[1] = C9Handler.guestDepositB.selector;
        s[2] = C9Handler.guestDepositC.selector;
        s[3] = C9Handler.stashQuote.selector;
        s[4] = C9Handler.depositStashed.selector;
        s[5] = C9Handler.guestCancel.selector;
        s[6] = C9Handler.openDispute.selector;
        s[7] = C9Handler.claim.selector;
        s[8] = C9Handler.propertyCancel.selector;
        s[9] = C9Handler.settle.selector;
        s[10] = C9Handler.arbitratorResolve.selector;
        s[11] = C9Handler.resolveByDefault.selector;
        s[12] = C9Handler.guardianFreeze.selector;
        s[13] = C9Handler.unfreeze.selector;
        s[14] = C9Handler.guardianPause.selector;
        s[15] = C9Handler.ownerConfig.selector;
        s[16] = C9Handler.ownerFundReserve.selector;
        s[17] = C9Handler.ownerTopUp.selector;
        s[18] = C9Handler.ownerProposeReserveWithdrawal.selector;
        s[19] = C9Handler.guardianConfirmReserve.selector;
        s[20] = C9Handler.adminProposeFee.selector;
        s[21] = C9Handler.adminProposeArbitrator.selector;
        s[22] = C9Handler.adminProposeFeeRecipient.selector;
        s[23] = C9Handler.rebalancerDeploy.selector;
        s[24] = C9Handler.rebalancerRedeem.selector;
        s[25] = C9Handler.observeShortfall.selector;
        s[26] = C9Handler.recogniseLoss.selector;
        s[27] = C9Handler.warp.selector;
        s[28] = C9Handler.vaultGain.selector;
        s[29] = C9Handler.vaultLoss.selector;
        s[30] = C9Handler.vaultLimit.selector;
        s[31] = C9Handler.attackerDonate.selector;
        s[32] = C9Handler.toggleBlacklist.selector;
        s[33] = C9Handler.attackerProbe.selector;
        s[34] = C9Handler.claim.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: s}));
    }

    function _noViol(bytes32 k) internal view {
        assertEq(h.viol(k), 0, h.firstMsg(k));
    }

    function _assets() internal view returns (uint256) {
        return usdc.balanceOf(escAddr) + vault.previewRedeem(vault.balanceOf(escAddr));
    }

    // ------------------------------------------------------------------ property 1 (spec 10.4)

    /// INV-1 (hard solvency). Adjusted by the ADR 0009 loss window: an unrecognised shortfall and
    /// a booked lossDebt are the only permitted gaps. Without any injected vault loss it must hold
    /// as written.
    function invariant_P1_INV1_hardSolvency_spec10_4() public view {
        uint256 a = _assets();
        uint256 hard = v.totalOpenPrincipal() + v.totalDisputed() + v.totalClaimable();
        uint256 la = v.lastAssets();
        uint256 sf = la > a ? la - a : 0;
        assertGe(a + v.lossDebt() + sf, hard, "INV-1 (loss-adjusted) broken");
    }

    /// INV-1 exactly as written in spec 10.4, asserted while the escrow has never touched the vault
    /// and no loss was injected (ERC-4626 rounding is a loss the spec's INV-1 has no band for; see
    /// test_INV1_asWritten_breaksOnHonestDeployRounding in C9Adversarial.t.sol).
    function invariant_P1_INV1_asWritten_noVaultExposure_spec10_4() public view {
        if (h.lossInjected() || h.okCountOf("deploy") > 0) return;
        uint256 hard = v.totalOpenPrincipal() + v.totalDisputed() + v.totalClaimable();
        assertGe(_assets(), hard, "INV-1 as written broken without any vault exposure");
    }

    /// INV-2 (full solvency) with the same ADR 0009 adjustment; "unpaid accrued yield" is pending
    /// plus yield in the accumulator not yet crystallised (ADR 0010 yieldUnallocated).
    function invariant_P1_INV2_fullSolvency_spec10_4() public view {
        uint256 a = _assets();
        uint256 liab = v.totalOpenPrincipal() + v.totalDisputed() + v.totalPendingYield() + v.totalClaimable();
        uint256 la = v.lastAssets();
        uint256 sf = la > a ? la - a : 0;
        assertGe(a + v.lossDebt() + sf, liab + v.reserve() + v.yieldUnallocated(), "INV-2 (loss-adjusted) broken");
    }

    /// ADR 0010 section 2 books identity, on the contract's own getters.
    function invariant_P1_booksIdentity_ADR0010() public view {
        uint256 lhs = v.lastAssets() + v.lossDebt();
        uint256 rhs = v.totalOpenPrincipal() + v.totalDisputed() + v.totalClaimable() + v.totalPendingYield()
            + v.reserve() + v.yieldUnallocated();
        assertEq(lhs, rhs, "lastAssets + lossDebt != liabilities + reserve + unallocated");
    }

    // ------------------------------------------------------------------ property 2 (spec 4.4, 7)

    function invariant_P2_settlementEqualities_spec4_4() public view {
        _noViol(h.K_P2());
    }

    // ------------------------------------------------------------------ property 3 (spec 4.3, 4.4, 6.4)

    /// Guest refund, principal and fee credits equal the spec formulas, and a guest's credit is never
    /// reduced: paid + still claimable == everything ever credited.
    function invariant_P3_creditsEqualSpecAndNeverReduced_spec4_4_6_4() public view {
        _noViol(h.K_P3());
        for (uint256 i; i < 4; i++) {
            address g = h.guestAt(i);
            (uint256 cl, uint256 pend,) = h.ghostBuckets(g);
            assertEq(v.guestClaimable(g), cl, "guestClaimable != spec ghost");
            assertEq(v.pendingGuestYield(g), pend, "pendingGuestYield != spec ghost");
            assertEq(usdc.receivedFromEscrow(g) + v.guestClaimable(g), h.cumG(g), "guest credit reduced");
        }
        (,, address f1, address f2,,) = h.roles();
        (,, uint256 fc1) = h.ghostBuckets(f1);
        (,, uint256 fc2) = h.ghostBuckets(f2);
        assertEq(v.feeClaimable(f1), fc1, "feeClaimable(r1) != spec ghost");
        assertEq(v.feeClaimable(f2), fc2, "feeClaimable(r2) != spec ghost");
        assertEq(usdc.receivedFromEscrow(f1) + v.feeClaimable(f1), h.cumFee(f1), "fee credit reduced (r1)");
        assertEq(usdc.receivedFromEscrow(f2) + v.feeClaimable(f2), h.cumFee(f2), "fee credit reduced (r2)");
        assertEq(v.ownerClaimable(), h.ledger().ownerCl, "ownerClaimable != spec ghost");
    }

    // ------------------------------------------------------------------ property 4 (spec 6.1, INV-4)

    function invariant_P4_yieldConservation_INV4_spec6_1() public view {
        _noViol(h.K_P4());
        C9Handler.Ledger memory l = h.ledger();
        assertEq(v.accYieldPerUnit(), l.acc, "accYieldPerUnit != spec accumulator");
        assertEq(v.yieldUnallocated(), l.unalloc, "yieldUnallocated != spec ghost");
        assertEq(v.pendingOwnerYield(), l.pendO, "pendingOwnerYield != spec ghost");
        (, uint256 pend,) = h.totalsModel();
        assertEq(v.totalPendingYield(), pend, "totalPendingYield != spec ghost");
        assertEq(h.evGain(), l.gainDist, "YieldAccrued gains != spec accrue()");
        // INV-4: yield distributed (to bookings or reserve) never exceeds the gain actually realised
        assertLe(l.gainDist, h.extGain(), "INV-4: distributed more yield than was realised");
    }

    // ------------------------------------------------------------------ ledger model (spec 6.1-6.5)

    function invariant_ledgerTotalsMatchSpecModel_spec6_1_6_4() public view {
        C9Handler.Ledger memory l = h.ledger();
        assertEq(v.lastAssets(), l.lastAssets, "lastAssets != spec ghost");
        assertEq(v.lossDebt(), l.lossDebt, "lossDebt != spec ghost");
        assertEq(v.reserve(), l.reserve, "reserve != spec ghost");
        assertEq(v.totalOpenPrincipal(), l.open, "totalOpenPrincipal != spec ghost");
        assertEq(v.totalDisputed(), l.disputed, "totalDisputed != spec ghost");
        (uint256 cl,,) = h.totalsModel();
        assertEq(v.totalClaimable(), cl, "totalClaimable != spec ghost");
    }

    // ------------------------------------------------------------------ property 5 (spec 2, 4.2)

    function invariant_P5_termsImmutableAfterDeposit_spec4_2() public view {
        _noViol(h.K_P5());
        uint256 n = h.bookingCount();
        for (uint256 i; i < n; i++) {
            assertEq(h.termsMismatch(i), "", "stored booking term changed after deposit");
        }
    }

    // ------------------------------------------------------------------ property 6 (spec 3.3, rule 3)

    function invariant_P6_onlyEntitledRecipients_spec3_3() public view {
        assertEq(usdc.badEscrowOut(), 0, "escrow paid an address that is not guest/payout/fee recipient/vault");
        assertEq(usdc.badVaultIn(), 0, "vault received USDC from someone other than the escrow");
        assertEq(usdc.badVaultOut(), 0, "vault paid someone other than the escrow");
        (address p1, address p2,,, address reb, address att) = h.roles();
        assertEq(usdc.receivedFromEscrow(reb), 0, "rebalancer received escrow funds");
        assertEq(usdc.receivedFromEscrow(att), 0, "attacker received escrow funds");
        assertEq(
            usdc.receivedFromEscrow(p1) + usdc.receivedFromEscrow(p2),
            h.cumOwnerPaid() + h.cumReservePaid(),
            "payout received more than owner claims + reserve withdrawals"
        );
    }

    // ------------------------------------------------------------------ properties 7-10

    function invariant_P7_lossDebtGates_spec6_4() public view {
        _noViol(h.K_P7());
    }

    function invariant_P8_quoteFeeAndSplitMustEqualLive_spec4_2() public view {
        _noViol(h.K_P8());
    }

    function invariant_P9_compromisedArbitratorBounded_spec7() public view {
        _noViol(h.K_P9());
    }

    function invariant_P10_compromisedRebalancerBounded_spec6_3() public view {
        _noViol(h.K_P10());
    }

    // ------------------------------------------------------------------ state machine, roles, timelocks

    /// Every call the spec forbids (role, state, time) reverted; bookingState, disputeDeadline and
    /// refundBpsNow agree with the spec's derivations (3.5, 4.3, 7, ADR 0011).
    function invariant_stateMachineAndRoles_spec3_3_3_5() public view {
        _noViol(h.K_AUTH());
        uint256 n = h.bookingCount();
        for (uint256 i; i < n; i++) {
            (bytes32 id, uint8 st) = h.ghostState(i);
            assertEq(uint8(esc.bookingState(id)), st, "bookingState != spec state");
            if (h.ghostDisputed(i)) assertEq(esc.disputeDeadline(id), h.ghostDeadline(i), "disputeDeadline");
            (bool live, uint16 bps) = h.ghostRefundBps(i);
            if (live) assertEq(esc.refundBpsNow(id), bps, "refundBpsNow != spec 4.3");
        }
    }

    function invariant_timelocksAndConfig_spec3_4() public view {
        assertEq(esc.effectiveFeeBps(), h.effFee(), "effectiveFeeBps != spec timelock");
        assertEq(esc.effectiveArbitrator(), h.effArb(), "effectiveArbitrator != spec timelock");
        assertEq(IFactoryAdmin(h.factoryAddr()).feeRecipient(), h.effRecip(), "feeRecipient != spec timelock");
        (uint16 gy, uint16 md, address payout, bool p) = h.ghostConfig();
        assertEq(v.guestYieldBps(), gy, "guestYieldBps");
        assertEq(v.maxDeployBps(), md, "maxDeployBps");
        assertEq(v.payoutAddress(), payout, "payoutAddress");
        assertEq(v.paused(), p, "paused");
    }

    /// A call the spec says must succeed did not revert, and claim() paid min(claimable, liquid).
    function invariant_validCallsSucceed_spec4_5() public view {
        _noViol(h.K_LIVE());
        _noViol(h.K_CLAIM());
    }

    /// Spec 6.1 ("accrue(): first line of every state-changing function"), CLAUDE.md rule 4.
    function invariant_accrueFirstInEveryStateChangingFunction_spec6_1() public view {
        _noViol(h.K_RULE4());
    }

    // ------------------------------------------------------------------ property 11 (spec 4.6, 7)

    /// At the end of every run: lift the liquidity limit and blacklist, unfreeze, warp past every
    /// GRACE and dispute deadline, recognise and top up any loss, then settle / resolveByDefault
    /// every booking and let everyone claim. Every booking must reach SETTLED and every credit
    /// must be paid in full.
    function afterInvariant() public {
        h.drain();
        _noViol(h.K_P11());
        _noViol(h.K_LIVE());
        _noViol(h.K_CLAIM());
        _noViol(h.K_AUTH());
        _noViol(h.K_P2());
        _noViol(h.K_P7());
        assertEq(v.totalOpenPrincipal(), 0, "open principal left after drain");
        assertEq(v.totalDisputed(), 0, "disputed left after drain");
        for (uint256 i; i < 4; i++) {
            address g = h.guestAt(i);
            assertEq(v.guestClaimable(g), 0, "guest not paid in full after drain");
            assertEq(v.pendingGuestYield(g), 0, "guest pending yield not released after drain");
            assertEq(usdc.receivedFromEscrow(g), h.cumG(g), "guest received != credited");
        }
        (,, address f1, address f2,,) = h.roles();
        // Spec 2 / 6.4: the owner absorbs losses. ADR 0010 section 4: a shortfall under MIN_LOSS is never
        // booked and does not gate owner claims, so whoever claims last (the drain pays guests first,
        // then fee recipients, then the owner) may be short by at most that unbooked shortfall.
        uint256 a = _assets();
        uint256 la = v.lastAssets();
        uint256 sf = la > a ? la - a : 0;
        assertLt(sf, 1e6, "a shortfall >= MIN_LOSS survived the drain");
        uint256 unpaid = v.feeClaimable(f1) + v.feeClaimable(f2) + v.ownerClaimable();
        assertLe(unpaid, sf, "fee/owner unpaid beyond the unbooked sub-threshold shortfall");
        assertEq(v.totalClaimable(), unpaid, "guest claimable left after drain");
    }
}
