// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {AaveFork, IAavePool} from "./AaveFork.sol";
import {ThinAaveAdapter} from "./spike/ThinAaveAdapter.sol";

interface IAclManager {
    function addEmergencyAdmin(address admin) external;
}

interface IStata {
    function aToken() external view returns (address);
    function paused() external view returns (bool);
    function setPaused(bool) external;
    function canPause(address) external view returns (bool);
}

/// D5 decision spike (brief C4): Aave's own ERC-4626 wrapper (StataTokenV2, option a) vs a thin
/// ERC-4626 over the raw pool (option b), on the pinned Base fork. Each test logs the figures the
/// ADR cites and asserts the property the escrow relies on.
contract AaveSpikeForkTest is AaveFork {
    IERC4626 internal stata;
    ThinAaveAdapter internal thin;
    address internal user = makeAddr("spike-user");

    function setUp() public {
        _fork();
        if (!forked) return;
        stata = IERC4626(STATA_USDC);
        thin = new ThinAaveAdapter(IERC20(USDC), IAavePool(POOL), IERC20(A_USDC));
        // Seed the fresh thin vault as ADR 0013 requires (the stata token is already seeded).
        deal(USDC, address(this), 1e6);
        IERC20(USDC).approve(address(thin), 1e6);
        thin.deposit(1e6, address(0xdEaD));
    }

    function _dep(IERC4626 v, uint256 amount) internal returns (uint256 shares) {
        deal(USDC, user, amount);
        vm.startPrank(user);
        IERC20(USDC).approve(address(v), amount);
        shares = v.deposit(amount, user);
        vm.stopPrank();
    }

    function test_addressesMatchTheAddressBookOnChain() public view {
        assertEq(stata.asset(), USDC, "stata asset");
        assertEq(IStata(STATA_USDC).aToken(), A_USDC, "stata aToken");
        assertFalse(IStata(STATA_USDC).paused());
        assertGe(stata.totalSupply(), 1e6, "seeded well above MIN_VAULT_SUPPLY");
        assertGt(POOL.code.length, 0);
    }

    /// Criterion: extra contract code we would own.
    function test_codeWeOwn() public {
        emit log_named_uint("option a (stata): bytes of our code", 0);
        emit log_named_uint("option b (thin adapter): bytes of our code", address(thin).code.length);
        emit log_named_uint("stata proxy bytes (Aave's)", STATA_USDC.code.length);
    }

    /// Criterion: rounding on withdraw. Deposit then redeem everything in the same block.
    function test_roundTripRoundingSameBlock() public {
        uint256 amt = 1_000_000e6;
        for (uint256 k; k < 2; k++) {
            IERC4626 v = k == 0 ? stata : IERC4626(address(thin));
            uint256 shares = _dep(v, amt);
            vm.prank(user);
            uint256 out = v.redeem(shares, user, user);
            emit log_named_uint(
                k == 0 ? "stata round-trip loss (atomic)" : "thin round-trip loss (atomic)", amt - out
            );
            assertLe(amt - out, 2, "at most 2 atomic units (brief test 1)");
        }
    }

    /// Criterion: fees. Over 30 days the wrapper's growth equals the aToken's (no fee layer).
    function test_noFeeLayerOver30Days() public {
        uint256 amt = 1_000_000e6;
        uint256 shares = _dep(stata, amt);
        deal(USDC, address(this), amt);
        IERC20(USDC).approve(POOL, amt);
        IAavePool(POOL).supply(USDC, amt, address(this), 0);
        uint256 aBefore = IERC20(A_USDC).balanceOf(address(this));
        vm.warp(block.timestamp + 30 days);
        uint256 aGain = IERC20(A_USDC).balanceOf(address(this)) - aBefore;
        uint256 sGain = stata.previewRedeem(shares) - amt;
        emit log_named_uint("aUSDC gain on 1M over 30d (atomic)", aGain);
        emit log_named_uint("stata gain on 1M over 30d (atomic)", sGain);
        assertApproxEqAbs(sGain, aGain, 2, "no fee: stata tracks the aToken within rounding");
    }

    /// Criterion: withdraw under full utilisation. Both cap maxWithdraw at market liquidity, and
    /// withdrawing exactly that succeeds (the escrow bounds every pull by maxWithdraw, spec 4.5).
    function test_fullUtilisationCapsMaxWithdraw() public {
        uint256 amt = 2_000_000e6;
        _dep(stata, amt);
        _dep(IERC4626(address(thin)), amt);
        _crunch(500_000e6);
        uint256 avail = _available();
        uint256 snap = vm.snapshotState();
        for (uint256 k; k < 2; k++) {
            vm.revertToState(snap);
            IERC4626 v = k == 0 ? stata : IERC4626(address(thin));
            uint256 mw = v.maxWithdraw(user);
            emit log_named_uint(
                k == 0 ? "stata maxWithdraw under crunch" : "thin maxWithdraw under crunch", mw
            );
            assertLe(mw, avail, "never above market liquidity");
            assertGt(mw, avail - 2, "all of the market's liquidity, less rounding");
            vm.prank(user);
            v.withdraw(mw, user, user);
            vm.prank(user);
            vm.expectRevert(); // one unit above maxWithdraw reverts: callers must bound by it
            v.withdraw(1e6, user, user);
        }
    }

    /// Criterion: donation (inflation) exposure. A donation of aUSDC moves the thin adapter's share
    /// price; the wrapper prices from the reserve index and does not move (ADR 0013 §1).
    function test_donationMovesThinAdapterButNotStata() public {
        uint256 amt = 1_000e6;
        _dep(stata, amt);
        _dep(IERC4626(address(thin)), amt);
        uint256 sBefore = stata.convertToAssets(1e12);
        uint256 tBefore = thin.convertToAssets(1e18);
        address donor = makeAddr("donor");
        deal(USDC, donor, 10_001e6);
        vm.startPrank(donor);
        IERC20(USDC).approve(POOL, 10_001e6);
        IAavePool(POOL).supply(USDC, 10_001e6, donor, 0); // aToken minting rounds down
        IERC20(A_USDC).transfer(address(thin), 5_000e6);
        IERC20(A_USDC).transfer(address(stata), 5_000e6);
        vm.stopPrank();
        assertEq(stata.convertToAssets(1e12), sBefore, "stata price unchanged by donation");
        assertGt(thin.convertToAssets(1e18), tBefore, "thin adapter price moved by donation");
    }

    /// Criterion: extra contract risk. Aave's emergency admin can pause the wrapper. FINDING (pinned
    /// here so an upstream change is noticed): while paused, `maxWithdraw` still reports the full
    /// position although `withdraw` reverts, contrary to EIP-4626 ("if withdrawals are entirely
    /// disabled (even temporarily) it MUST return 0"). `maxRedeem` checks only the reserve's pause,
    /// the wrapper's own pause is in `_update` (`whenNotPaused`). The escrow therefore never trusts
    /// maxWithdraw to succeed: it pulls best effort (docs/adr/0016).
    function test_pausedWrapperStillReportsMaxWithdraw_EIP4626Deviation() public {
        _dep(stata, 1_000e6);
        address guardian = _findPauseGuardian();
        vm.prank(guardian);
        IStata(STATA_USDC).setPaused(true);
        uint256 mw = stata.maxWithdraw(user);
        emit log_named_uint("stata maxWithdraw while the wrapper is paused", mw);
        assertGt(mw, 0, "deviation: not 0 while withdrawals are disabled");
        vm.prank(user);
        vm.expectRevert();
        stata.withdraw(1, user, user);
    }

    /// Aave governance (ACL_ADMIN, address book) grants the emergency-admin role, which is what
    /// `StataTokenV2.canPause` checks; that admin then pauses.
    function _findPauseGuardian() internal returns (address g) {
        g = makeAddr("aave-emergency-admin");
        vm.prank(ACL_ADMIN);
        IAclManager(ACL_MANAGER).addEmergencyAdmin(g);
        require(IStata(STATA_USDC).canPause(g), "canPause");
    }
}
