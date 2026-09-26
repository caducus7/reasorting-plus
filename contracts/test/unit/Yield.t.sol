// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YieldTestBase} from "../utils/YieldTestBase.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {ZeroShareVault} from "../utils/Mocks.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrowEvents, Quote} from "../../src/interfaces/IEscrow.sol";

contract YieldTest is YieldTestBase {
    uint256 internal constant P = 5_600 * USDC;
    /// OpenZeppelin ERC-4626 rounds convertToAssets down and keeps a virtual share, so a gain or loss
    /// injected into the vault is realised by the escrow to within a few atomic units (ADR 0008).
    uint256 internal constant VAULT_ROUNDING = 3;

    /// Settles and returns the booking's crystallised yield `y` from BookingSettled.
    function _settleY(bytes32 id) internal returns (uint256 y) {
        vm.recordLogs();
        escrow.settle(id);
        y = _yFromLogs();
    }

    function _cancelY(bytes32 id, address g) internal returns (uint256 y) {
        vm.recordLogs();
        vm.prank(g);
        escrow.cancelByGuest(id);
        y = _yFromLogs();
    }

    function _yFromLogs() internal returns (uint256 y) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEscrowEvents.BookingSettled.selector) {
                (,,,,, y,,,) = abi.decode(
                    logs[i].data,
                    (uint8, uint256, uint256, uint256, uint256, uint256, uint256, uint256, address)
                );
                return y;
            }
        }
        revert("no BookingSettled");
    }

    function _q(address g, uint256 price) internal returns (Quote memory) {
        return _quoteFor(g, uint40(T0 + 60 days), uint40(T0 + 67 days), price);
    }

    // ================================================================== accumulator (spec 6.1)

    function test_gainIsDistributedAndVestsOnDeliveredStay() public {
        Quote memory q = _q(guest, P);
        bytes32 id = _deposit(q);
        _deployMax();
        _gain(100 * USDC);
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        uint256 y = _settleY(id);
        assertApproxEqAbs(y, 100 * USDC, VAULT_ROUNDING, "booking gets the whole gain");
        assertEq(escrow.guestClaimable(guest), y / 2, "guest 50%, rounded down");
        assertEq(escrow.ownerClaimable(), 5_320 * USDC + (y - y / 2), "owner takes the remainder");
        _assertBooksBalance();
    }

    /// D3: guest yield goes to the owner on cancellation.
    function test_cancellationYieldGoesToOwner() public {
        bytes32 id = _deposit(_q(guest, P));
        _deployMax();
        _gain(80 * USDC);
        uint256 y = _cancelY(id, guest);
        assertGt(y, 0);
        assertEq(escrow.guestClaimable(guest), P, "full refund, no yield");
        assertEq(escrow.ownerClaimable(), y);
        _assertBooksBalance();
    }

    /// Brief test 2: equal principal over the same interval, equal yield within 1 unit per accrual.
    function testFuzz_fairness(uint256 gain1, uint256 gain2) public {
        gain1 = bound(gain1, 1, 1_000 * USDC);
        gain2 = bound(gain2, 1, 1_000 * USDC);
        address g2 = makeAddr("guest2");
        Quote memory q1 = _q(guest, P);
        Quote memory q2 = _q(g2, P);
        bytes32 id1 = _deposit(q1);
        bytes32 id2 = _deposit(q2);
        _deployMax();
        _gain(gain1);
        escrow.observeShortfall(); // accrual 1
        _gain(gain2);
        vm.warp(uint256(q1.checkOutUtc) + 72 hours);
        uint256 y1 = _settleY(id1); // accrual 2 happens here
        uint256 y2 = _settleY(id2);
        assertApproxEqAbs(y1, y2, 2, "equal principal, equal yield");
        assertLe(y1 + y2, gain1 + gain2, "never more than realised");
        _assertBooksBalance();
    }

    /// Pro rata by principal.
    function test_proRataByPrincipal() public {
        address g2 = makeAddr("guest2");
        Quote memory q1 = _q(guest, 1_000 * USDC);
        Quote memory q2 = _q(g2, 3_000 * USDC);
        bytes32 id1 = _deposit(q1);
        bytes32 id2 = _deposit(q2);
        _deployMax();
        _gain(400 * USDC);
        vm.warp(uint256(q1.checkOutUtc) + 72 hours);
        assertApproxEqAbs(_settleY(id1), 100 * USDC, VAULT_ROUNDING);
        assertApproxEqAbs(_settleY(id2), 300 * USDC, VAULT_ROUNDING);
    }

    /// Brief test 3: a booking deposited after a gain receives none of it.
    function test_noRetroactiveYield() public {
        address g2 = makeAddr("guest2");
        Quote memory q1 = _q(guest, P);
        bytes32 id1 = _deposit(q1);
        _deployMax();
        _gain(100 * USDC); // earned while only booking 1 is open
        Quote memory q2 = _q(g2, P);
        bytes32 id2 = _deposit(q2); // deposit accrues first
        vm.warp(uint256(q1.checkOutUtc) + 72 hours);
        assertEq(_settleY(id2), 0, "late booking gets nothing");
        assertApproxEqAbs(_settleY(id1), 100 * USDC, VAULT_ROUNDING);
    }

    function test_gainWithNoOpenPrincipalGoesToReserve() public {
        _gain(0); // no-op
        usdc.mint(address(escrow), 25 * USDC); // e.g. a donation with nothing open
        vm.expectEmit(address(escrow));
        emit YieldAccrued(25 * USDC, 25 * USDC, 0);
        escrow.observeShortfall();
        assertEq(escrow.reserve(), 25 * USDC);
        _assertBooksBalance();
    }

    /// Acceptance: 1 atomic unit over 10M USDC neither overflows nor vanishes: it is either paid as
    /// yield or accounted as unallocated dust.
    function test_precision_oneUnitOverTenMillion() public {
        vm.prank(owner);
        escrow.setMaxOpenPrincipal(20_000_000 * USDC);
        address g2 = makeAddr("guest2");
        address g3 = makeAddr("guest3");
        Quote memory q1 = _quoteFor(guest, uint40(T0 + 60 days), uint40(T0 + 62 days), 3_333_333_333_333);
        Quote memory q2 = _quoteFor(g2, uint40(T0 + 60 days), uint40(T0 + 62 days), 3_333_333_333_333);
        Quote memory q3 = _quoteFor(g3, uint40(T0 + 60 days), uint40(T0 + 62 days), 3_333_333_333_334);
        bytes32 id1 = _deposit(q1);
        bytes32 id2 = _deposit(q2);
        bytes32 id3 = _deposit(q3);
        assertEq(escrow.totalOpenPrincipal(), 10_000_000 * USDC);
        usdc.mint(address(escrow), 1);
        escrow.observeShortfall();
        assertEq(escrow.accYieldPerUnit(), 1e18 / 1e13, "1e5 per unit: no truncation to zero");
        assertEq(escrow.yieldUnallocated(), 1);
        vm.warp(uint256(q1.checkOutUtc) + 72 hours);
        uint256 paid = _settleY(id1) + _settleY(id2) + _settleY(id3);
        assertEq(paid + escrow.yieldUnallocated(), 1, "paid + dust == the gain");
        _assertBooksBalance();
    }

    // ================================================================== loss window (ADR 0009)

    /// Acceptance: a dip shorter than the window never becomes lossDebt, and its recovery is not yield.
    function test_transientDip_noDebt_noPhantomYield() public {
        Quote memory q = _q(guest, P);
        bytes32 id = _deposit(q);
        _deployMax();
        _loss(500 * USDC);
        vm.expectEmit(address(escrow));
        emit ShortfallObserved(500 * USDC);
        escrow.observeShortfall();
        assertEq(escrow.shortfall(), 500 * USDC);
        vm.warp(block.timestamp + 6 hours - 1);
        vm.expectRevert(LossWindowOpen.selector);
        escrow.recogniseLoss();
        _gain(500 * USDC); // recovery inside the window
        vm.expectEmit(address(escrow));
        emit ShortfallCleared();
        escrow.observeShortfall();
        assertEq(escrow.shortfallSince(), 0);
        assertEq(escrow.lossDebt(), 0);
        vm.expectRevert(NoLossToRecognise.selector);
        escrow.recogniseLoss();
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        assertEq(_settleY(id), 0, "recovery was not paid out as yield");
        _assertBooksBalance();
    }

    function test_subThresholdDipIgnored() public {
        _deposit(_q(guest, P));
        _deployMax();
        _loss(1 * USDC - 1);
        escrow.observeShortfall();
        assertEq(escrow.shortfallSince(), 0, "below MIN_LOSS_ATOMIC");
        assertEq(escrow.shortfall(), 1 * USDC - 1);
        vm.expectRevert(NoLossToRecognise.selector);
        escrow.recogniseLoss();
        _loss(1);
        escrow.observeShortfall();
        assertEq(escrow.shortfallSince(), block.timestamp, "at threshold: observed");
    }

    /// Finding 2: owner and fee claims are blocked during the window; guests are paid.
    function test_ownerBlockedDuringWindow_guestPaid() public {
        Quote memory q1 = _q(guest, P);
        bytes32 id1 = _deposit(q1);
        address g2 = makeAddr("guest2");
        // Check-in far enough out that cancelling at settlement time is still a 100% refund.
        bytes32 id2 = _deposit(_quoteFor(g2, uint40(T0 + 120 days), uint40(T0 + 122 days), 1_000 * USDC));
        vm.warp(uint256(q1.checkOutUtc) + 72 hours);
        escrow.settle(id1); // owner 5,320, fee 280
        _deployMax();
        _loss(600 * USDC);
        vm.prank(payout);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.claim();
        vm.prank(feeTo);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.claim();
        vm.prank(g2);
        escrow.cancelByGuest(id2);
        vm.prank(g2);
        assertEq(escrow.claim(), 1_000 * USDC, "guest paid during the window");
        _gain(600 * USDC); // recovers: owner unblocked
        vm.prank(payout);
        assertEq(escrow.claim(), 5_320 * USDC);
    }

    /// Absorption order: reserve, owner bucket, owner deferred yield, then lossDebt.
    function test_recogniseLoss_absorptionOrder() public {
        Quote memory q1 = _q(guest, P);
        bytes32 id1 = _deposit(q1);
        _deposit(_quoteFor(makeAddr("guest2"), uint40(T0 + 90 days), uint40(T0 + 92 days), P));
        vm.warp(uint256(q1.checkOutUtc) + 72 hours);
        escrow.settle(id1); // owner bucket 5,320
        _fundReserve(100 * USDC);
        _deployMax();
        _loss(6_000 * USDC);
        escrow.observeShortfall();
        vm.warp(block.timestamp + 6 hours);
        vm.expectEmit(address(escrow));
        emit LossRecognised(6_000 * USDC, 100 * USDC, 5_320 * USDC, 580 * USDC);
        escrow.recogniseLoss();
        assertEq(escrow.reserve(), 0);
        assertEq(escrow.ownerClaimable(), 0);
        assertEq(escrow.lossDebt(), 580 * USDC);
        assertEq(escrow.guestClaimable(guest), 0, "no guest credit is touched");
        _assertBooksBalance();
    }

    // ================================================================== lossDebt (spec 6.4)

    function _intoDebt() internal returns (Quote memory q, bytes32 id) {
        q = _q(guest, P);
        id = _deposit(q);
        _deployMax(); // 5,040 deployed, 560 idle
        _gain(40 * USDC);
        escrow.observeShortfall(); // 40 distributed to the booking
        _loss(1_000 * USDC);
        escrow.observeShortfall();
        vm.warp(block.timestamp + 6 hours);
        escrow.recogniseLoss(); // nothing to absorb: all to debt
        assertApproxEqAbs(escrow.lossDebt(), 1_000 * USDC, VAULT_ROUNDING);
    }

    function test_whileDebt_depositsOwnerFeeAndDeployRevert() public {
        _intoDebt();
        Quote memory q2 = _quoteFor(
            makeAddr("g2"), uint40(block.timestamp + 30 days), uint40(block.timestamp + 32 days), 1_000 * USDC
        );
        _fund(q2.guest, q2.priceAtomic);
        bytes memory sig = _sign(q2);
        vm.prank(q2.guest);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.deposit(q2, sig);
        vm.prank(rebalancer);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.deploy(1);
    }

    /// Guest principal is paid from idle, then the vault, while in debt (spec 6.4).
    function test_whileDebt_guestClaimsFromIdleThenVault() public {
        (, bytes32 id) = _intoDebt();
        vm.prank(guest);
        escrow.cancelByGuest(id); // 100% refund of 5,600
        uint256 idle = usdc.balanceOf(address(escrow));
        vm.prank(guest);
        uint256 paid = escrow.claim();
        assertGt(paid, idle, "pulled from the vault beyond idle");
        assertApproxEqAbs(paid, 4_640 * USDC, VAULT_ROUNDING, "all that is left: 5,640 - 1,000");
        assertEq(escrow.guestClaimable(guest), P - paid, "rest stays claimable");
        _assertBooksBalance();
    }

    /// Settlement yield is deferred while in debt and released once it clears.
    function test_whileDebt_yieldDeferredThenReleased() public {
        (Quote memory q, bytes32 id) = _intoDebt();
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        vm.recordLogs();
        escrow.settle(id);
        uint256 y = _yFromLogs();
        assertApproxEqAbs(y, 40 * USDC, VAULT_ROUNDING);
        assertEq(escrow.pendingGuestYield(guest), y / 2);
        assertEq(escrow.pendingOwnerYield(), y - y / 2);
        assertEq(escrow.totalPendingYield(), y);
        assertEq(escrow.pendingYieldOf(guest), y / 2);
        vm.prank(guest);
        assertEq(escrow.claim(), 0, "guest has only deferred yield: nothing to pay yet");

        // Owner clears the debt.
        uint256 debt = escrow.lossDebt();
        usdc.mint(owner, 1_000 * USDC);
        vm.startPrank(owner);
        usdc.approve(address(escrow), 1_000 * USDC);
        escrow.topUpLoss(5_000 * USDC); // capped at the debt
        vm.stopPrank();
        assertEq(escrow.lossDebt(), 0);
        assertEq(usdc.balanceOf(owner), 1_000 * USDC - debt, "took exactly the debt");

        vm.expectEmit(address(escrow));
        emit PendingYieldReleased(guest, y / 2);
        vm.prank(guest);
        assertEq(escrow.claim(), y / 2);
        vm.prank(payout);
        assertEq(escrow.claim(), 5_320 * USDC + (y - y / 2));
        _assertBooksBalance();
    }

    /// Brief test 5: loss, lossDebt, partial gain repayment, top-up, normal distribution resumes.
    function test_lossRoundTrip() public {
        (Quote memory q,) = _intoDebt();
        _assertBooksBalance();

        uint256 unallocatedBefore = escrow.yieldUnallocated();
        uint256 debtBefore = escrow.lossDebt();
        _gain(300 * USDC);
        escrow.observeShortfall();
        uint256 debt = escrow.lossDebt();
        assertApproxEqAbs(debtBefore - debt, 300 * USDC, VAULT_ROUNDING, "gain repays debt");
        assertEq(escrow.yieldUnallocated(), unallocatedBefore, "repayment is not yield");
        _assertBooksBalance();

        usdc.mint(owner, debt);
        vm.startPrank(owner);
        usdc.approve(address(escrow), debt);
        vm.expectEmit(address(escrow));
        emit LossToppedUp(debt, 0);
        escrow.topUpLoss(debt);
        vm.stopPrank();
        _assertBooksBalance();

        _gain(60 * USDC); // normal distribution resumes
        escrow.observeShortfall();
        assertApproxEqAbs(escrow.yieldUnallocated(), unallocatedBefore + 60 * USDC, VAULT_ROUNDING);
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        escrow.settle(escrow.hashQuote(q));
        _assertBooksBalance();

        // Everything reconciles: every creditor can be paid in full.
        vm.prank(guest);
        escrow.claim();
        vm.prank(payout);
        escrow.claim();
        vm.prank(feeTo);
        escrow.claim();
        assertEq(escrow.totalClaimable(), 0);
        assertLe(escrow.yieldUnallocated(), 2, "only rounding dust left");
        assertGe(escrow.totalAssets() + 2, escrow.yieldUnallocated(), "dust is backed");
        _assertBooksBalance();
    }

    function test_topUp_guards() public {
        vm.prank(owner);
        vm.expectRevert(NoLossDebt.selector);
        escrow.topUpLoss(1);
        _intoDebt();
        vm.prank(owner);
        vm.expectRevert(ZeroAmount.selector);
        escrow.topUpLoss(0);
        vm.prank(guest);
        vm.expectRevert(); // OwnableUnauthorizedAccount
        escrow.topUpLoss(1);
    }

    function test_recogniseLoss_nothingObserved() public {
        vm.expectRevert(NoLossToRecognise.selector);
        escrow.recogniseLoss();
    }

    // ================================================================== deploy caps (spec 6.3)

    function test_deploy_eachCapHasItsOwnError() public {
        _deposit(_q(guest, P)); // liabilities 5,600
        vm.prank(guest);
        vm.expectRevert(NotRebalancer.selector);
        escrow.deploy(1);
        vm.startPrank(rebalancer);
        vm.expectRevert(ZeroAmount.selector);
        escrow.deploy(0);
        vm.expectRevert(BufferBreached.selector);
        escrow.deploy(5_040 * USDC + 1); // idle would drop below 560
        vm.expectRevert(BufferBreached.selector);
        escrow.deploy(P + 1); // more than idle
        vm.stopPrank();

        vm.prank(owner);
        escrow.setMaxDeployBps(5_000);
        vm.prank(rebalancer);
        vm.expectRevert(DeployCapExceeded.selector);
        escrow.deploy(2_800 * USDC + 1);

        vm.expectEmit(address(escrow));
        emit Deployed(2_800 * USDC);
        vm.prank(rebalancer);
        escrow.deploy(2_800 * USDC);
        assertEq(vault.previewRedeem(vault.balanceOf(address(escrow))), 2_800 * USDC);
        _assertBooksBalance();
    }

    function test_deploy_blockedDuringShortfall() public {
        _deposit(_q(guest, P));
        _deploy(3_000 * USDC);
        _loss(10 * USDC);
        vm.prank(rebalancer);
        vm.expectRevert(ShortfallPending.selector);
        escrow.deploy(1 * USDC);
    }

    function test_redeem_allowedInDebt_andGuards() public {
        _intoDebt();
        vm.expectEmit(address(escrow));
        emit Redeemed(1_000 * USDC);
        vm.prank(rebalancer);
        escrow.redeem(1_000 * USDC);
        vm.prank(rebalancer);
        vm.expectRevert(ZeroAmount.selector);
        escrow.redeem(0);
        vm.prank(guest);
        vm.expectRevert(NotRebalancer.selector);
        escrow.redeem(1);
        vm.prank(rebalancer);
        vm.expectRevert(); // ERC4626ExceededMaxWithdraw
        escrow.redeem(100_000 * USDC);
        _assertBooksBalance();
    }

    function test_deploy_revertsIfVaultMintsNoShares() public {
        ZeroShareVault zv = new ZeroShareVault(IERC20(address(usdc)));
        vm.prank(admin);
        factory.setDefaultVault(address(zv));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
        _deposit(_q(guest, P));
        vm.prank(rebalancer);
        vm.expectRevert(VaultMintedNoShares.selector);
        escrow.deploy(1_000 * USDC);
        assertEq(usdc.balanceOf(address(escrow)), P, "nothing left the escrow");
    }

    function test_rebalancerUnset_cannotDeploy() public {
        vm.prank(owner);
        escrow.setRebalancer(address(0));
        vm.prank(address(0));
        vm.expectRevert(NotRebalancer.selector);
        escrow.deploy(1);
    }

    function test_noVault_deployAndRedeemRevert() public {
        vm.prank(admin);
        factory.setDefaultVault(address(0));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
        vm.startPrank(rebalancer);
        vm.expectRevert(NoVault.selector);
        escrow.deploy(1);
        vm.expectRevert(NoVault.selector);
        escrow.redeem(1);
        vm.stopPrank();
    }

    // ================================================================== reserve (spec 6.5)

    function _fundReserve(uint256 amount) internal {
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(escrow), amount);
        escrow.fundReserve(amount);
        vm.stopPrank();
    }

    function test_reserve_fundProposeConfirm_paysPayout() public {
        usdc.mint(owner, 500 * USDC);
        vm.prank(owner);
        usdc.approve(address(escrow), 500 * USDC);
        vm.expectEmit(address(escrow));
        emit ReserveFunded(500 * USDC);
        vm.prank(owner);
        escrow.fundReserve(500 * USDC);
        assertEq(escrow.reserve(), 500 * USDC);
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(200 * USDC, 3);
        (uint256 amt, uint8 reason) = escrow.pendingReserveWithdrawal();
        assertEq(amt, 200 * USDC);
        assertEq(reason, 3);

        vm.prank(guardian);
        vm.expectRevert(ReserveProposalMismatch.selector);
        escrow.confirmReserveWithdrawal(300 * USDC, 3); // not what was proposed
        vm.prank(guardian);
        vm.expectRevert(ReserveProposalMismatch.selector);
        escrow.confirmReserveWithdrawal(200 * USDC, 4);
        vm.prank(owner);
        vm.expectRevert(NotGuardian.selector);
        escrow.confirmReserveWithdrawal(200 * USDC, 3);

        vm.expectEmit(address(escrow));
        emit ReserveWithdrawn(200 * USDC, 3);
        vm.prank(guardian);
        escrow.confirmReserveWithdrawal(200 * USDC, 3);
        assertEq(usdc.balanceOf(payout), 200 * USDC, "paid to the payout address");
        assertEq(escrow.reserve(), 300 * USDC);
        (amt,) = escrow.pendingReserveWithdrawal();
        assertEq(amt, 0, "proposal consumed");
        _assertBooksBalance();
    }

    function test_reserve_guards() public {
        vm.prank(owner);
        vm.expectRevert(ZeroAmount.selector);
        escrow.fundReserve(0);
        vm.prank(guest);
        vm.expectRevert();
        escrow.fundReserve(1);
        _fundReserve(100 * USDC);
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(0, 0); // cancel
        vm.prank(guardian);
        vm.expectRevert(ReserveProposalMismatch.selector);
        escrow.confirmReserveWithdrawal(0, 0);
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(101 * USDC, 1);
        vm.prank(guardian);
        vm.expectRevert(ReserveInsufficient.selector);
        escrow.confirmReserveWithdrawal(101 * USDC, 1);
    }

    function test_reserve_blockedDuringShortfallAndDebt() public {
        _fundReserve(100 * USDC);
        _deposit(_q(guest, P));
        _deployMax();
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(50 * USDC, 1);
        _loss(200 * USDC);
        vm.prank(guardian);
        vm.expectRevert(ShortfallPending.selector);
        escrow.confirmReserveWithdrawal(50 * USDC, 1);
        vm.warp(block.timestamp + 6 hours);
        escrow.observeShortfall();
        vm.warp(block.timestamp + 6 hours);
        escrow.recogniseLoss(); // reserve 100 absorbs, 100 to debt
        assertEq(escrow.lossDebt(), 100 * USDC);
        vm.prank(guardian);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.confirmReserveWithdrawal(50 * USDC, 1);
    }

    /// Reserve money deployed in an illiquid vault cannot be withdrawn; idle reserve can.
    function test_reserve_illiquid() public {
        _fundReserve(1_000 * USDC);
        bytes32 id = _deposit(_q(guest, P));
        _deployMax(); // 5,040 deployed; idle 1,560
        vault.setWithdrawLimit(0);
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(1_000 * USDC, 1);
        vm.prank(guardian);
        escrow.confirmReserveWithdrawal(1_000 * USDC, 1); // paid from idle
        _fundReserve(1_000 * USDC); // idle back to 1,560
        vm.prank(guest);
        escrow.cancelByGuest(id);
        vm.prank(guest);
        assertEq(escrow.claim(), 1_560 * USDC, "guest drains idle; vault illiquid");
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(1_000 * USDC, 1);
        vm.prank(guardian);
        vm.expectRevert(ReserveInsufficient.selector);
        escrow.confirmReserveWithdrawal(1_000 * USDC, 1);
        _assertBooksBalance();
    }
}
