// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice C9's own 6-decimal USDC stand-in: EIP-2612 permit, a Circle-style blacklist, and a
/// transfer tap that records every USDC movement out of the watched escrow and in/out of the
/// watched vault (property 6: only entitled parties receive escrowed funds; the adapter only
/// exchanges USDC with the escrow).
contract C9Usdc is ERC20, ERC20Permit {
    error Blacklisted(address account);
    error NotAdmin();

    mapping(address => bool) public isAdmin;
    mapping(address => bool) public blacklisted;

    address public watchedEscrow;
    address public watchedVault;
    mapping(address => bool) public allowedFromEscrow;
    mapping(address => uint256) public receivedFromEscrow;

    uint256 public badEscrowOut; // escrow paid someone not on the allow list
    uint256 public badVaultIn; // vault received USDC from anyone but the escrow (mints excluded)
    uint256 public badVaultOut; // vault paid anyone but the escrow (burns excluded)
    address public lastBadCounterparty;

    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {
        isAdmin[msg.sender] = true;
    }

    modifier onlyAdmin() {
        if (!isAdmin[msg.sender]) revert NotAdmin();
        _;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setAdmin(address a, bool on) external onlyAdmin {
        isAdmin[a] = on;
    }

    function mint(address to, uint256 amount) external onlyAdmin {
        _mint(to, amount);
    }

    /// @dev Loss injector: destroys tokens held by `from` (used on the vault only).
    function adminBurn(address from, uint256 amount) external onlyAdmin {
        _burn(from, amount);
    }

    function setBlacklisted(address a, bool on) external onlyAdmin {
        blacklisted[a] = on;
    }

    function watch(address escrow, address vault) external onlyAdmin {
        watchedEscrow = escrow;
        watchedVault = vault;
    }

    function setAllowedFromEscrow(address a, bool on) external onlyAdmin {
        allowedFromEscrow[a] = on;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && blacklisted[from]) revert Blacklisted(from);
        if (to != address(0) && blacklisted[to]) revert Blacklisted(to);
        address esc = watchedEscrow;
        address v = watchedVault;
        if (esc != address(0) && from == esc && to != address(0)) {
            receivedFromEscrow[to] += value;
            if (!allowedFromEscrow[to]) {
                badEscrowOut++;
                lastBadCounterparty = to;
            }
        }
        if (v != address(0)) {
            if (to == v && from != address(0) && from != esc) {
                badVaultIn++;
                lastBadCounterparty = from;
            }
            if (from == v && to != address(0) && to != esc) {
                badVaultOut++;
                lastBadCounterparty = to;
            }
        }
        super._update(from, to, value);
    }
}
