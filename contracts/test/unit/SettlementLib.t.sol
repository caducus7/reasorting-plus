// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {SettlementLib} from "../../src/libraries/SettlementLib.sol";

/// Brief test 1: for every settlement path, fuzzed, the three equalities of spec 4.4 hold.
contract SettlementLibTest is Test {
    function _bound(uint256 principal, uint256 refundBps, uint256 feeBps, uint256 y, uint256 gyBps)
        internal
        pure
        returns (uint256, uint256, uint256, uint256, uint256)
    {
        return (
            bound(principal, 0, 1e30), // far beyond total USDC supply
            bound(refundBps, 0, 10_000),
            bound(feeBps, 0, 2_000),
            bound(y, 0, 1e30),
            bound(gyBps, 0, 10_000)
        );
    }

    function testFuzz_equalities(uint256 p, uint256 rb, uint256 fb, uint256 y, uint256 gy, bool vested)
        public
        pure
    {
        (p, rb, fb, y, gy) = _bound(p, rb, fb, y, gy);
        SettlementLib.Figures memory f = SettlementLib.compute(p, rb, fb, y, gy, vested);
        assertEq(f.refund + f.ownerPrincipal + f.fee, p, "refund + ownerPrin + fee == principal");
        assertEq(f.guestYield + f.ownerYield, y, "guestY + ownerY == y");
        assertLe(f.fee, p - f.refund, "fee <= retained");
    }

    function testFuzz_roundingDirections(uint256 p, uint256 rb, uint256 fb, uint256 y, uint256 gy)
        public
        pure
    {
        (p, rb, fb, y, gy) = _bound(p, rb, fb, y, gy);
        SettlementLib.Figures memory f = SettlementLib.compute(p, rb, fb, y, gy, true);
        // guest refund rounds up: never below the exact share, at most 1 above it
        assertGe(f.refund * 10_000, p * rb);
        assertLt(f.refund * 10_000, p * rb + 10_000);
        // fee and guest yield round down
        assertLe(f.fee * 10_000, (p - f.refund) * fb);
        assertLe(f.guestYield * 10_000, y * gy);
    }

    /// Paths: delivered (0%, vested), guest cancel (curve, not vested), property cancel (100%, not vested).
    function testFuzz_paths(uint256 p, uint256 rb, uint256 fb, uint256 y, uint256 gy) public pure {
        (p, rb, fb, y, gy) = _bound(p, rb, fb, y, gy);
        SettlementLib.Figures memory delivered = SettlementLib.compute(p, 0, fb, y, gy, true);
        assertEq(delivered.refund, 0);
        assertEq(delivered.fee, p * fb / 10_000);

        SettlementLib.Figures memory guestCancel = SettlementLib.compute(p, rb, fb, y, gy, false);
        assertEq(guestCancel.guestYield, 0, "D3: no guest yield on cancellation");
        assertEq(guestCancel.ownerYield, y);

        SettlementLib.Figures memory propertyCancel = SettlementLib.compute(p, 10_000, fb, y, gy, false);
        assertEq(propertyCancel.refund, p, "property cancel refunds 100%");
        assertEq(propertyCancel.fee, 0);
        assertEq(propertyCancel.ownerPrincipal, 0);
        assertEq(propertyCancel.ownerYield, y, "D3: guest share to owner");
    }

    function test_knownValues() public pure {
        // 5,600 USDC, 50% refund, 5% fee
        SettlementLib.Figures memory f = SettlementLib.compute(5_600e6, 5_000, 500, 0, 5_000, false);
        assertEq(f.refund, 2_800e6);
        assertEq(f.fee, 140e6);
        assertEq(f.ownerPrincipal, 2_660e6);
        // 3 atomic units at 33.33%: refund rounds up to 1, not 0
        f = SettlementLib.compute(3, 3_333, 0, 0, 0, false);
        assertEq(f.refund, 1);
    }
}
