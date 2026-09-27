// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice 6-decimal ERC-20 with ERC-2612 permit, standing in for USDC in unit tests.
contract MockUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Mock USDC", "USDC") ERC20Permit("Mock USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// Test-only: destroys tokens held by `from`, e.g. to inject a loss into a vault.
    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Charges 1 atomic unit per transfer, to exercise guard 12's balance-delta check.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0xdead), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

/// @notice OpenZeppelin ERC-4626 vault with a settable withdrawal limit (liquidity crunch), a
/// record of the last withdrawal receiver, and a switch that makes its asset views revert (a broken
/// adapter, docs/adr/0013 §3). Decimals offset 12 = 18 - 6, MetaMorpho's value for USDC: with any
/// seed the inflation attack is orders of magnitude unprofitable (OpenZeppelin ERC4626 CAUTION).
contract MockVault is ERC4626 {
    uint256 public withdrawLimit = type(uint256).max;
    address public lastReceiver;
    bool public broken;

    error VaultBroken();

    constructor(IERC20 asset_) ERC20("Mock Vault", "mvUSDC") ERC4626(asset_) {}

    function setWithdrawLimit(uint256 limit) external {
        withdrawLimit = limit;
    }

    function setBroken(bool b) external {
        broken = b;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    function totalAssets() public view override returns (uint256) {
        if (broken) revert VaultBroken();
        return super.totalAssets();
    }

    function previewRedeem(uint256 shares) public view override returns (uint256) {
        if (broken) revert VaultBroken();
        return super.previewRedeem(shares);
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (broken) revert VaultBroken();
        return Math.min(super.maxWithdraw(owner), withdrawLimit);
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        lastReceiver = receiver;
        super._withdraw(caller, receiver, owner, assets, shares);
    }
}

/// @notice ERC-4626 that takes the assets but mints no shares, as a real vault can for a small deposit
/// at a high share price.
contract ZeroShareVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Zero", "ZERO") ERC4626(asset_) {}

    /// Test-only: shares for a seed position (this vault never mints shares for a deposit).
    function seed(address to, uint256 shares) external {
        _mint(to, shares);
    }

    function _convertToShares(uint256, Math.Rounding) internal pure override returns (uint256) {
        return 0;
    }
}

/// @notice Minimal smart wallet: executes a batch of calls in one transaction, as ERC-4337 or
/// EIP-5792 batching would. Used to test approve + deposit with `msg.sender == q.guest`.
contract BatchWallet {
    struct Call {
        address to;
        bytes data;
    }

    function execute(Call[] calldata calls) external {
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].to.call(calls[i].data);
            if (!ok) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
