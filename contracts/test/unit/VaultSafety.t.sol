// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YieldTestBase} from "../utils/YieldTestBase.sol";
import {MockVault} from "../utils/Mocks.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrowEvents, IEscrowErrors, Quote} from "../../src/interfaces/IEscrow.sol";
import {IEscrowFactory} from "../../src/interfaces/IEscrowFactory.sol";

/// C9 findings F1 to F5, fixed per docs/adr/0013 after checking audited prior art
/// (docs/reviews/0002-c9-findings-prior-art.md).
contract VaultSafetyTest is YieldTestBase {
    uint256 internal constant P = 5_600 * USDC;
    address internal attacker = makeAddr("attacker");

    function _q(address g, uint256 price) internal returns (Quote memory) {
        return _quoteFor(g, uint40(T0 + 60 days), uint40(T0 + 67 days), price);
    }

    function _escrowOn(MockVault v) internal {
        vm.prank(admin);
        factory.setDefaultVault(address(v));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP); // each approval is used by one createEscrow
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
        vault = v;
    }

    function _escrowValue() internal view returns (uint256) {
        return usdc.balanceOf(address(escrow)) + vault.previewRedeem(vault.balanceOf(address(escrow)));
    }

    // ================================================================== F2: inflation (ADR 0013 §1)

    function test_F2_factoryRejectsUnseededVault() public {
        MockVault v = new MockVault(IERC20(address(usdc)));
        vm.prank(admin);
        vm.expectRevert(IEscrowFactory.VaultNotSeeded.selector);
        factory.setDefaultVault(address(v));
        _seedVault(address(v), 1);
        vm.prank(admin);
        factory.setDefaultVault(address(v));
        assertEq(factory.defaultVault(), address(v));
    }

    /// C9's F2 scenario (1,000 USDC donated into an emptied vault, then deploy 1,999 USDC): deploy
    /// now refuses an unseeded vault, and nothing leaves the escrow.
    function test_F2_deployRefusesVaultWhoseSeedWasWithdrawn() public {
        MockVault v = new MockVault(IERC20(address(usdc)));
        address lp = makeAddr("withdrawableLp");
        usdc.mint(lp, 5 * USDC);
        vm.startPrank(lp);
        usdc.approve(address(v), 5 * USDC);
        v.deposit(5 * USDC, lp);
        vm.stopPrank();
        _escrowOn(v);
        _deposit(_q(guest, P));
        _fundReserveFloor();

        vm.startPrank(lp);
        v.redeem(v.balanceOf(lp), lp, lp); // the seed was not burned: vault is empty again
        vm.stopPrank();
        usdc.mint(attacker, 1_000 * USDC);
        vm.prank(attacker);
        usdc.transfer(address(v), 1_000 * USDC); // donation

        uint256 before = _escrowValue();
        vm.prank(rebalancer);
        vm.expectRevert(IEscrowErrors.VaultNotSeeded.selector);
        escrow.deploy(1_999 * USDC);
        assertEq(_escrowValue(), before, "no value moved");
    }

    /// With the seed and offset in place a donation costs the escrow at most deposit rounding, about
    /// two shares' worth, while the attacker's USDC is captured by the seed and virtual shares: the
    /// attack is possible but uneconomic by a factor of ~1e11 (OpenZeppelin ERC4626 CAUTION).
    function testFuzz_F2_donationIntoSeededVaultCostsTheEscrowNothing(uint256 donation, uint256 amount) public {
        donation = bound(donation, 1, 10_000_000 * USDC);
        _deposit(_q(guest, P));
        amount = bound(amount, 1 * USDC, P * 9 / 10);
        usdc.mint(attacker, donation);
        vm.prank(attacker);
        usdc.transfer(address(vault), donation);
        uint256 before = _escrowValue();
        _deploy(amount); // also funds the 1 USDC reserve floor
        uint256 maxLoss = 2 + 2 * donation / 1e12; // two shares at price (1 + donation) / (2e12 shares)
        assertGe(_escrowValue() + maxLoss, before + 1 * USDC, "deploy lost more than share rounding");
    }

    // ================================================================== F5: reserve floor (§5)

    function test_F5_deployRequiresReserveFloor() public {
        _deposit(_q(guest, P));
        vm.prank(rebalancer);
        vm.expectRevert(IEscrowErrors.ReserveBelowFloor.selector);
        escrow.deploy(1_000 * USDC);
        _fundReserveFloor();
        vm.prank(rebalancer);
        escrow.deploy(1_000 * USDC);
    }

    function test_F5_reserveCannotDropBelowFloorWhileExposed() public {
        Quote memory q = _q(guest, P);
        bytes32 id = _deposit(q);
        _fund(owner, 4 * USDC);
        vm.prank(owner);
        escrow.fundReserve(4 * USDC);
        _deploy(1_000 * USDC); // reserve already 4 USDC >= floor
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(4 * USDC, 1);
        vm.prank(guardian);
        vm.expectRevert(IEscrowErrors.ReserveBelowFloor.selector);
        escrow.confirmReserveWithdrawal(4 * USDC, 1);
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(3 * USDC, 1);
        vm.prank(guardian);
        escrow.confirmReserveWithdrawal(3 * USDC, 1);
        assertEq(escrow.reserve(), 1 * USDC);

        // Nothing owed to anyone else: the floor no longer applies.
        uint256 mw = vault.maxWithdraw(address(escrow));
        vm.prank(rebalancer);
        escrow.redeem(mw);
        _settleAfterStay(id, q);
        _claim(guest);
        _claim(payout);
        _claim(feeTo);
        uint256 all = escrow.reserve();
        vm.prank(owner);
        escrow.proposeReserveWithdrawal(all, 1);
        vm.prank(guardian);
        escrow.confirmReserveWithdrawal(all, 1);
        assertEq(escrow.reserve(), 0);
    }

    /// C9's F5: a sub-threshold shortfall (below MIN_LOSS_ATOMIC, so the owner is not gated) no
    /// longer falls on the last claimant: every guest, fee and owner credit is paid in full, and the
    /// owner-funded reserve takes the dust at the end.
    function testFuzz_F5_subThresholdDustFallsOnTheReserve(uint256 dust) public {
        dust = bound(dust, 1, 1 * USDC - 1);
        Quote memory q = _q(guest, P);
        bytes32 id = _deposit(q);
        _deployMax();
        _loss(dust);
        _settleAfterStay(id, q);
        assertEq(escrow.shortfallSince(), 0, "sub-threshold: not gated");

        uint256 owed = escrow.claimableOf(payout);
        assertEq(_claim(payout), owed, "owner paid in full");
        owed = escrow.claimableOf(feeTo);
        assertGt(owed, 0);
        assertEq(_claim(feeTo), owed, "fee recipient, the last claimant, paid in full");
        // The reserve holds what is left; it is short by at most the dust.
        assertGe(_escrowValue() + dust, escrow.reserve());
    }

    function _claim(address who) internal returns (uint256 paid) {
        uint256 before = usdc.balanceOf(who);
        vm.prank(who);
        escrow.claim();
        paid = usdc.balanceOf(who) - before;
    }

    // ================================================================== F3: broken vault (§3)

    function _brokenWithBooking() internal returns (bytes32 id, Quote memory q) {
        q = _q(guest, P);
        id = _deposit(q);
        _deployMax();
        vault.setBroken(true);
    }

    function test_F3_brokenVaultBlocksAccrueUntilWrittenOff() public {
        // Booking B ends soon (the owner will be owed); booking A is cancelled by its guest.
        Quote memory qb = _quoteFor(makeAddr("guestB"), uint40(T0 + 2 days), uint40(T0 + 4 days), 700 * USDC);
        bytes32 idB = _deposit(qb);
        (bytes32 id,) = _brokenWithBooking();
        vm.prank(guest);
        vm.expectRevert(MockVault.VaultBroken.selector);
        escrow.cancelByGuest(id);

        vm.expectEmit(address(escrow));
        emit IEscrowEvents.VaultWrittenOff(owner);
        vm.prank(owner);
        escrow.writeOffVault();
        assertTrue(escrow.vaultWrittenOff());
        assertGt(escrow.shortfallSince(), 0, "position shows as an observed shortfall");

        _settleAfterStay(idB, qb); // settles again once the vault is out of the accounting path
        assertGt(escrow.claimableOf(payout), 0);

        // Guests first (ADR 0009): the guest cancels and is paid what idle allows; the rest stays
        // credited (money rule 2). The owner is gated by the shortfall.
        vm.prank(guest);
        escrow.cancelByGuest(id);
        uint256 credit = escrow.claimableOf(guest);
        uint256 idle = usdc.balanceOf(address(escrow));
        uint256 expectPaid = idle < credit ? idle : credit;
        assertEq(_claim(guest), expectPaid);
        assertEq(escrow.claimableOf(guest), credit - expectPaid, "remainder kept");
        vm.prank(payout);
        vm.expectRevert(IEscrowErrors.LossDebtOutstanding.selector);
        escrow.claim();
        _assertBooksBalance();
    }

    function test_F3_writeOffIsRecognisedThroughTheNormalLossOrder() public {
        _brokenWithBooking();
        uint256 booked = escrow.lastAssets();
        vm.prank(guardian);
        escrow.writeOffVault();
        uint256 idle = usdc.balanceOf(address(escrow));
        vm.warp(block.timestamp + 6 hours);
        vm.expectEmit(address(escrow));
        emit IEscrowEvents.LossRecognised(booked - idle, 1 * USDC, 0, booked - idle - 1 * USDC);
        escrow.recogniseLoss();
        assertEq(escrow.reserve(), 0, "reserve absorbed first");
        assertEq(escrow.lossDebt(), booked - idle - 1 * USDC);
        _assertBooksBalance();
    }

    function test_F3_recoverBeforeRecognitionRestoresBooks() public {
        (bytes32 id, Quote memory q) = _brokenWithBooking();
        uint256 booked = escrow.lastAssets();
        vm.prank(owner);
        escrow.writeOffVault();
        vm.prank(owner);
        vm.expectRevert(MockVault.VaultBroken.selector); // still broken: recovery cannot read it
        escrow.recoverVault();

        vault.setBroken(false);
        vm.expectEmit(address(escrow));
        emit IEscrowEvents.VaultRecovered(guardian);
        vm.prank(guardian);
        escrow.recoverVault();
        assertFalse(escrow.vaultWrittenOff());
        assertEq(escrow.shortfallSince(), 0, "shortfall cleared");
        assertEq(escrow.lastAssets(), booked);
        _settleAfterStay(id, q);
        _assertBooksBalance();
    }

    function test_F3_recoverAfterRecognitionRepaysLossDebtFirst() public {
        _brokenWithBooking();
        vm.prank(owner);
        escrow.writeOffVault();
        vm.warp(block.timestamp + 6 hours);
        escrow.recogniseLoss();
        uint256 debt = escrow.lossDebt();
        assertGt(debt, 0);
        vault.setBroken(false);
        vm.expectEmit(address(escrow));
        emit IEscrowEvents.LossRepaid(debt, 0);
        vm.prank(owner);
        escrow.recoverVault();
        assertEq(escrow.lossDebt(), 0);
        _assertBooksBalance();
    }

    function test_F3_accessAndStateGuards() public {
        _brokenWithBooking();
        vm.prank(attacker);
        vm.expectRevert(IEscrowErrors.NotOwnerOrGuardian.selector);
        escrow.writeOffVault();
        vm.prank(owner);
        vm.expectRevert(IEscrowErrors.VaultNotWrittenOff.selector);
        escrow.recoverVault();

        vm.prank(owner);
        escrow.writeOffVault();
        vm.prank(guardian);
        vm.expectRevert(IEscrowErrors.VaultIsWrittenOff.selector);
        escrow.writeOffVault();
        vm.prank(rebalancer);
        vm.expectRevert(IEscrowErrors.VaultIsWrittenOff.selector);
        escrow.deploy(1);
        vm.prank(rebalancer);
        vm.expectRevert(MockVault.VaultBroken.selector); // redeem stays allowed (ADR 0015 §2); this vault is broken
        escrow.redeem(1);
        vm.prank(attacker);
        vm.expectRevert(IEscrowErrors.NotOwnerOrGuardian.selector);
        escrow.recoverVault();
    }

    function test_F3_noVaultConfigured() public {
        vm.prank(admin);
        factory.setDefaultVault(address(0));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        vm.prank(owner);
        vm.expectRevert(IEscrowErrors.NoVault.selector);
        escrow.writeOffVault();
    }

    // ================================================================== F1: pause is a pure flag (§2)

    /// Accruing in pause would make pausing depend on the vault; with a broken vault the guardian
    /// could not stop deposits. Pause must work and leave the books untouched.
    function test_F1_pauseWorksWithBrokenVaultAndLeavesBooksUntouched() public {
        _brokenWithBooking();
        uint256 la = escrow.lastAssets();
        vm.prank(guardian);
        escrow.pauseDeposits();
        assertTrue(escrow.paused());
        vm.prank(guardian);
        escrow.unpauseDeposits();
        assertEq(escrow.lastAssets(), la);
        assertEq(escrow.shortfallSince(), 0);
    }

    // ================================================================== F4: INV-1 (§4)

    /// C9's F4 scenario (honest deploy, ERC-4626 rounding): with the reserve floor in place INV-1
    /// holds as written in spec 10.4.
    function testFuzz_F4_INV1AsWrittenHoldsAfterHonestDeploy(uint256 price, uint256 amount) public {
        price = bound(price, 700 * USDC, 500_000 * USDC);
        _deposit(_q(guest, price));
        amount = bound(amount, 1, price * 9 / 10);
        _deploy(amount);
        uint256 assets = _escrowValue();
        assertGe(assets, escrow.totalOpenPrincipal() + escrow.totalDisputed() + escrow.totalClaimable());
    }
}
