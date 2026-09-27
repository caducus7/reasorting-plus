// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test, Vm} from "forge-std/Test.sol";
import {C9Handler} from "../invariant/independent/handlers/C9Handler.sol";
import {IEscrowViews} from "../invariant/independent/C9Base.sol";

/// @notice C9 handler that tapes every log the escrow emits on a successful call, with the call's
/// timestamp, so the indexer's ledger projection (C6) can be replayed against the contract's own
/// accounting fields. Test-only; the handler's behaviour is unchanged.
contract C9TapeHandler is C9Handler {
    bytes[] internal tTopics;
    bytes[] internal tData;
    uint256[] internal tTx;
    uint256[] internal tTs;
    uint256 internal txN;

    function _call(address caller, bytes memory data)
        internal
        override
        returns (bool ok, bytes memory ret, Vm.Log[] memory logs)
    {
        (ok, ret, logs) = super._call(caller, data);
        if (!ok) return (ok, ret, logs);
        txN++;
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != escAddr) continue;
            tTopics.push(abi.encodePacked(logs[i].topics));
            tData.push(logs[i].data);
            tTx.push(txN);
            tTs.push(block.timestamp);
        }
    }

    function tapeLength() external view returns (uint256) {
        return tTx.length;
    }

    function tape()
        external
        view
        returns (bytes[] memory, bytes[] memory, uint256[] memory, uint256[] memory)
    {
        return (tTopics, tData, tTx, tTs);
    }
}

/// @notice Brief C6 test 3 input: fuzzed event sequences from the C9 handlers, with the contract's
/// accounting fields snapshotted along the way. Writes JSON fixtures for
/// services/apps/indexer/test/ledger.fixtures.test.ts when WRITE_LEDGER_FIXTURES=1:
///   WRITE_LEDGER_FIXTURES=1 forge test --match-path test/indexer/LedgerTape.t.sol
contract LedgerTapeTest is Test {
    uint256 internal constant EPISODES = 12;
    uint256 internal constant STEPS = 120;
    uint256 internal constant SNAP_EVERY = 10;
    string internal constant DIR = "../services/apps/indexer/test/fixtures/";

    // snapshot columns
    string[12] internal FIELDS = [
        "totalOpenPrincipal",
        "totalDisputed",
        "totalPendingYield",
        "totalClaimable",
        "reserve",
        "lossDebt",
        "accYieldPerUnit",
        "lastAssets",
        "yieldUnallocated",
        "ownerClaimable",
        "pendingOwnerYield",
        "shortfallSince"
    ];

    address[] internal accts;
    uint256[] internal snapAt;
    uint256[][12] internal cols;
    uint256[] internal gCl;
    uint256[] internal fCl;
    uint256[] internal pG;

    /// Same action schedule as C9HandlerCoverage._step, so the tape covers every path it proves.
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

    function _snap(C9TapeHandler h) internal {
        IEscrowViews e = IEscrowViews(h.escrowAddr());
        snapAt.push(h.tapeLength());
        cols[0].push(e.totalOpenPrincipal());
        cols[1].push(e.totalDisputed());
        cols[2].push(e.totalPendingYield());
        cols[3].push(e.totalClaimable());
        cols[4].push(e.reserve());
        cols[5].push(e.lossDebt());
        cols[6].push(e.accYieldPerUnit());
        cols[7].push(e.lastAssets());
        cols[8].push(e.yieldUnallocated());
        cols[9].push(e.ownerClaimable());
        cols[10].push(e.pendingOwnerYield());
        cols[11].push(e.shortfallSince());
        for (uint256 i; i < accts.length; i++) {
            gCl.push(e.guestClaimable(accts[i]));
            fCl.push(e.feeClaimable(accts[i]));
            pG.push(e.pendingGuestYield(accts[i]));
        }
    }

    function _reset() internal {
        delete accts;
        delete snapAt;
        for (uint256 k; k < 12; k++) {
            delete cols[k];
        }
        delete gCl;
        delete fCl;
        delete pG;
    }

    function test_tapeEpisodes() public {
        bool write = vm.envOr("WRITE_LEDGER_FIXTURES", false);
        uint256 totalLogs;
        for (uint256 ep; ep < EPISODES; ep++) {
            _reset();
            C9TapeHandler h = new C9TapeHandler();
            for (uint256 i; i < 4; i++) {
                accts.push(h.guestAt(i));
            }
            (address p1, address p2, address f1, address f2,, address atk) = h.roles();
            accts.push(p1);
            accts.push(p2);
            accts.push(f1);
            accts.push(f2);
            accts.push(atk);

            h.ownerFundReserve(1e6);
            uint256 r = uint256(keccak256(abi.encode("c6-ledger", ep)));
            for (uint256 s; s < STEPS; s++) {
                r = uint256(keccak256(abi.encode(r)));
                _step(h, r);
                if ((s + 1) % SNAP_EVERY == 0) _snap(h);
            }
            h.drain();
            _snap(h);
            totalLogs += h.tapeLength();
            if (write) _write(h, ep);
        }
        assertGt(totalLogs, EPISODES * 50, "the tape is not trivially short");
    }

    function _write(C9TapeHandler h, uint256 ep) internal {
        string memory o = string.concat("ep", vm.toString(ep));
        (bytes[] memory topics, bytes[] memory data, uint256[] memory txs, uint256[] memory ts) = h.tape();
        vm.serializeAddress(o, "escrow", h.escrowAddr());
        vm.serializeAddress(o, "vault", h.vaultAddr());
        vm.serializeAddress(o, "accounts", accts);
        vm.serializeBytes(o, "topics", topics);
        vm.serializeBytes(o, "data", data);
        vm.serializeUint(o, "tx", txs);
        vm.serializeUint(o, "ts", ts);
        vm.serializeUint(o, "snapAt", snapAt);
        for (uint256 k; k < 12; k++) {
            vm.serializeUint(o, FIELDS[k], cols[k]);
        }
        vm.serializeUint(o, "guestClaimable", gCl);
        vm.serializeUint(o, "feeClaimable", fCl);
        string memory json = vm.serializeUint(o, "pendingGuestYield", pG);
        vm.writeJson(json, string.concat(DIR, "ledger-", vm.toString(ep), ".json"));
    }
}
