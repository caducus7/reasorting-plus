// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {IEscrowEvents, IEscrowErrors, Quote, Cutoff} from "../../src/interfaces/IEscrow.sol";
import {MockUSDC} from "./Mocks.sol";

abstract contract EscrowTestBase is Test, IEscrowEvents, IEscrowErrors {
    uint256 internal constant T0 = 1_780_000_000; // 2026-05-28
    uint256 internal constant USDC = 1e6;
    uint256 internal constant CAP = 1_000_000 * USDC;
    uint16 internal constant FEE = 500;

    MockUSDC internal usdc;
    Escrow internal impl;
    EscrowFactory internal factory;
    Escrow internal escrow;

    address internal admin = makeAddr("factoryAdmin");
    address internal owner = makeAddr("owner");
    address internal payout = makeAddr("payout");
    address internal feeTo = makeAddr("feeRecipient");
    address internal guardian = makeAddr("guardian");
    address internal arb = makeAddr("arbitrator");
    uint256 internal signerKey;
    address internal signer;
    uint256 internal guestKey;
    address internal guest;
    uint256 internal saltNonce;

    function setUp() public virtual {
        vm.warp(T0);
        (signer, signerKey) = makeAddrAndKey("quoteSigner");
        (guest, guestKey) = makeAddrAndKey("guest");
        usdc = new MockUSDC();
        impl = new Escrow();
        factory = new EscrowFactory(admin, address(usdc), address(impl), feeTo, guardian, arb, address(0));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
    }

    /// Default: 7 nights from T0 + 60 days, 5,600 USDC, 100% / 50% / 25% at 30 / 14 / 7 days, then 0%.
    function _quote() internal returns (Quote memory q) {
        return _quoteFor(guest, uint40(T0 + 60 days), uint40(T0 + 67 days), 5_600 * USDC);
    }

    function _quoteFor(address g, uint40 checkIn, uint40 checkOut, uint256 price)
        internal
        returns (Quote memory q)
    {
        q.resourceId = keccak256("villa");
        q.checkInUtc = checkIn;
        q.checkOutUtc = checkOut;
        q.priceAtomic = price;
        q.feeBps = escrow.effectiveFeeBps();
        q.guestYieldBps = escrow.guestYieldBps();
        q.policyHash = keccak256("policy");
        q.cutoffs = new Cutoff[](3);
        q.cutoffs[0] = Cutoff(checkIn - 30 days, 10_000);
        q.cutoffs[1] = Cutoff(checkIn - 14 days, 5_000);
        q.cutoffs[2] = Cutoff(checkIn - 7 days, 2_500);
        q.finalBps = 0;
        q.guest = g;
        q.expiresAt = uint40(block.timestamp + 15 minutes);
        q.salt = bytes32(++saltNonce);
    }

    function _sign(Quote memory q) internal view returns (bytes memory) {
        return _signWith(signerKey, q);
    }

    function _signWith(uint256 key, Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, escrow.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.prank(who);
        usdc.approve(address(escrow), amount);
    }

    function _deposit(Quote memory q) internal returns (bytes32 id) {
        _fund(q.guest, q.priceAtomic);
        bytes memory sig = _sign(q);
        vm.prank(q.guest);
        id = escrow.deposit(q, sig);
    }

    /// Settlement credits to a party, independent of which bucket they sit in.
    function _claimable(address who) internal view returns (uint256) {
        return escrow.claimableOf(who);
    }
}
