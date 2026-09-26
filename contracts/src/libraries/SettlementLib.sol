// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Settlement maths, spec 4.4. Pure so it can be fuzzed on its own.
/// Rounding (CLAUDE.md money rule 1): guest refund rounds up; fee and yield share round down;
/// the owner takes the remainders.
library SettlementLib {
    uint256 internal constant BPS = 10_000;

    struct Figures {
        uint256 refund;
        uint256 ownerPrincipal;
        uint256 fee;
        uint256 guestYield;
        uint256 ownerYield;
    }

    /// @param principal  principal being settled
    /// @param refundBps  guest refund share of principal
    /// @param feeBps     booking's fee, applied to what the owner retains (D1)
    /// @param y          booking's realised yield
    /// @param guestYieldBps booking's guest yield share
    /// @param vested     true only for a delivered stay or a dispute resolved with guestBps == 0
    function compute(
        uint256 principal,
        uint256 refundBps,
        uint256 feeBps,
        uint256 y,
        uint256 guestYieldBps,
        bool vested
    ) internal pure returns (Figures memory f) {
        f.refund = Math.mulDiv(principal, refundBps, BPS, Math.Rounding.Ceil);
        uint256 retained = principal - f.refund;
        f.fee = Math.mulDiv(retained, feeBps, BPS); // floor; never on yield (D2)
        f.ownerPrincipal = retained - f.fee;
        if (vested) {
            f.guestYield = Math.mulDiv(y, guestYieldBps, BPS); // floor
            f.ownerYield = y - f.guestYield;
        } else {
            // INTENTIONAL: the guest's yield share goes to the owner on every non-vested outcome,
            // including cancelByProperty and disputes the guest wins (decision D3). Do not "fix".
            f.guestYield = 0;
            f.ownerYield = y;
        }
    }
}
