// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MockYieldVault — TESTNET AND DEMO ONLY. Never approve it on mainnet.
/// @notice The spec 6.6 "mock vault": an OpenZeppelin ERC-4626 over USDC with a settable APY,
/// a withdrawal limit (a liquidity crunch on demand) and a loss injector, so demos show months of
/// accrual in minutes. Production uses Aave's StataTokenV2 (docs/adr/0016); the two are never
/// merged (CLAUDE.md section 5).
/// @dev Yield must be real USDC (Base Sepolia USDC cannot be minted): the owner funds a budget by
/// transferring USDC in. `totalAssets` grows linearly from a checkpoint at `apyBps` and is capped at
/// the vault's USDC balance, so it never reports yield it cannot pay. A donation is not counted until
/// it accrues, which also blunts the donation attack; the decimals offset of 12 and a burned seed
/// cover the rest (docs/adr/0013 §1).
contract MockYieldVault is ERC4626, Ownable2Step {
    using SafeERC20 for IERC20;

    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;

    uint256 public apyBps;
    uint256 public withdrawLimit = type(uint256).max;
    uint256 public anchorAssets; // assets at the last checkpoint, excluding unaccrued budget
    uint256 public anchorTime;

    event ApySet(uint256 apyBps);
    event WithdrawLimitSet(uint256 limit);
    event LossInjected(uint256 amount);

    error LossExceedsAssets();

    constructor(IERC20 usdc, address owner_, uint256 apyBps_)
        ERC20("Mock Yield Vault USDC", "mvUSDC")
        ERC4626(usdc)
        Ownable(owner_)
    {
        apyBps = apyBps_;
        anchorTime = block.timestamp;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    function totalAssets() public view override returns (uint256) {
        uint256 grown =
            anchorAssets + Math.mulDiv(anchorAssets, apyBps * (block.timestamp - anchorTime), BPS * YEAR);
        return Math.min(grown, IERC20(asset()).balanceOf(address(this)));
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        return Math.min(super.maxWithdraw(owner), withdrawLimit);
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 r = super.maxRedeem(owner);
        // No limit set: converting type(uint256).max to shares would overflow.
        return withdrawLimit == type(uint256).max ? r : Math.min(r, convertToShares(withdrawLimit));
    }

    // ------------------------------------------------------------------ owner knobs

    function setApy(uint256 apyBps_) external onlyOwner {
        _checkpoint();
        apyBps = apyBps_;
        emit ApySet(apyBps_);
    }

    function setWithdrawLimit(uint256 limit) external onlyOwner {
        withdrawLimit = limit;
        emit WithdrawLimitSet(limit);
    }

    /// @notice Removes `amount` of counted assets and sends the USDC to the owner (it cannot be
    /// burned on testnet): shareholders see a loss.
    function injectLoss(uint256 amount) external onlyOwner {
        _checkpoint();
        if (amount > anchorAssets) revert LossExceedsAssets();
        anchorAssets -= amount;
        emit LossInjected(amount);
        IERC20(asset()).safeTransfer(owner(), amount);
    }

    // ------------------------------------------------------------------ accounting

    function _checkpoint() internal {
        anchorAssets = totalAssets();
        anchorTime = block.timestamp;
    }

    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        _checkpoint();
        anchorAssets += assets;
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        _checkpoint();
        anchorAssets -= assets;
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}
