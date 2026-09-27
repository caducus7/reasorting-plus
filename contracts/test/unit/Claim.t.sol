// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {BatchWallet, MockVault} from "../utils/Mocks.sol";
import {Escrow} from "../../src/Escrow.sol";
import {Quote} from "../../src/interfaces/IEscrow.sol";

contract ClaimTest is EscrowTestBase {
    using stdStorage for StdStorage;

    uint256 internal constant P = 5_600 * USDC;

    function _settleDelivered() internal returns (bytes32 id) {
        Quote memory q = _quote();
        id = _deposit(q);
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        escrow.settle(id);
    }

    function _claim(address who) internal returns (uint256 paid) {
        vm.prank(who);
        paid = escrow.claim();
    }

    function test_ownerAndFeeClaim() public {
        _settleDelivered();
        assertEq(escrow.claimableOf(payout), 5_320 * USDC);
        assertEq(_claim(payout), 5_320 * USDC);
        assertEq(usdc.balanceOf(payout), 5_320 * USDC);
        assertEq(_claim(feeTo), 280 * USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.totalClaimable(), 0);
        assertEq(escrow.lastAssets(), 0);
    }

    function test_guestClaimAfterCancel_emitsRequestedAndPaid() public {
        bytes32 id = _deposit(_quote());
        vm.prank(guest);
        escrow.cancelByGuest(id);
        vm.expectEmit(address(escrow));
        emit Claimed(guest, P, P);
        assertEq(_claim(guest), P);
    }

    function test_zeroClaimIsNoop() public {
        assertEq(_claim(makeAddr("nobody")), 0);
    }

    /// ADR 0003: the checkout bundles [cancelByGuest, claim]; a 0% refund must not revert the batch.
    function test_cancelAndClaimBundle_zeroRefundDoesNotRevert() public {
        BatchWallet wallet = new BatchWallet();
        Quote memory q = _quoteFor(address(wallet), uint40(T0 + 60 days), uint40(T0 + 67 days), P);
        bytes memory sig = _sign(q);
        usdc.mint(address(wallet), P);
        BatchWallet.Call[] memory calls = new BatchWallet.Call[](2);
        calls[0] = BatchWallet.Call(address(usdc), abi.encodeCall(IERC20.approve, (address(escrow), P)));
        calls[1] = BatchWallet.Call(address(escrow), abi.encodeCall(escrow.deposit, (q, sig)));
        wallet.execute(calls);
        bytes32 id = escrow.hashQuote(q);

        vm.warp(q.checkInUtc); // finalBps = 0
        calls[0] = BatchWallet.Call(address(escrow), abi.encodeCall(escrow.cancelByGuest, (id)));
        calls[1] = BatchWallet.Call(address(escrow), abi.encodeCall(escrow.claim, ()));
        wallet.execute(calls);
        assertEq(usdc.balanceOf(address(wallet)), 0);

        // and a full refund arrives in the same batch
        Quote memory q2 = _quoteFor(
            address(wallet),
            uint40(block.timestamp + 60 days),
            uint40(block.timestamp + 62 days),
            1_000 * USDC
        );
        bytes memory sig2 = _sign(q2);
        usdc.mint(address(wallet), q2.priceAtomic);
        calls[0] = BatchWallet.Call(
            address(usdc), abi.encodeCall(IERC20.approve, (address(escrow), q2.priceAtomic))
        );
        calls[1] = BatchWallet.Call(address(escrow), abi.encodeCall(escrow.deposit, (q2, sig2)));
        wallet.execute(calls);
        calls[0] =
            BatchWallet.Call(address(escrow), abi.encodeCall(escrow.cancelByGuest, (escrow.hashQuote(q2))));
        calls[1] = BatchWallet.Call(address(escrow), abi.encodeCall(escrow.claim, ()));
        wallet.execute(calls);
        assertEq(usdc.balanceOf(address(wallet)), q2.priceAtomic);
    }

    /// Review 0001 finding 3 / ADR 0007: owner credits follow the current payout address.
    function test_payoutRotation_movesOwnerBucket() public {
        _settleDelivered();
        address newPayout = makeAddr("newPayout");
        vm.prank(owner);
        escrow.setPayoutAddress(newPayout);
        assertEq(_claim(payout), 0, "old payout address has nothing");
        assertEq(escrow.claimableOf(newPayout), 5_320 * USDC);
        assertEq(_claim(newPayout), 5_320 * USDC);
    }

    // ------------------------------------------------------------------ lossDebt gates (spec 4.5, 6.4)

    function _setLossDebt() internal {
        stdstore.target(address(escrow)).sig("lossDebt()").checked_write(uint256(1));
    }

    function test_lossDebt_blocksOwnerAndFee_notGuest() public {
        _settleDelivered();
        bytes32 id = _deposit(
            _quoteFor(
                guest, uint40(block.timestamp + 60 days), uint40(block.timestamp + 62 days), 1_000 * USDC
            )
        );
        vm.prank(guest);
        escrow.cancelByGuest(id);
        _setLossDebt();

        vm.prank(payout);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.claim();
        vm.prank(feeTo);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.claim();
        assertEq(_claim(guest), 1_000 * USDC);
    }

    function test_lossDebt_payoutWhoIsAlsoGuestGetsGuestPartOnly() public {
        _settleDelivered(); // owner bucket 5,320
        Quote memory q = _quoteFor(
            payout, uint40(block.timestamp + 60 days), uint40(block.timestamp + 62 days), 1_000 * USDC
        );
        bytes32 id = _deposit(q);
        vm.prank(payout);
        escrow.cancelByGuest(id);
        _setLossDebt();
        assertEq(_claim(payout), 1_000 * USDC);
        assertEq(escrow.ownerClaimable(), 5_320 * USDC);
    }

    // ------------------------------------------------------------------ vault shortfall (spec 4.5)

    function _escrowWithVault() internal returns (MockVault v) {
        v = new MockVault(IERC20(address(usdc)));
        usdc.mint(address(this), 1);
        usdc.approve(address(v), 1);
        v.deposit(1, address(0xdEaD)); // seed (docs/adr/0013 §1)
        vm.prank(admin);
        factory.setDefaultVault(address(v));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        assertEq(address(escrow.vault()), address(v));
    }

    /// Stands in for C2's rebalancer: moves `amount` of the escrow's idle USDC into the vault.
    function _deployToVault(MockVault v, uint256 amount) internal {
        vm.startPrank(address(escrow));
        usdc.approve(address(v), amount);
        v.deposit(amount, address(escrow));
        vm.stopPrank();
    }

    function test_claim_pullsShortfallFromVault_receiverIsEscrow() public {
        MockVault v = _escrowWithVault();
        bytes32 id = _deposit(_quote());
        _deployToVault(v, 5_000 * USDC); // 600 idle
        assertEq(escrow.totalAssets(), P);
        vm.prank(guest);
        escrow.cancelByGuest(id);
        assertEq(_claim(guest), P);
        assertEq(v.lastReceiver(), address(escrow), "vault withdraw always to the escrow (money rule 3)");
    }

    function test_claim_partialUnderLiquidityCrunch_restStaysClaimable() public {
        MockVault v = _escrowWithVault();
        bytes32 id = _deposit(_quote());
        _deployToVault(v, 5_000 * USDC); // 600 idle
        v.setWithdrawLimit(1_000 * USDC);
        vm.prank(guest);
        escrow.cancelByGuest(id);

        vm.expectEmit(address(escrow));
        emit Claimed(guest, P, 1_600 * USDC); // effects (and their event) precede the vault call
        vm.expectEmit(address(escrow));
        emit Redeemed(1_000 * USDC);
        assertEq(_claim(guest), 1_600 * USDC);
        assertEq(escrow.guestClaimable(guest), 4_000 * USDC, "crediting never reverts; rest stays claimable");

        v.setWithdrawLimit(type(uint256).max);
        assertEq(_claim(guest), 4_000 * USDC);
        assertEq(escrow.guestClaimable(guest), 0);
    }

    function test_claim_vaultFullyIlliquid_paysIdleOnly() public {
        MockVault v = _escrowWithVault();
        bytes32 id = _deposit(_quote());
        _deployToVault(v, P);
        v.setWithdrawLimit(0);
        vm.prank(guest);
        escrow.cancelByGuest(id);
        assertEq(_claim(guest), 0);
        assertEq(escrow.guestClaimable(guest), P);
    }
}
