// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {MockYieldVault} from "../../src/testnet/MockYieldVault.sol";
import {MockUSDC} from "../utils/Mocks.sol";

/// The testnet mock vault's own behaviour (spec 6.6). Conformance with the escrow is in
/// AdapterConformance.t.sol.
contract MockYieldVaultTest is Test {
    MockUSDC internal usdc;
    MockYieldVault internal v;
    address internal owner = makeAddr("vaultOwner");
    address internal user = makeAddr("user");

    function setUp() public {
        vm.warp(1_780_000_000);
        usdc = new MockUSDC();
        v = new MockYieldVault(IERC20(address(usdc)), owner, 1_000); // 10% APY
        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(v), type(uint256).max);
    }

    function _deposit(uint256 a) internal returns (uint256) {
        vm.prank(user);
        return v.deposit(a, user);
    }

    function test_accruesLinearlyAtTheApyWhenFunded() public {
        _deposit(100_000e6);
        usdc.mint(address(v), 50_000e6); // yield budget
        vm.warp(block.timestamp + 365 days / 2);
        assertApproxEqAbs(v.totalAssets(), 105_000e6, 1, "half a year at 10%");
    }

    function test_neverReportsYieldItCannotPay() public {
        _deposit(100_000e6);
        usdc.mint(address(v), 1_000e6); // budget covers only 1,000
        vm.warp(block.timestamp + 365 days);
        assertEq(v.totalAssets(), 101_000e6, "capped at the USDC it holds");
        uint256 shares = v.balanceOf(user);
        vm.prank(user);
        assertApproxEqAbs(v.redeem(shares, user, user), 101_000e6, 1, "redeemable as reported");
    }

    function test_donationIsNotCountedUntilAccrued() public {
        _deposit(100_000e6);
        uint256 before = v.totalAssets();
        usdc.mint(address(v), 10_000_000e6);
        assertEq(v.totalAssets(), before, "a donation does not move the price");
    }

    function test_injectLossReducesAssetsAndPaysTheOwner() public {
        _deposit(100_000e6);
        vm.prank(owner);
        v.injectLoss(10_000e6);
        assertEq(v.totalAssets(), 90_000e6);
        assertEq(usdc.balanceOf(owner), 10_000e6);
        vm.prank(owner);
        vm.expectRevert(MockYieldVault.LossExceedsAssets.selector);
        v.injectLoss(90_000e6 + 1);
    }

    function test_withdrawLimitBoundsExits() public {
        _deposit(100_000e6);
        vm.prank(owner);
        v.setWithdrawLimit(5_000e6);
        assertEq(v.maxWithdraw(user), 5_000e6);
        assertLe(v.previewRedeem(v.maxRedeem(user)), 5_000e6);
        vm.prank(user);
        vm.expectRevert();
        v.withdraw(5_000e6 + 1, user, user);
    }

    function test_setApyCheckpointsAccruedYield() public {
        _deposit(100_000e6);
        usdc.mint(address(v), 50_000e6);
        vm.warp(block.timestamp + 365 days);
        vm.prank(owner);
        v.setApy(0);
        uint256 atChange = v.totalAssets();
        vm.warp(block.timestamp + 365 days);
        assertEq(v.totalAssets(), atChange, "no accrual after APY set to 0, earned yield kept");
        assertApproxEqAbs(atChange, 110_000e6, 1);
    }

    function test_knobsAreOwnerOnly() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        v.setApy(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        v.setWithdrawLimit(1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        v.injectLoss(1);
        vm.stopPrank();
    }
}
