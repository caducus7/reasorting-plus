// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEscrowEvents, IEscrowErrors, Booking, BookingState, Outcome} from "../interfaces/IEscrow.sol";
import {SettlementLib} from "./SettlementLib.sol";
import {Params} from "./Params.sol";

/// @notice Escrow accounting (spec 4.4, 4.5, 6.1 to 6.5; docs/adr/0009, 0010).
/// @dev All state lives in the escrow's `Ledger`. External functions run by DELEGATECALL from the
/// Escrow implementation (deployed once, linked), so they write the escrow's storage, move the
/// escrow's tokens and log events from the escrow's address. Same pattern as Aave V3's logic
/// libraries; it keeps Escrow under EIP-170.
///
/// Books identity, exact after every state-changing call:
///   lastAssets + lossDebt == totalOpenPrincipal + totalDisputed + totalClaimable
///                            + totalPendingYield + reserve + yieldUnallocated
struct Ledger {
    uint256 totalOpenPrincipal; // ESCROWED + DELIVERED-unsettled + FROZEN
    uint256 totalDisputed; // C3
    uint256 totalPendingYield; // deferred yield credits
    uint256 totalClaimable;
    uint256 reserve;
    uint256 lossDebt;
    uint256 accYieldPerUnit; // 1e18
    uint256 lastAssets; // booked assets: high-water mark between recognised losses
    uint256 yieldUnallocated; // accumulated, not yet crystallised; per-booking dust stays here
    uint256 ownerClaimable; // owner bucket, paid to the current payout address (ADR 0007)
    uint256 pendingOwnerYield;
    uint256 pendingReserveWithdrawal;
    uint40 shortfallSince; // first observation of a shortfall >= MIN_LOSS_ATOMIC; 0 if none
    uint8 pendingReserveReason;
    mapping(address => uint256) guestClaimable;
    mapping(address => uint256) feeClaimable;
    mapping(address => uint256) pendingGuestYield;
}

