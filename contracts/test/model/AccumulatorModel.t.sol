// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";

/// @notice Executable model of spec 6.1 / 6.4 accounting, used to decide review 0001 findings 1 and 2
/// (docs/adr/0009). Not production code: C2 implements the chosen rule in Escrow and must keep
/// these properties.
///
/// Liabilities L = principal + yield credited. Assets move by deposits, gains and dips. A dip is
/// only recognised as a loss after the confirmation window (`recognise`).
contract AccumulatorModel {
    bool public immutable highWaterMark; // false = spec 6.1 pseudocode as written

    uint256 public assets;
    uint256 public lastAssets;
    uint256 public principal;
    uint256 public yieldCredited;
    uint256 public lossDebt;
    uint256 public ownerClaimable; // what the owner could withdraw
    bool public shortfallObserved;

    constructor(bool hwm) {
        highWaterMark = hwm;
    }

    function liabilities() public view returns (uint256) {
        return principal + yieldCredited;
    }

    /// Unrecognised shortfall: assets below the accounting baseline, not yet booked as a loss.
    function shortfall() public view returns (uint256) {
        return lastAssets > assets ? lastAssets - assets : 0;
    }

    function deposit(uint256 x) external {
        accrue();
        assets += x;
        principal += x;
        lastAssets += x;
    }

    function gain(uint256 x) external {
        assets += x;
    }

    function dip(uint256 x) external {
        assets -= x;
    }

    function accrue() public {
        if (assets > lastAssets) {
            uint256 delta = assets - lastAssets;
            uint256 repay = delta < lossDebt ? delta : lossDebt;
            lossDebt -= repay;
            delta -= repay;
            // Owner's share of distributed yield is what the owner could claim; the split does not
            // matter for solvency, so all of it is modelled as owner-claimable.
            yieldCredited += delta;
            ownerClaimable += delta;
            lastAssets = assets;
            shortfallObserved = false;
        } else if (assets < lastAssets) {
            if (highWaterMark) {
                // Default (ADR 0009): keep the baseline; the dip is an unrecognised shortfall.
                shortfallObserved = true;
            } else {
                // Spec 6.1 as written: `lastAssets = assets` unconditionally.
                lastAssets = assets;
            }
        }
    }

    /// After the confirmation window: book the shortfall as a loss (spec 6.4, absorbed into lossDebt
    /// here; reserve and owner absorption reduce liabilities the same way).
    function recognise() external {
        uint256 s = shortfall();
        lossDebt += s;
        lastAssets = assets;
        shortfallObserved = false;
    }

    /// Owner withdraws its claimable yield. Default (ADR 0009): refused while a shortfall is observed
    /// or lossDebt > 0.
    function ownerClaim() external returns (uint256 paid) {
        accrue();
        if (highWaterMark && (shortfallObserved || lossDebt != 0)) return 0;
        paid = ownerClaimable < assets ? ownerClaimable : assets;
        ownerClaimable -= paid;
        yieldCredited -= paid;
        assets -= paid;
        lastAssets -= paid;
    }
}

contract AccumulatorModelTest is Test {
    uint256 constant P = 10_000e6;

    /// Finding 1, reproduced on the spec's pseudocode: a 100-unit dip that fully recovers is paid out
    /// as 100 of yield, leaving the escrow permanently 100 short.
    function test_specAsWritten_dipThenRecoveryCreatesPhantomYield() public {
        AccumulatorModel m = new AccumulatorModel(false);
        m.deposit(P);
        m.dip(100e6);
        m.accrue();
        m.gain(100e6); // recovery, not a real gain
        m.accrue();
        assertEq(m.yieldCredited(), 100e6, "recovery credited as yield");
        assertEq(m.assets(), P);
        assertLt(m.assets(), m.liabilities(), "insolvent by the phantom amount");
    }

    /// Same sequence under the default: no yield is credited and the books balance.
    function test_default_dipThenRecoveryCreditsNothing() public {
        AccumulatorModel m = new AccumulatorModel(true);
        m.deposit(P);
        m.dip(100e6);
        m.accrue();
        assertEq(m.shortfall(), 100e6);
        m.gain(100e6);
        m.accrue();
        assertEq(m.yieldCredited(), 0);
        assertEq(m.assets(), m.liabilities());
        m.gain(7e6); // a real gain above the high-water mark is still distributed
        m.accrue();
        assertEq(m.yieldCredited(), 7e6);
    }

    /// Finding 2, reproduced: under the spec, the owner drains during the window before recognition.
    function test_specAsWritten_ownerDrainsDuringWindow() public {
        AccumulatorModel m = new AccumulatorModel(false);
        m.deposit(P);
        m.gain(500e6);
        m.accrue(); // 500 credited to owner
        m.dip(1_000e6); // loss observed, window running
        assertEq(m.ownerClaim(), 500e6, "owner paid while guests are exposed");
        assertLt(m.assets(), m.principal(), "guest principal no longer covered");
    }

    function test_default_ownerBlockedDuringWindowAndDebt() public {
        AccumulatorModel m = new AccumulatorModel(true);
        m.deposit(P);
        m.gain(500e6);
        m.accrue();
        m.dip(1_000e6);
        assertEq(m.ownerClaim(), 0, "blocked while shortfall observed");
        m.recognise();
        assertEq(m.lossDebt(), 1_000e6);
        assertEq(m.ownerClaim(), 0, "blocked while lossDebt > 0");
        m.gain(1_000e6); // recovery repays lossDebt first
        m.accrue();
        assertEq(m.lossDebt(), 0);
        assertEq(m.yieldCredited(), 500e6, "no phantom yield from the repayment");
        assertEq(m.ownerClaim(), 500e6, "owner paid once the debt is cleared");
    }

    /// Fuzzed: under the default, assets + lossDebt + unrecognised shortfall always cover liabilities,
    /// and yield is never credited from a recovery.
    function testFuzz_default_neverPhantomYield(uint256[16] memory ops) public {
        AccumulatorModel m = new AccumulatorModel(true);
        m.deposit(P);
        uint256 externalGain; // real gains injected
        uint256 externalLoss; // real losses injected
        uint256 ownerPaid;
        for (uint256 i; i < ops.length; ++i) {
            uint256 kind = ops[i] % 6;
            uint256 amt = bound(ops[i] >> 8, 1, 2_000e6);
            if (kind == 0) {
                m.gain(amt);
                externalGain += amt;
            } else if (kind == 1) {
                amt = amt > m.assets() ? m.assets() : amt;
                m.dip(amt);
                externalLoss += amt;
            } else if (kind == 2) {
                m.accrue();
            } else if (kind == 3) {
                m.recognise();
            } else if (kind == 4) {
                ownerPaid += m.ownerClaim();
            } else {
                m.deposit(amt);
            }
            assertGe(
                m.assets() + m.lossDebt() + m.shortfall(),
                m.liabilities(),
                "solvency incl. debt and shortfall"
            );
            // Yield ever credited (still owed + already paid) never exceeds real gains net of real
            // losses, counting losses not yet absorbed (lossDebt) or not yet recognised (shortfall).
            assertLe(
                m.yieldCredited() + ownerPaid + externalLoss,
                externalGain + m.lossDebt() + m.shortfall(),
                "no phantom yield"
            );
        }
    }
}
