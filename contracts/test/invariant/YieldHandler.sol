// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {IEscrowEvents, Quote, Cutoff, BookingState} from "../../src/interfaces/IEscrow.sol";
import {MockUSDC, MockVault} from "../utils/Mocks.sol";

/// @notice Random valid sequences over bookings AND the yield machinery: vault gains, losses and
/// liquidity crunches, deploy and redeem, shortfall observation and recognition, top-ups, reserve.
/// Ghosts come from injected amounts and the spec formulas, not from contract state.
contract YieldHandler is Test {
    Escrow public immutable escrow;
    EscrowFactory public immutable factory;
    MockUSDC public immutable usdc;
    MockVault public immutable vault;
    address public immutable owner;
    address public immutable guardian;
    address public immutable rebalancer;
    uint256 public immutable signerKey;

    address[] public guests;
    bytes32[] public ids;
    mapping(bytes32 => address) public guestOf;
    mapping(bytes32 => uint256) public priceOf;
    mapping(bytes32 => uint40) public checkInOf;
    mapping(bytes32 => uint40) public checkOutOf;
    mapping(bytes32 => uint40) public cutoffOf; // single cutoff: 100% before, 0% after
    mapping(bytes32 => bool) public done;

    // ghosts
    uint256 public ghostGain; // USDC injected into the vault as yield or recovery
    uint256 public ghostYieldCrystallised; // sum of y over BookingSettled
    mapping(address => uint256) public ghostGuestCredited; // refunds + guest yield (incl. deferred)
    mapping(address => uint256) public ghostGuestPaid;
    uint256 public violations;
    string public lastViolation;
    uint256 public ownerPaidDuringLoss; // must stay 0

    uint256 internal salt;

    // path coverage counters (read in afterInvariant)
    uint256 public nDeployed;
    uint256 public nRecognised;
    uint256 public nDebtStates;
    uint256 public nSettled;
    uint256 public nDeferred;
    uint256 public nOwnerBlocked;
    uint256 public nReserveWithdrawn;

    constructor(
        Escrow e,
        EscrowFactory f,
        MockUSDC u,
        MockVault v,
        address o,
        address g,
        address r,
        uint256 key
    ) {
        escrow = e;
        factory = f;
        usdc = u;
        vault = v;
        owner = o;
        guardian = g;
        rebalancer = r;
        signerKey = key;
        for (uint256 i; i < 3; ++i) {
            guests.push(makeAddr(string.concat("yguest", vm.toString(i))));
        }
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function guestCount() external view returns (uint256) {
        return guests.length;
    }

    function _flag(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    // ------------------------------------------------------------------ bookings

    function deposit(uint256 seed, uint256 leadDays, uint256 nights, uint256 nightly) external {
        if (escrow.lossDebt() != 0 || escrow.paused()) return;
        address g = guests[seed % guests.length];
        leadDays = bound(leadDays, 2, 30);
        nights = bound(nights, 1, 7);
        nightly = bound(nightly, 100e6, 3_000e6);

        Quote memory q;
        q.resourceId = keccak256("villa");
        q.checkInUtc = uint40(block.timestamp + leadDays * 1 days);
        q.checkOutUtc = uint40(q.checkInUtc + nights * 1 days);
        q.priceAtomic = nightly * nights;
        q.feeBps = escrow.effectiveFeeBps();
        q.guestYieldBps = escrow.guestYieldBps();
        q.policyHash = keccak256("p");
        q.cutoffs = new Cutoff[](1);
        q.cutoffs[0] = Cutoff(uint40(q.checkInUtc - 1 days), 10_000);
        q.guest = g;
        q.expiresAt = uint40(block.timestamp + 15 minutes);
        q.salt = bytes32(++salt);
        if (escrow.totalOpenPrincipal() + q.priceAtomic > escrow.maxOpenPrincipalAtomic()) return;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, escrow.quoteDigest(q));
        usdc.mint(g, q.priceAtomic);
        vm.startPrank(g);
        usdc.approve(address(escrow), q.priceAtomic);
        bytes32 id = escrow.deposit(q, abi.encodePacked(r, s, v));
        vm.stopPrank();
        ids.push(id);
        guestOf[id] = g;
        priceOf[id] = q.priceAtomic;
        checkInOf[id] = q.checkInUtc;
        checkOutOf[id] = q.checkOutUtc;
        cutoffOf[id] = q.cutoffs[0].cutoffUtc;
    }

    function cancelByGuest(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        if (done[id] || escrow.getBooking(id).state != BookingState.ESCROWED) return;
        if (block.timestamp >= checkOutOf[id]) return;
        uint256 refund = block.timestamp < cutoffOf[id] ? priceOf[id] : 0; // spec 4.3, one cutoff
        vm.recordLogs();
        vm.prank(guestOf[id]);
        escrow.cancelByGuest(id);
        (, uint256 guestY) = _settledFigures();
        if (guestY != 0) _flag("guest yield on a cancellation (D3)");
        _credit(id, refund);
    }

    function settle(uint256 seed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[seed % ids.length];
        if (done[id] || escrow.getBooking(id).state != BookingState.ESCROWED) return;
        if (block.timestamp < uint256(checkOutOf[id]) + 72 hours) return;
        vm.recordLogs();
        escrow.settle(id);
        nSettled++;
        if (escrow.lossDebt() != 0) nDeferred++;
        (, uint256 guestY) = _settledFigures();
        _credit(id, guestY);
    }

    function _credit(bytes32 id, uint256 amount) internal {
        done[id] = true;
        ghostGuestCredited[guestOf[id]] += amount;
    }

    /// Reads y and guestYield from BookingSettled, and adds y to the crystallised ghost.
    function _settledFigures() internal returns (uint256 y, uint256 guestY) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IEscrowEvents.BookingSettled.selector) {
                (,,,,, y, guestY,,) = abi.decode(
                    logs[i].data,
                    (uint8, uint256, uint256, uint256, uint256, uint256, uint256, uint256, address)
                );
                ghostYieldCrystallised += y;
                return (y, guestY);
            }
        }
    }

    function claim(uint256 seed) external {
        uint256 k = seed % (guests.length + 2);
        address who = k < guests.length
            ? guests[k]
            : (k == guests.length ? escrow.payoutAddress() : factory.feeRecipient());
        bool lossActive = escrow.lossDebt() != 0 || escrow.shortfallSince() != 0;
        uint256 ownerBefore = escrow.ownerClaimable();
        uint256 feeBefore = escrow.feeClaimable(who);
        uint256 bal = usdc.balanceOf(who);
        vm.prank(who);
        try escrow.claim() returns (uint256 paid) {
            if (usdc.balanceOf(who) - bal != paid) _flag("paid != transferred");
            if (k < guests.length) ghostGuestPaid[who] += paid;
            // Guests first: no owner or fee money leaves while a loss was active before the call
            // and is still active after its accrual.
            bool stillActive = escrow.lossDebt() != 0 || escrow.shortfallSince() != 0;
            if (lossActive && stillActive) {
                if (escrow.ownerClaimable() < ownerBefore) ownerPaidDuringLoss++;
                if (escrow.feeClaimable(who) < feeBefore) ownerPaidDuringLoss++;
            }
        } catch {
            nOwnerBlocked++;
        }
    }

    // ------------------------------------------------------------------ yield machinery

    function gain(uint256 amount) external {
        amount = bound(amount, 1, 500e6);
        usdc.mint(address(vault), amount);
        ghostGain += amount;
    }

    function loss(uint256 amount) external {
        uint256 held = usdc.balanceOf(address(vault));
        if (held < 2) return;
        amount = bound(amount, 1, held / 2);
        usdc.burn(address(vault), amount);
    }

    function crunch(uint256 limit) external {
        vault.setWithdrawLimit(limit % 3 == 0 ? 0 : type(uint256).max);
    }

    /// Deploys a random fraction of the headroom the on-chain caps allow, so deploys mostly succeed.
    function deploy(uint256 amount) external {
        uint256 liabilities = escrow.totalOpenPrincipal() + escrow.totalDisputed()
            + escrow.totalPendingYield() + escrow.totalClaimable();
        uint256 idle = usdc.balanceOf(address(escrow));
        uint256 buffer = liabilities / 10;
        uint256 deployed = vault.previewRedeem(vault.balanceOf(address(escrow)));
        uint256 cap = liabilities * 9 / 10;
        if (idle <= buffer || cap <= deployed) return;
        uint256 room = idle - buffer < cap - deployed ? idle - buffer : cap - deployed;
        amount = bound(amount, 1, room);
        vm.prank(rebalancer);
        try escrow.deploy(amount) {
            nDeployed++;
        } catch {}
    }

    function redeem(uint256 amount) external {
        uint256 max = vault.maxWithdraw(address(escrow));
        if (max == 0) return;
        amount = bound(amount, 1, max);
        vm.prank(rebalancer);
        try escrow.redeem(amount) {} catch {}
    }

    function observeAndRecognise(uint256 wait) external {
        escrow.observeShortfall();
        if (wait % 2 == 0) vm.warp(block.timestamp + 6 hours);
        try escrow.recogniseLoss() {
            nRecognised++;
        } catch {}
        if (escrow.lossDebt() != 0) nDebtStates++;
    }

    function topUp(uint256 amount) external {
        escrow.observeShortfall(); // accrue first: pending gains repay debt before we read it
        uint256 debt = escrow.lossDebt();
        if (debt == 0) return;
        amount = bound(amount, 1, debt);
        usdc.mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(escrow), amount);
        escrow.topUpLoss(amount);
        vm.stopPrank();
    }

    function reserveCycle(uint256 amount, bool withdraw) external {
        amount = bound(amount, 1, 200e6);
        if (!withdraw) {
            usdc.mint(owner, amount);
            vm.startPrank(owner);
            usdc.approve(address(escrow), amount);
            escrow.fundReserve(amount);
            vm.stopPrank();
        } else {
            vm.prank(owner);
            escrow.proposeReserveWithdrawal(amount, 1);
            vm.prank(guardian);
            try escrow.confirmReserveWithdrawal(amount, 1) {
                nReserveWithdrawn++;
            } catch {}
        }
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 15 days));
    }
}
