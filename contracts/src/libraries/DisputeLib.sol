// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEscrowEvents, Booking, BookingState, Dispute} from "../interfaces/IEscrow.sol";
import {Ledger, LedgerLib} from "./LedgerLib.sol";
import {SettlementLib} from "./SettlementLib.sol";
import {Params} from "./Params.sol";

/// @notice Disputes (spec 7; docs/adr/0011). External, linked into the Escrow implementation and run
/// by DELEGATECALL, like LedgerLib. The Escrow wrapper checks roles, state and time; this library
/// does the accounting. It keeps the books identity exact:
///   open:    -principal open, +contested disputed, +uncontested claimable, y: unallocated -> pending
///   resolve: -contested disputed, +contested claimable, y: pending -> claimable (or attributed
///            pending while lossDebt > 0)
library DisputeLib {
    /// @notice Crystallises the booking's yield into pending, moves the contested amount into
    /// `totalDisputed`, and settles the uncontested remainder as a delivered stay (refund 0, fee on it).
    function open(
        Ledger storage l,
        Booking storage b,
        Dispute storage d,
        bytes32 bookingId,
        uint256 contestedAtomic,
        bytes32 evidenceHash,
        address feeTo
    ) external {
        uint256 principal = b.principalAtomic;
        uint256 y = Math.mulDiv(principal, l.accYieldPerUnit - b.accAtDeposit, 1e18);
        l.yieldUnallocated -= y;
        l.totalPendingYield += y; // whole booking's yield waits for the resolution (spec 7)
        l.totalOpenPrincipal -= principal;
        l.totalDisputed += contestedAtomic;

        uint256 uncontested = principal - contestedAtomic;
        uint256 fee = Math.mulDiv(uncontested, b.feeBps, Params.BPS); // rounds down
        uint256 ownerPrincipal = uncontested - fee;
        l.ownerClaimable += ownerPrincipal;
        l.feeClaimable[feeTo] += fee;
        l.totalClaimable += uncontested;

        b.state = BookingState.DISPUTED;
        d.contestedAtomic = contestedAtomic;
        d.yieldAtomic = y;
        d.openedAt = uint40(block.timestamp);
        d.frozenAtOpen = b.frozenTotal;

        emit IEscrowEvents.DisputeOpened(
            bookingId, contestedAtomic, evidenceHash, ownerPrincipal, fee, y, feeTo
        );
    }

    /// @notice Settles the contested amount: `guestBps` of it to the guest (rounded up), the rest to
    /// the owner bucket with the fee on what the owner retains. Yield vests only if guestBps == 0
    /// (spec 4.4, D3). No recipient parameter: credits go to the stored guest and the owner bucket.
    function resolve(
        Ledger storage l,
        Booking storage b,
        Dispute storage d,
        bytes32 bookingId,
        uint16 guestBps,
        uint8 reasonCode,
        address feeTo
    ) external {
        uint256 contested = d.contestedAtomic;
        uint256 y = d.yieldAtomic;
        SettlementLib.Figures memory f =
            SettlementLib.compute(contested, guestBps, b.feeBps, y, b.guestYieldBps, guestBps == 0);

        b.state = BookingState.SETTLED;
        address guest = b.guest;
        l.totalDisputed -= contested;
        l.guestClaimable[guest] += f.refund;
        l.ownerClaimable += f.ownerPrincipal;
        l.feeClaimable[feeTo] += f.fee;
        l.totalClaimable += contested;

        if (!LedgerLib.lossActive(l)) {
            // docs/adr/0015 §4
            l.totalPendingYield -= y;
            l.guestClaimable[guest] += f.guestYield;
            l.ownerClaimable += f.ownerYield;
            l.totalClaimable += y;
        } else {
            // Stays in totalPendingYield, now attributed; released on claim once the debt clears.
            l.pendingGuestYield[guest] += f.guestYield;
            l.pendingOwnerYield += f.ownerYield;
            emit IEscrowEvents.YieldDeferred(bookingId, f.guestYield, f.ownerYield);
        }
        _emitResolved(bookingId, guestBps, reasonCode, f, y, feeTo);
    }

    function _emitResolved(
        bytes32 bookingId,
        uint16 guestBps,
        uint8 reasonCode,
        SettlementLib.Figures memory f,
        uint256 y,
        address feeTo
    ) private {
        emit IEscrowEvents.DisputeResolved(
            bookingId,
            guestBps,
            reasonCode,
            f.refund,
            f.ownerPrincipal,
            f.fee,
            y,
            f.guestYield,
            f.ownerYield,
            feeTo
        );
    }
}
