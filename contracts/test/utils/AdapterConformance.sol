// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Escrow} from "../../src/Escrow.sol";
import {IEscrowErrors, Quote, Cutoff} from "../../src/interfaces/IEscrow.sol";

/// @notice C4 adapter conformance suite (brief acceptance), parameterised over implementations:
/// no vault (address(0), the former NullAdapter), the testnet MockYieldVault, and Aave's
/// StataTokenV2 on the Base fork. Every property is checked through the real escrow.
abstract contract AdapterConformance is Test {
    // ------------------------------------------------------------------ hooks

    function _cEscrow() internal view virtual returns (Escrow);
    function _cUsdc() internal view virtual returns (IERC20);
    function _cSignerKey() internal view virtual returns (uint256);
    function _cRebalancer() internal view virtual returns (address);
    function _cOwner() internal view virtual returns (address);
    function _cDeal(address to, uint256 amount) internal virtual;
    /// Limit what the vault lets the escrow withdraw to about `leave`.
    function _cLimit(uint256 leave) internal virtual;

    function _cVault() internal view returns (IERC4626) {
        return IERC4626(address(_cEscrow().vault()));
    }

    function _hasVault() internal view returns (bool) {
        return address(_cVault()) != address(0);
    }

    uint256 private _n;

    function _cBook(uint256 price) internal returns (bytes32 id, address guest) {
        Escrow e = _cEscrow();
        guest = makeAddr(string.concat("conformance-guest-", vm.toString(++_n)));
        Quote memory q;
        q.resourceId = keccak256("villa");
        q.checkInUtc = uint40(block.timestamp + 60 days);
        q.checkOutUtc = uint40(block.timestamp + 67 days);
        q.priceAtomic = price;
        q.feeBps = e.effectiveFeeBps();
        q.guestYieldBps = e.guestYieldBps();
        q.policyHash = keccak256("policy");
        q.cutoffs = new Cutoff[](1);
        q.cutoffs[0] = Cutoff(uint40(block.timestamp + 30 days), 10_000);
        q.guest = guest;
        q.expiresAt = uint40(block.timestamp + 15 minutes);
        q.salt = bytes32(_n);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_cSignerKey(), e.quoteDigest(q));
        _cDeal(guest, price);
        vm.startPrank(guest);
        _cUsdc().approve(address(e), price);
        id = e.deposit(q, abi.encodePacked(r, s, v));
        vm.stopPrank();
    }

    function _cFundReserveFloor() internal {
        Escrow e = _cEscrow();
        if (e.reserve() >= 1e6) return;
        _cDeal(_cOwner(), 1e6);
        vm.startPrank(_cOwner());
        _cUsdc().approve(address(e), 1e6);
        e.fundReserve(1e6);
        vm.stopPrank();
    }

    function _cDeploy(uint256 amount) internal {
        _cFundReserveFloor();
        vm.prank(_cRebalancer());
        _cEscrow().deploy(amount);
    }

    // ------------------------------------------------------------------ properties

    /// Only the escrow can move its funds out of the vault (brief acceptance). ERC-4626 share
    /// ownership: a third party cannot withdraw or redeem on the escrow's behalf.
    function test_conformance_onlyEscrowMovesItsShares() public {
        _cBook(10_000e6);
        if (!_hasVault()) {
            vm.prank(_cRebalancer());
            vm.expectRevert(IEscrowErrors.NoVault.selector);
            _cEscrow().deploy(1e6);
            return;
        }
        _cDeploy(9_000e6);
        IERC4626 v = _cVault();
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        v.withdraw(1e6, stranger, address(_cEscrow()));
        uint256 shares = v.balanceOf(address(_cEscrow()));
        vm.prank(stranger);
        vm.expectRevert();
        v.redeem(shares, stranger, address(_cEscrow()));
    }

    /// Round trip: deposit then full withdraw returns the principal less at most 2 atomic units.
    function test_conformance_roundTripWithinTwoUnits() public {
        _cBook(10_000e6);
        if (!_hasVault()) return; // nothing leaves idle without a vault
        IERC20 usdc = _cUsdc();
        address e = address(_cEscrow());
        uint256 before = usdc.balanceOf(e);
        _cDeploy(9_000e6);
        uint256 max = _cVault().maxWithdraw(e);
        vm.prank(_cRebalancer());
        _cEscrow().redeem(max);
        assertLe(before + 1e6 - usdc.balanceOf(e), 2, "round trip loses at most 2 atomic units");
    }

    /// Liquidity crunch: a claim pays what idle plus the vault's exit liquidity allow, never reverts,
    /// and keeps the rest credited (spec 4.5). Funds only ever go to the escrow, then the guest.
    function test_conformance_claimUnderLimitedLiquidityPaysPartially() public {
        (bytes32 id, address guest) = _cBook(10_000e6);
        Escrow e = _cEscrow();
        if (_hasVault()) {
            _cDeploy(9_000e6);
            _cLimit(1_000e6);
        }
        vm.prank(guest);
        e.cancelByGuest(id); // 100% tier
        uint256 idle = _cUsdc().balanceOf(address(e));
        vm.prank(guest);
        uint256 paid = e.claim();
        assertEq(_cUsdc().balanceOf(guest), paid, "the guest received exactly what was paid");
        assertEq(e.claimableOf(guest), 10_000e6 - paid, "the rest stays credited");
        if (_hasVault()) {
            assertGe(paid, idle + 1_000e6 - 2, "idle plus the vault's exit liquidity");
            assertLt(paid, 10_000e6);
        } else {
            assertEq(paid, 10_000e6);
        }
    }

    /// totalAssets never over-reports what redeeming every share returns.
    function test_conformance_totalAssetsNeverOverReports() public {
        _cBook(10_000e6);
        if (!_hasVault()) {
            assertEq(_cEscrow().totalAssets(), _cUsdc().balanceOf(address(_cEscrow())));
            return;
        }
        _cDeploy(9_000e6);
        vm.warp(block.timestamp + 45 days);
        Escrow e = _cEscrow();
        uint256 reported = e.totalAssets();
        IERC4626 v = _cVault(); // read before the prank: _cVault() is itself an external call
        uint256 shares = v.balanceOf(address(e));
        vm.prank(address(e));
        v.redeem(shares, address(e), address(e));
        assertGe(_cUsdc().balanceOf(address(e)), reported, "no over-report");
    }
}
