// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {IEscrowEvents, Quote, Cutoff, Booking, BookingState} from "../interfaces/IEscrow.sol";

/// @notice Records a new booking and emits `BookingDeposited`. External, deployed once and linked
/// into the Escrow implementation (docs/adr/0010). Runs by DELEGATECALL, so it writes the escrow's
/// storage and the event is logged from the escrow's address.
library BookingLib {
    function record(
        mapping(bytes32 => Booking) storage bookings,
        mapping(bytes32 => Cutoff[]) storage cutoffs,
        bytes32 bookingId,
        Quote calldata q,
        address bookingArbitrator,
        uint256 accAtDeposit
    ) external {
        Booking storage b = bookings[bookingId];
        b.guest = q.guest;
        b.checkInUtc = q.checkInUtc;
        b.checkOutUtc = q.checkOutUtc;
        b.feeBps = q.feeBps;
        b.state = BookingState.ESCROWED;
        b.arbitrator = bookingArbitrator;
        b.guestYieldBps = q.guestYieldBps;
        b.finalBps = q.finalBps;
        b.resourceId = q.resourceId;
        b.principalAtomic = q.priceAtomic;
        b.accAtDeposit = accAtDeposit;
        Cutoff[] storage cs = cutoffs[bookingId];
        for (uint256 i; i < q.cutoffs.length; ++i) {
            cs.push(q.cutoffs[i]);
        }
        _emitDeposited(bookingId, q, bookingArbitrator, accAtDeposit);
    }

    function _emitDeposited(
        bytes32 bookingId,
        Quote calldata q,
        address bookingArbitrator,
        uint256 accAtDeposit
    ) private {
        emit IEscrowEvents.BookingDeposited(
            bookingId,
            q.guest,
            q.resourceId,
            q.checkInUtc,
            q.checkOutUtc,
            q.priceAtomic,
            q.feeBps,
            q.guestYieldBps,
            q.policyHash,
            q.cutoffs,
            q.finalBps,
            bookingArbitrator,
            accAtDeposit
        );
    }
}
