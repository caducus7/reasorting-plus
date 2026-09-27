// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAavePool} from "../AaveFork.sol";

/// D5 option (b), SPIKE ONLY (never deployed): a thin ERC-4626 over the raw Aave V3 pool. Shares are
/// priced from the aToken balance (balance-priced), as a straightforward adapter would be.
contract ThinAaveAdapter is ERC4626 {
    using SafeERC20 for IERC20;

    IAavePool public immutable pool;
    IERC20 public immutable aToken;

    constructor(IERC20 usdc, IAavePool pool_, IERC20 aToken_) ERC20("thin aUSDC", "taUSDC") ERC4626(usdc) {
        pool = pool_;
        aToken = aToken_;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    function totalAssets() public view override returns (uint256) {
        return aToken.balanceOf(address(this));
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), pool.getVirtualUnderlyingBalance(asset()));
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        return Math.min(super.maxRedeem(owner), convertToShares(pool.getVirtualUnderlyingBalance(asset())));
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        super._deposit(caller, receiver, assets, shares);
        IERC20(asset()).forceApprove(address(pool), assets);
        pool.supply(asset(), assets, address(this), 0);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        pool.withdraw(asset(), assets, address(this));
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}