library LedgerLib {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------------------------------
    // Accrual (spec 6.1, high-water mark per ADR 0009)

    function totalAssets(IERC20 usdc, IERC4626 vault) public view returns (uint256 assets) {
        assets = usdc.balanceOf(address(this));
        if (address(vault) != address(0)) assets += vault.previewRedeem(vault.balanceOf(address(this)));
    }

    /// @notice Gains above `lastAssets` repay lossDebt, then go to the accumulator (or the reserve
    /// when no principal is open). A dip never lowers `lastAssets`: it is an observed shortfall.
    function accrue(Ledger storage l, IERC20 usdc, IERC4626 vault) external {
        uint256 assets = totalAssets(usdc, vault);
        uint256 booked = l.lastAssets;
        if (assets > booked) {
            uint256 gain = assets - booked;
            l.lastAssets = assets;
            uint256 debt = l.lossDebt;
            if (debt != 0) {
                uint256 repay = Math.min(gain, debt);
                l.lossDebt = debt - repay;
                gain -= repay;
                emit IEscrowEvents.LossRepaid(repay, debt - repay);
            }
            if (gain != 0) {
                uint256 toReserve;
                if (l.totalOpenPrincipal == 0) {
                    toReserve = gain;
                    l.reserve += gain;
                } else {
                    l.accYieldPerUnit += Math.mulDiv(gain, 1e18, l.totalOpenPrincipal);
                    l.yieldUnallocated += gain;
                }
                emit IEscrowEvents.YieldAccrued(gain, toReserve, l.accYieldPerUnit);
            }
            _clearShortfall(l);
        } else if (booked - assets >= Params.MIN_LOSS_ATOMIC) {
            if (l.shortfallSince == 0) {
                l.shortfallSince = uint40(block.timestamp);
                emit IEscrowEvents.ShortfallObserved(booked - assets);
            }
        } else {
            _clearShortfall(l);
        }
    }

    function _clearShortfall(Ledger storage l) private {
        if (l.shortfallSince != 0) {
            l.shortfallSince = 0;
            emit IEscrowEvents.ShortfallCleared();
        }
    }

    function lossActive(Ledger storage l) internal view returns (bool) {
        return l.lossDebt != 0 || l.shortfallSince != 0;
    }

    // ------------------------------------------------------------------------------------------
    // Settlement (spec 4.4)

    /// @notice Crystallises the booking's yield and credits the settlement figures. Never transfers.
    /// While lossDebt > 0, yield credits are deferred (spec 4.4, 6.4).
    function settle(
        Ledger storage l,
        Booking storage b,
        bytes32 bookingId,
        uint256 refundBps,
        bool vested,
        Outcome outcome,
        address feeTo
    ) external {
        uint256 principal = b.principalAtomic;
        // y never exceeds yieldUnallocated: every booking in totalOpenPrincipal shares each
        // distribution pro rata, and each share rounds down.
        uint256 y = Math.mulDiv(principal, l.accYieldPerUnit - b.accAtDeposit, 1e18);
        l.yieldUnallocated -= y;
        SettlementLib.Figures memory f =
            SettlementLib.compute(principal, refundBps, b.feeBps, y, b.guestYieldBps, vested);

        b.state = BookingState.SETTLED;
        l.totalOpenPrincipal -= principal;
        l.feeClaimable[feeTo] += f.fee;
        address guest = b.guest;
        if (l.lossDebt == 0) {
            l.guestClaimable[guest] += f.refund + f.guestYield;
            l.ownerClaimable += f.ownerPrincipal + f.ownerYield;
            l.totalClaimable += principal + y;
        } else {
            l.guestClaimable[guest] += f.refund;
            l.ownerClaimable += f.ownerPrincipal;
            l.totalClaimable += principal;
            l.pendingGuestYield[guest] += f.guestYield;
            l.pendingOwnerYield += f.ownerYield;
            l.totalPendingYield += y;
            emit IEscrowEvents.YieldDeferred(bookingId, f.guestYield, f.ownerYield);
        }
        _emitSettled(bookingId, outcome, principal, f, y, feeTo);
    }

    function _emitSettled(
        bytes32 bookingId,
        Outcome outcome,
        uint256 principal,
        SettlementLib.Figures memory f,
        uint256 y,
        address feeTo
    ) private {
        emit IEscrowEvents.BookingSettled(
            bookingId,
            outcome,
            principal,
            f.refund,
            f.ownerPrincipal,
            f.fee,
            y,
            f.guestYield,
            f.ownerYield,
            feeTo
        );
    }

    // ------------------------------------------------------------------------------------------
    // Claims (spec 4.5)

    /// @notice Pays `account` min(claimable, liquid), guest bucket first. Zero claimable is a
    /// no-op. While a loss is active only the guest bucket is paid, and a caller holding only owner
    /// or fee credits reverts. Deferred yield is released first when no loss is active.
    function claim(Ledger storage l, IERC20 usdc, IERC4626 vault, address account, bool isPayout)
        external
        returns (uint256 paid)
    {
        bool active = lossActive(l);
        if (!active) _releasePendingYield(l, account, isPayout);
        (uint256 g, uint256 requested) = _requested(l, account, isPayout, active);
        if (requested == 0) return 0;

        uint256 pull;
        (pull, paid) = planPull(usdc, vault, requested);

        // Effects before any external call.
        _debit(l, account, g, paid);
        l.totalClaimable -= paid;
        l.lastAssets -= paid;
        emit IEscrowEvents.Claimed(account, requested, paid);

        pullFromVault(vault, pull);
        if (paid != 0) usdc.safeTransfer(account, paid);
    }

    /// @dev Guest bucket, plus fee and owner buckets only when no loss is active.
    function _requested(Ledger storage l, address account, bool isPayout, bool active)
        private
        view
        returns (uint256 g, uint256 requested)
    {
        g = l.guestClaimable[account];
        uint256 other = l.feeClaimable[account] + (isPayout ? l.ownerClaimable : 0);
        if (active) {
            // Guests first during a loss (spec 4.5, 6.4; docs/adr/0009).
            if (g == 0 && other != 0) revert IEscrowErrors.LossDebtOutstanding();
            other = 0;
        }
        requested = g + other;
    }

    /// @dev Debits `paid` from the guest bucket, then the fee bucket, then the owner bucket.
    function _debit(Ledger storage l, address account, uint256 g, uint256 paid) private {
        uint256 fromGuest = Math.min(paid, g);
        l.guestClaimable[account] = g - fromGuest;
        uint256 left = paid - fromGuest;
        if (left != 0) {
            uint256 f = l.feeClaimable[account];
            uint256 fromFee = Math.min(left, f);
            l.feeClaimable[account] = f - fromFee;
            l.ownerClaimable -= left - fromFee;
        }
    }

    function _releasePendingYield(Ledger storage l, address account, bool isPayout) private {
        uint256 amount = l.pendingGuestYield[account];
        if (amount != 0) {
            l.pendingGuestYield[account] = 0;
            l.guestClaimable[account] += amount;
        }
        uint256 owner = isPayout ? l.pendingOwnerYield : 0;
        if (owner != 0) {
            l.pendingOwnerYield = 0;
            l.ownerClaimable += owner;
            amount += owner;
        }
        if (amount != 0) {
            l.totalPendingYield -= amount;
            l.totalClaimable += amount;
            emit IEscrowEvents.PendingYieldReleased(account, amount);
        }
    }

    /// @notice How much to pull from the vault to pay `amount`, and how much can be paid. Views only.
    function planPull(IERC20 usdc, IERC4626 vault, uint256 amount)
        internal
        view
        returns (uint256 pull, uint256 available)
    {
        uint256 idle = usdc.balanceOf(address(this));
        if (idle < amount && address(vault) != address(0)) {
            pull = Math.min(amount - idle, vault.maxWithdraw(address(this)));
        }
        available = Math.min(amount, idle + pull);
    }

    /// @dev The receiver and owner are always the escrow itself (CLAUDE.md money rule 3).
    function pullFromVault(IERC4626 vault, uint256 pull) public {
        if (pull != 0) {
            emit IEscrowEvents.Redeemed(pull);
            vault.withdraw(pull, address(this), address(this));
        }
    }

    // ------------------------------------------------------------------------------------------
    // Deployment (spec 6.3)

    /// @notice Deposits `assets` into the vault. Reverts, each with its own error, unless after the
    /// move: no loss is active, idle >= MIN_BUFFER_BPS of liabilities, and deployed <= maxDeployBps
    /// of liabilities.
    function deploy(Ledger storage l, IERC20 usdc, IERC4626 vault, uint256 assets, uint16 maxDeployBps)
        external
    {
        if (address(vault) == address(0)) revert IEscrowErrors.NoVault();
        if (assets == 0) revert IEscrowErrors.ZeroAmount();
        if (l.lossDebt != 0) revert IEscrowErrors.LossDebtOutstanding();
        if (l.shortfallSince != 0) revert IEscrowErrors.ShortfallPending();
        uint256 liabilities = l.totalOpenPrincipal + l.totalDisputed + l.totalPendingYield + l.totalClaimable;
        uint256 idle = usdc.balanceOf(address(this));
        if (assets > idle || idle - assets < Math.mulDiv(liabilities, Params.MIN_BUFFER_BPS, Params.BPS)) {
            revert IEscrowErrors.BufferBreached();
        }
        uint256 deployed = vault.previewRedeem(vault.balanceOf(address(this)));
        if (deployed + assets > Math.mulDiv(liabilities, maxDeployBps, Params.BPS)) {
            revert IEscrowErrors.DeployCapExceeded();
        }
        emit IEscrowEvents.Deployed(assets);
        usdc.forceApprove(address(vault), assets);
        // A vault can round a small deposit to zero shares at a high share price; never give assets away.
        if (vault.deposit(assets, address(this)) == 0) revert IEscrowErrors.VaultMintedNoShares();
    }

    // ------------------------------------------------------------------------------------------
    // Loss (spec 6.4)

    /// @notice Books a shortfall observed for at least LOSS_CONFIRMATION_WINDOW. Absorbed by the
    /// reserve, then the owner (claim bucket, then deferred owner yield), then lossDebt.
    function recogniseLoss(Ledger storage l, IERC20 usdc, IERC4626 vault) external {
        uint40 since = l.shortfallSince;
        if (since == 0) revert IEscrowErrors.NoLossToRecognise();
        if (block.timestamp < uint256(since) + Params.LOSS_CONFIRMATION_WINDOW) {
            revert IEscrowErrors.LossWindowOpen();
        }
        uint256 assets = totalAssets(usdc, vault);
        uint256 loss = l.lastAssets - assets;
        l.lastAssets = assets;
        l.shortfallSince = 0;

        uint256 fromReserve = Math.min(loss, l.reserve);
        l.reserve -= fromReserve;
        uint256 rest = loss - fromReserve;

        uint256 fromOwner = Math.min(rest, l.ownerClaimable);
        l.ownerClaimable -= fromOwner;
        l.totalClaimable -= fromOwner;
        rest -= fromOwner;

        uint256 fromOwnerPending = Math.min(rest, l.pendingOwnerYield);
        l.pendingOwnerYield -= fromOwnerPending;
        l.totalPendingYield -= fromOwnerPending;
        rest -= fromOwnerPending;

        l.lossDebt += rest;
        emit IEscrowEvents.LossRecognised(loss, fromReserve, fromOwner + fromOwnerPending, rest);
    }

    // ------------------------------------------------------------------------------------------
    // Reserve (spec 6.5)

    /// @notice Pays a confirmed reserve withdrawal to `payout`. Blocked while a loss is active.
    function withdrawReserve(
        Ledger storage l,
        IERC20 usdc,
        IERC4626 vault,
        uint256 amount,
        uint8 reasonCode,
        address payout
    ) external {
        if (amount == 0 || amount != l.pendingReserveWithdrawal || reasonCode != l.pendingReserveReason) {
            revert IEscrowErrors.ReserveProposalMismatch();
        }
        if (l.lossDebt != 0) revert IEscrowErrors.LossDebtOutstanding();
        if (l.shortfallSince != 0) revert IEscrowErrors.ShortfallPending();
        if (amount > l.reserve) revert IEscrowErrors.ReserveInsufficient();
        (uint256 pull, uint256 available) = planPull(usdc, vault, amount);
        if (available < amount) revert IEscrowErrors.ReserveInsufficient();

        l.pendingReserveWithdrawal = 0;
        l.pendingReserveReason = 0;
        l.reserve -= amount;
        l.lastAssets -= amount;
        emit IEscrowEvents.ReserveWithdrawn(amount, reasonCode);
        pullFromVault(vault, pull);
        usdc.safeTransfer(payout, amount);
    }
}
