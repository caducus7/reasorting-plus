// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {Quote, Cutoff, Booking, BookingState} from "../../src/interfaces/IEscrow.sol";
import {MockUSDC} from "../utils/Mocks.sol";

/// @notice Drives the escrow through random valid sequences. Ghost accounting is computed from the
/// spec's formulas and the handler's own copy of each quote, never from contract state.
contract EscrowHandler is Test {
    Escrow public immutable escrow;
    EscrowFactory public immutable factory;
    MockUSDC public immutable usdc;
    address public immutable owner;
    address public immutable admin;
    address public immutable guardian;
    uint256 public immutable signerKey;

    address[] public guests;
    bytes32[] public ids;
    mapping(bytes32 => Quote) internal quotes; // terms as signed
    mapping(bytes32 => bool) public settled;

    // ghosts
    uint256 public ghostOpenPrincipal;
    uint256 public ghostDeposited;
    uint256 public ghostPaidOut;
    mapping(address => uint256) public ghostGuestCredited;
    mapping(address => uint256) public ghostGuestPaid;
    uint256 public violations; // any spec-formula mismatch observed inside an action
    string public lastViolation;

    uint256 internal salt;

    constructor(Escrow e, EscrowFactory f, MockUSDC u, address o, address a, address g, uint256 key) {
        escrow = e;
        factory = f;
        usdc = u;
        owner = o;
        admin = a;
        guardian = g;
        signerKey = key;
        for (uint256 i; i < 4; ++i) {
            guests.push(makeAddr(string.concat("guest", vm.toString(i))));
        }
    }

    function idCount() external view returns (uint256) {
        return ids.length;
    }

    function guestCount() external view returns (uint256) {
        return guests.length;
    }

    function quoteOf(bytes32 id) external view returns (Quote memory) {
        return quotes[id];
    }

    function _flag(string memory why) internal {
        violations++;
        lastViolation = why;
    }

    // ------------------------------------------------------------------------------------------

    function deposit(uint256 guestSeed, uint256 leadDays, uint256 nights, uint256 nightly, uint256 curveSeed)
        external
    {
        address g = guests[guestSeed % guests.length];
        leadDays = bound(leadDays, 1, 120);
        nights = bound(nights, 1, 60);
        nightly = bound(nightly, 100e6, 5_000e6);

        Quote memory q;
        q.resourceId = keccak256("villa");
        q.checkInUtc = uint40(block.timestamp + leadDays * 1 days);
        q.checkOutUtc = uint40(q.checkInUtc + nights * 1 days - 4 hours);
        q.priceAtomic = nightly * nights;
        q.feeBps = escrow.effectiveFeeBps();
        q.guestYieldBps = escrow.guestYieldBps();
        q.policyHash = keccak256("policy");
        q.cutoffs = _curve(q.checkInUtc, curveSeed);
        q.finalBps = uint16(curveSeed % (uint256(q.cutoffs[q.cutoffs.length - 1].refundBps) + 1));
        q.guest = g;
        q.expiresAt = uint40(block.timestamp + 15 minutes);
        q.salt = bytes32(++salt);

        if (escrow.totalOpenPrincipal() + q.priceAtomic > escrow.maxOpenPrincipalAtomic()) return;
        if (escrow.paused()) return;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, escrow.quoteDigest(q));
        usdc.mint(g, q.priceAtomic);
        vm.startPrank(g);
        usdc.approve(address(escrow), q.priceAtomic);
        bytes32 id = escrow.deposit(q, abi.encodePacked(r, s, v));
        vm.stopPrank();

        _remember(id, q);
        ids.push(id);
        ghostOpenPrincipal += q.priceAtomic;
        ghostDeposited += q.priceAtomic;
    }

    function _remember(bytes32 id, Quote memory q) internal {
        Quote storage s = quotes[id];
        s.resourceId = q.resourceId;
        s.checkInUtc = q.checkInUtc;
        s.checkOutUtc = q.checkOutUtc;
        s.priceAtomic = q.priceAtomic;
        s.feeBps = q.feeBps;
        s.guestYieldBps = q.guestYieldBps;
        s.policyHash = q.policyHash;
        for (uint256 i; i < q.cutoffs.length; ++i) {
            s.cutoffs.push(q.cutoffs[i]);
        }
        s.finalBps = q.finalBps;
        s.guest = q.guest;
        s.expiresAt = q.expiresAt;
        s.salt = q.salt;
    }

    /// 1..4 cutoffs, strictly increasing, refund non-increasing, all before check-in.
    function _curve(uint40 checkIn, uint256 seed) internal view returns (Cutoff[] memory cs) {
        uint256 n = 1 + seed % 4;
        cs = new Cutoff[](n);
        uint256 span = checkIn - block.timestamp; // > 0
        uint16 bps = 10_000;
        for (uint256 i; i < n; ++i) {
            // spread cutoffs over [now - 1 day, checkIn)
            uint256 t = block.timestamp - 1 days + ((i + 1) * (span + 1 days)) / (n + 1);
            if (t >= checkIn) t = checkIn - 1;
            if (i > 0 && t <= cs[i - 1].cutoffUtc) t = cs[i - 1].cutoffUtc + 1;
            bps = uint16(bps - (uint256(keccak256(abi.encode(seed, i))) % (uint256(bps) + 1)) / 2);
            cs[i] = Cutoff(uint40(t), bps);
        }
    }

    function cancelByGuest(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        Quote storage q = quotes[id];
        if (settled[id] || escrow.getBooking(id).state != BookingState.ESCROWED) return;
        if (block.timestamp >= q.checkOutUtc) return;

        uint256 expectedBps = _specRefundBps(q, block.timestamp);
        uint256 expected = (q.priceAtomic * expectedBps + 9_999) / 10_000; // ceil, spec 4.4
        uint256 before = escrow.guestClaimable(q.guest);
        vm.prank(q.guest);
        escrow.cancelByGuest(id);
        if (escrow.guestClaimable(q.guest) - before != expected) _flag("guest refund != spec formula");
        _settled(id, q.guest, expected);
    }

    function cancelByProperty(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        Quote storage q = quotes[id];
        if (settled[id] || escrow.getBooking(id).state != BookingState.ESCROWED) return;
        if (block.timestamp >= q.checkInUtc) return;
        uint256 before = escrow.guestClaimable(q.guest);
        vm.prank(owner);
        escrow.cancelByProperty(id);
        if (escrow.guestClaimable(q.guest) - before != q.priceAtomic) {
            _flag("property cancel refund != 100%");
        }
        _settled(id, q.guest, q.priceAtomic);
    }

    function settle(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        Quote storage q = quotes[id];
        if (settled[id] || escrow.getBooking(id).state != BookingState.ESCROWED) return;
        if (block.timestamp < uint256(q.checkOutUtc) + 72 hours) return;
        uint256 feeBefore = escrow.feeClaimable(factory.feeRecipient());
        escrow.settle(id);
        uint256 fee = q.priceAtomic * q.feeBps / 10_000;
        if (escrow.feeClaimable(factory.feeRecipient()) - feeBefore != fee) _flag("fee != feeBps of price");
        _settled(id, q.guest, 0);
    }

    function _settled(bytes32 id, address g, uint256 guestCredit) internal {
        settled[id] = true;
        ghostOpenPrincipal -= quotes[id].priceAtomic;
        ghostGuestCredited[g] += guestCredit;
    }

    function claim(uint256 actorSeed) external {
        uint256 k = actorSeed % (guests.length + 2);
        address who = k < guests.length
            ? guests[k]
            : (k == guests.length ? escrow.payoutAddress() : factory.feeRecipient());
        uint256 bal = usdc.balanceOf(who);
        uint256 guestPart = escrow.guestClaimable(who);
        vm.prank(who);
        uint256 paid = escrow.claim();
        if (usdc.balanceOf(who) - bal != paid) _flag("claim paid != transferred");
        ghostPaidOut += paid;
        if (k < guests.length) ghostGuestPaid[who] += paid < guestPart ? paid : guestPart;
    }

    function freeze(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        Booking memory b = escrow.getBooking(id);
        if (b.state != BookingState.ESCROWED || b.frozenTotal >= 30 days) return;
        vm.prank(guardian);
        escrow.freezeBooking(id);
    }

    function unfreeze(uint256 idSeed) external {
        if (ids.length == 0) return;
        bytes32 id = ids[idSeed % ids.length];
        if (escrow.getBooking(id).state != BookingState.FROZEN) return;
        vm.prank(guardian);
        escrow.unfreezeBooking(id);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 minutes, 20 days));
    }

    /// Owner and admin reconfigure; none of it may touch existing bookings.
    function reconfigure(uint256 seed) external {
        uint256 k = seed % 5;
        if (k == 0) {
            vm.prank(owner);
            escrow.setGuestYieldBps(uint16(seed % 10_001));
        } else if (k == 1) {
            vm.prank(owner);
            escrow.setMinNightlyAtomic(bound(seed, 1, 100e6));
        } else if (k == 2) {
            vm.prank(owner);
            escrow.setPayoutAddress(makeAddr(string.concat("payout", vm.toString(seed % 3))));
        } else if (k == 3) {
            vm.prank(admin);
            escrow.proposeFeeBps(uint16(seed % 2_001));
        } else {
            vm.prank(admin);
            escrow.proposeArbitrator(makeAddr(string.concat("arb", vm.toString(seed % 3))));
        }
    }

    /// Spec 4.3, from the handler's copy of the signed quote.
    function _specRefundBps(Quote storage q, uint256 t) internal view returns (uint256) {
        if (t >= q.checkInUtc) return q.finalBps;
        for (uint256 i; i < q.cutoffs.length; ++i) {
            if (t < q.cutoffs[i].cutoffUtc) return q.cutoffs[i].refundBps;
        }
        return q.finalBps;
    }
}
