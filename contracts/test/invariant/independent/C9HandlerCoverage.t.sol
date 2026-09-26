// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test, console2} from "forge-std/Test.sol";
import {C9Handler} from "./handlers/C9Handler.sol";

/// @notice Proves the C9 handler really exercises the paths the invariants rely on (a suite whose
/// actions all early-return proves nothing). Drives fresh handlers with a fixed pseudo-random
/// schedule, then requires every listed action and situation to have succeeded at least once and
/// no property violation to have been recorded.
contract C9HandlerCoverage is Test {
    string[] internal tags;

    function _step(C9Handler h, uint256 r) internal {
        uint256 a = r % 40;
        uint256 x = r >> 8;
        bool b = (r >> 200) & 1 == 1;
        if (a < 6) h.guestDeposit(x, uint8(x % 8));
        else if (a == 6) h.guestDeposit(x, uint8(x % 16));
        else if (a == 7) h.stashQuote(x);
        else if (a == 8) h.depositStashed(x);
        else if (a == 9) h.guestCancel(x, b && x % 5 == 0);
        else if (a == 10) h.openDispute(x, x >> 16, b && x % 5 == 0);
        else if (a < 13) h.claim(x);
        else if (a == 13) h.propertyCancel(x, b && x % 5 == 0);
        else if (a < 16) h.settle(x, x >> 8);
        else if (a == 16) h.arbitratorResolve(x, x >> 16, uint8(x >> 32), uint8(x >> 40));
        else if (a == 17) h.resolveByDefault(x, x >> 8);
        else if (a == 18) h.guardianFreeze(x, b && x % 5 == 0);
        else if (a == 19) h.unfreeze(x, b);
        else if (a == 20) h.guardianPause(b, x % 7 == 0);
        else if (a == 21) h.ownerConfig(uint8(x), x >> 8, x % 9 == 0);
        else if (a == 22) h.ownerFundReserve(x);
        else if (a == 23) h.ownerTopUp(x);
        else if (a == 24) h.ownerProposeReserveWithdrawal(x, uint8(x >> 64));
        else if (a == 25) h.guardianConfirmReserve(x % 7 == 0, x % 5 == 0);
        else if (a == 26) h.adminProposeFee(x, x % 9 == 0);
        else if (a == 27) h.adminProposeArbitrator(b, x % 9 == 0);
        else if (a == 28) h.adminProposeFeeRecipient(b, x % 9 == 0);
        else if (a == 29) h.rebalancerDeploy(x, x % 9 == 0);
        else if (a == 30) h.rebalancerRedeem(x, x % 9 == 0);
        else if (a == 31) h.observeShortfall(x);
        else if (a == 32) h.recogniseLoss(x);
        else if (a < 36) h.warp(x);
        else if (a == 36) h.vaultGain(x);
        else if (a == 37) h.vaultLoss(x);
        else if (a == 38) h.vaultLimit(x);
        else if (x % 3 == 0) h.toggleBlacklist(b);
        else if (x % 3 == 1) h.attackerDonate(x);
        else h.attackerProbe(x, uint8(x >> 8));
    }

    function _add(string memory t) internal {
        tags.push(t);
    }

    function test_handlerExercisesEveryPath() public {
        _add("deposit");
        _add("depositWithPermit");
        _add("ok:permitFrontRunDeposit");
        _add("cancelByGuest");
        _add("cancelByProperty");
        _add("settle");
        _add("openDispute");
        _add("resolve");
        _add("resolveByDefault");
        _add("claim");
        _add("freezeBooking");
        _add("unfreezeBooking");
        _add("pauseDeposits");
        _add("unpauseDeposits");
        _add("ownerConfig");
        _add("fundReserve");
        _add("topUpLoss");
        _add("proposeReserveWithdrawal");
        _add("confirmReserveWithdrawal");
        _add("proposeFeeBps");
        _add("proposeArbitrator");
        _add("proposeFeeRecipient");
        _add("deploy");
        _add("redeem");
        _add("observeShortfall");
        _add("recogniseLoss");
        _add("rejected:feeOrSplitMismatch");
        _add("rejected:depositDuringLossDebt");
        _add("rejected:ownerOrFeeClaimDuringLoss");
        _add("rejected:blacklistedClaim");
        _add("ok:guestClaimDuringLoss");
        _add("ok:partialClaim");
        _add("ok:pendingYieldReleased");
        _add("ok:settlementWithYield");
        _add("ok:guestYieldVested");
        _add("ok:yieldDeferred");
        _add("ok:lossFromReserve");
        _add("ok:lossFromOwner");
        _add("ok:lossToDebt");

        uint256[] memory total = new uint256[](tags.length);
        uint256 episodes = 30;
        for (uint256 e; e < episodes; e++) {
            C9Handler h = new C9Handler();
            uint256 r = uint256(keccak256(abi.encode("c9", e)));
            for (uint256 s; s < 120; s++) {
                r = uint256(keccak256(abi.encode(r)));
                _step(h, r);
            }
            h.drain();
            for (uint256 k; k < tags.length; k++) {
                total[k] += h.okCountOf(tags[k]);
            }
            _assertClean(h);
        }
        for (uint256 k; k < tags.length; k++) {
            console2.log(tags[k], total[k]);
        }
        for (uint256 k; k < tags.length; k++) {
            assertGt(total[k], 0, string.concat("path never exercised: ", tags[k]));
        }
    }

    function _assertClean(C9Handler h) internal view {
        bytes32[13] memory ks = [
            h.K_P2(),
            h.K_P3(),
            h.K_P4(),
            h.K_P5(),
            h.K_P6(),
            h.K_P7(),
            h.K_P8(),
            h.K_P9(),
            h.K_P10(),
            h.K_P11(),
            h.K_AUTH(),
            h.K_LIVE(),
            h.K_CLAIM()
        ];
        for (uint256 k; k < ks.length; k++) {
            assertEq(h.viol(ks[k]), 0, h.firstMsg(ks[k]));
        }
    }
}
