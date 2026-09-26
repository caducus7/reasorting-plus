// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice C9's own ERC-4626 test adapter (ADR 0008). Gains and losses are injected by minting or
/// burning the underlying held by the vault (through the C9Usdc admin), and a withdrawal limit
/// simulates a liquidity crunch. OpenZeppelin's `withdraw`/`redeem` enforce `maxWithdraw` /
/// `maxRedeem`, so the limit is binding.
contract C9Vault is ERC4626 {
    error NotAdmin();

    address public immutable admin;
    uint256 public withdrawLimit = type(uint256).max;

    constructor(IERC20 asset_) ERC20("C9 Vault", "c9V") ERC4626(asset_) {
        admin = msg.sender;
    }

    function setWithdrawLimit(uint256 limit) external {
        if (msg.sender != admin) revert NotAdmin();
        withdrawLimit = limit;
    }

    error Bricked();

    bool public bricked; // every view and withdrawal reverts (a paused or broken vault)

    function setBricked(bool on) external {
        if (msg.sender != admin) revert NotAdmin();
        bricked = on;
    }

    function totalAssets() public view override returns (uint256) {
        if (bricked) revert Bricked();
        return super.totalAssets();
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        uint256 m = super.maxWithdraw(owner);
        return m < withdrawLimit ? m : withdrawLimit;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        uint256 m = super.maxRedeem(owner);
        if (withdrawLimit == type(uint256).max) return m;
        uint256 l = convertToShares(withdrawLimit);
        return m < l ? m : l;
    }
}
