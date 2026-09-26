// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Protocol constants, spec section 13, plus the freeze budget from docs/adr/0007.
library Params {
    uint16 internal constant BPS = 10_000;

    // factory
    uint16 internal constant MAX_FEE_BPS = 2_000;
    uint32 internal constant FEE_CHANGE_DELAY = 7 days;
    uint32 internal constant FEE_RECIPIENT_DELAY = 7 days;
    uint32 internal constant ARBITRATOR_DELAY = 7 days;

    // escrow
    uint32 internal constant GRACE = 72 hours;
    uint32 internal constant DISPUTE_WINDOW = 14 days;
    uint32 internal constant MAX_NIGHTS = 60;
    uint16 internal constant MIN_BUFFER_BPS = 1_000;
    uint32 internal constant LOSS_CONFIRMATION_WINDOW = 6 hours;
    uint32 internal constant MAX_FREEZE_DURATION = 30 days;
    /// @dev Shortfalls below this are ignored for gating and recognition, so ERC-4626 rounding dust
    /// cannot block owners or be recognised to grief deposits (docs/adr/0010).
    uint256 internal constant MIN_LOSS_ATOMIC = 1e6; // 1 USDC

    // owner-set defaults at creation
    uint16 internal constant DEFAULT_GUEST_YIELD_BPS = 5_000;
    uint16 internal constant DEFAULT_MAX_DEPLOY_BPS = 9_000;
}
