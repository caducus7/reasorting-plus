// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IEscrow, IEscrowErrors, Quote, Cutoff, Booking, BookingState} from "../../../src/interfaces/IEscrow.sol";
import {IEscrowFactory} from "../../../src/interfaces/IEscrowFactory.sol";
import {C9Base, IEscrowViews, IFactoryAdmin} from "./C9Base.sol";
import {C9Usdc} from "./mocks/C9Usdc.sol";

/// @notice C9 targeted adversarial scenarios (briefs/C9-independent-invariants.md). Expected values
/// come from the spec's formulas; nothing is read back from the implementation to decide what is right.
contract C9Adversarial is C9Base {
    uint256 internal saltN;

    function setUp() public virtual {
        _deployAll();
    }

    // ------------------------------------------------------------------ helpers

    function _cuts(uint40 c1, uint16 r1, uint40 c2, uint16 r2) internal pure returns (Cutoff[] memory cs) {
        cs = new Cutoff[](2);
        cs[0] = Cutoff(c1, r1);
        cs[1] = Cutoff(c2, r2);
    }

    /// 30 days out, 3 nights, cutoffs +10d (100%) and +20d (50%), finalBps 20%.
    function _std(uint256 gi, uint256 price) internal returns (Quote memory q) {
        uint40 t = uint40(block.timestamp);
        q.resourceId = keccak256("villa-crete");
        q.checkInUtc = t + 30 days;
        q.checkOutUtc = t + 33 days;
        q.priceAtomic = price;
        q.feeBps = ESCROW_FEE;
        q.guestYieldBps = 5_000;
        q.policyHash = keccak256("policy");
        q.cutoffs = _cuts(t + 10 days, 10_000, t + 20 days, 5_000);
        q.finalBps = 2_000;
        q.guest = guests[gi];
        q.expiresAt = t + 1 hours;
        q.salt = bytes32(++saltN);
    }

    function _dep(Quote memory q) internal returns (bytes32 id) {
        bytes memory sig = _signQuote(signerPk, escAddr, q);
        vm.startPrank(q.guest);
        usdc.approve(escAddr, q.priceAtomic);
        id = esc.deposit(q, sig);
        vm.stopPrank();
    }

    function _expectDepositRevert(Quote memory q, bytes memory sig, bytes4 err) internal {
        vm.startPrank(q.guest);
        usdc.approve(escAddr, q.priceAtomic);
        vm.expectRevert(err);
        esc.deposit(q, sig);
        vm.stopPrank();
    }

    /// Spec 4.4 figures for a principal, refund bps and fee.
    function _fig(uint256 p, uint256 rb, uint256 feeBps) internal pure returns (uint256 refund, uint256 fee, uint256 own) {
        refund = Math.ceilDiv(p * rb, 10_000);
        fee = (p - refund) * feeBps / 10_000;
        own = p - refund - fee;
    }

    function _claimAs(address a) internal returns (uint256) {
        vm.prank(a);
        return esc.claim();
    }

    // ------------------------------------------------------------------ spec 13 defaults, spec 4.1 hashing

    function test_defaults_spec13() public view {
        assertEq(escV.guestYieldBps(), 5_000, "guestYieldBps default");
        assertEq(escV.maxDeployBps(), 9_000, "maxDeployBps default");
        assertEq(esc.effectiveFeeBps(), ESCROW_FEE);
        assertEq(esc.effectiveArbitrator(), arbA1);
        assertEq(IEscrowFactory(address(factory)).feeRecipient(), feeR1);
        assertEq(IEscrowFactory(address(factory)).MAX_FEE_BPS(), MAX_FEE_BPS);
        assertEq(IEscrowFactory(address(factory)).FEE_CHANGE_DELAY(), FEE_DELAY);
        assertEq(IEscrowFactory(address(factory)).FEE_RECIPIENT_DELAY(), FEE_RECIPIENT_DELAY);
        assertEq(IEscrowFactory(address(factory)).ARBITRATOR_DELAY(), ARB_DELAY);
    }

    function test_approveOwnerAboveMaxFee_reverts_spec3_4() public {
        vm.prank(admin);
        vm.expectRevert(IEscrowFactory.FeeAboveMax.selector);
        IFactoryAdmin(address(factory)).approveOwner(makeAddr("o2"), MAX_FEE_BPS + 1, 0, CAP);
    }

    /// Spec 4.1: bookingId = EIP-712 hashStruct(quote); the domain binds escrow address and chain id.
    /// Computed here independently, then used to sign: an off-chain signer built from the spec interoperates.
    function test_bookingIdAndDigestMatchIndependentEIP712_spec4_1() public {
        Quote memory q = _std(0, 3_000e6);
        bytes32 hs = _hashStruct(q);
        assertEq(esc.hashQuote(q), hs, "hashQuote != spec hashStruct");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(escAddr), hs));
        assertEq(esc.quoteDigest(q), digest, "quoteDigest != spec EIP-712 digest");
        bytes memory sig = _sign(signerPk, digest);
        vm.startPrank(q.guest);
        usdc.approve(escAddr, q.priceAtomic);
        bytes32 id = esc.deposit(q, sig);
        vm.stopPrank();
        assertEq(id, hs);
    }

    // ------------------------------------------------------------------ replay (spec 4.1)

    function test_replay_quoteOnOtherEscrow_reverts_spec4_1() public {
        address owner2 = makeAddr("c9.owner2");
        vm.prank(admin);
        IFactoryAdmin(address(factory)).approveOwner(owner2, ESCROW_MAX_FEE, ESCROW_FEE, CAP);
        vm.prank(owner2);
        address esc2 = IFactoryAdmin(address(factory)).createEscrow(makeAddr("p2"), signer, MIN_NIGHTLY);

        Quote memory q = _std(0, 3_000e6);
        bytes memory sigForEsc1 = _signQuote(signerPk, escAddr, q);
        vm.startPrank(q.guest);
        usdc.approve(esc2, q.priceAtomic);
        vm.expectRevert(IEscrowErrors.InvalidQuoteSignature.selector);
        IEscrow(esc2).deposit(q, sigForEsc1);
        vm.stopPrank();

        // same quote, each escrow accepts only its own signature; both bookings are independent
        _dep(q);
        bytes memory sigForEsc2 = _signQuote(signerPk, esc2, q);
        vm.startPrank(q.guest);
        usdc.approve(esc2, q.priceAtomic);
        IEscrow(esc2).deposit(q, sigForEsc2);
        vm.expectRevert(IEscrowErrors.BookingExists.selector);
        esc.deposit(q, sigForEsc1);
        vm.stopPrank();
    }

    function test_replay_quoteOnOtherChainId_reverts_spec4_1() public {
        Quote memory q = _std(0, 3_000e6);
        bytes memory sig = _signQuote(signerPk, escAddr, q);
        bytes32 d1 = esc.quoteDigest(q);
        vm.chainId(8453);
        assertTrue(esc.quoteDigest(q) != d1, "digest must change with chain id");
        _expectDepositRevert(q, sig, IEscrowErrors.InvalidQuoteSignature.selector);
    }

    function test_depositGuards_specificErrors_spec4_2() public {
        Quote memory q = _std(0, 3_000e6);
        bytes memory sig = _signQuote(signerPk, escAddr, q);
        // guard 2: someone else submits the guest's quote
        vm.startPrank(attacker);
        usdc.approve(escAddr, q.priceAtomic);
        vm.expectRevert(IEscrowErrors.NotQuoteGuest.selector);
        esc.deposit(q, sig);
        vm.stopPrank();
        // guard 1: wrong signer
        _expectDepositRevert(q, _signQuote(attackerPk, escAddr, q), IEscrowErrors.InvalidQuoteSignature.selector);
        // guard 3: expired
        vm.warp(uint256(q.expiresAt) + 1);
        _expectDepositRevert(q, sig, IEscrowErrors.QuoteExpired.selector);
    }

    function test_depositGuards_termsAndCaps_spec4_2() public {
        Quote memory q = _std(0, 3 * MIN_NIGHTLY - 1); // guard 8
        _expectDepositRevert(q, _signQuote(signerPk, escAddr, q), IEscrowErrors.PriceBelowFloor.selector);
        q = _std(0, 3_000e6);
        q.checkOutUtc = q.checkInUtc + uint40(MAX_NIGHTS * 1 days) + 1; // 61 nights by ceilDiv, guard 7
        q.priceAtomic = MIN_NIGHTLY * 61;
        _expectDepositRevert(q, _signQuote(signerPk, escAddr, q), IEscrowErrors.InvalidNights.selector);
        q = _std(0, 3_000e6);
        q.finalBps = 5_001; // > last refundBps, guard 11
        _expectDepositRevert(q, _signQuote(signerPk, escAddr, q), IEscrowErrors.InvalidCutoffs.selector);
        q = _std(0, 3_000e6);
        q.checkInUtc = uint40(block.timestamp); // guard 6
        q.cutoffs = new Cutoff[](1);
        q.cutoffs[0] = Cutoff(uint40(block.timestamp - 1), 0);
        q.finalBps = 0;
        _expectDepositRevert(q, _signQuote(signerPk, escAddr, q), IEscrowErrors.InvalidStayTimes.selector);
    }

    function test_exactlyMaxNights_accepted_spec4_2() public {
        Quote memory q = _std(0, MIN_NIGHTLY * MAX_NIGHTS);
        q.checkOutUtc = q.checkInUtc + uint40(MAX_NIGHTS * 1 days);
        _dep(q);
    }

    // ------------------------------------------------------------------ cancellation boundaries (spec 4.3)

    function _cancelAt(bytes32 id, uint256 t) internal returns (uint256 refund, uint256 fee, uint256 own) {
        uint256 snap = vm.snapshotState();
        vm.warp(t);
        address g = esc.getBooking(id).guest;
        vm.prank(g);
        esc.cancelByGuest(id);
        refund = escV.guestClaimable(g);
        fee = escV.feeClaimable(feeR1);
        own = escV.ownerClaimable();
        vm.revertToState(snap);
    }

    function _assertCancel(bytes32 id, uint256 t, uint256 p, uint256 bps) internal {
        (uint256 r, uint256 f, uint256 o) = _cancelAt(id, t);
        (uint256 er, uint256 ef, uint256 eo) = _fig(p, bps, ESCROW_FEE);
        assertEq(r, er, "refund != spec 4.3/4.4");
        assertEq(f, ef, "fee != spec 4.4");
        assertEq(o, eo, "owner principal != spec 4.4");
    }

    function test_cancelAtEveryBoundary_spec4_3() public {
        uint256 p = 3_000e6 + 7; // odd, so the refund's round-up is visible
        Quote memory q = _std(0, p);
        bytes32 id = _dep(q);
        uint256 c1 = q.cutoffs[0].cutoffUtc;
        uint256 c2 = q.cutoffs[1].cutoffUtc;
        _assertCancel(id, c1 - 1, p, 10_000);
        _assertCancel(id, c1, p, 5_000); // "now < cutoffUtc" is strict: the boundary second is the next tier
        _assertCancel(id, c2 - 1, p, 5_000);
        _assertCancel(id, c2, p, 2_000);
        _assertCancel(id, q.checkInUtc - 1, p, 2_000);
        _assertCancel(id, q.checkInUtc, p, 2_000); // from checkIn: finalBps
        _assertCancel(id, q.checkOutUtc - 1, p, 2_000);
        vm.warp(q.checkOutUtc);
        vm.prank(q.guest);
        vm.expectRevert(IEscrowErrors.NotCancellable.selector);
        esc.cancelByGuest(id);
    }

    /// A booking deposited in the very block its first cutoff falls: guard 11 only requires cutoffs
    /// before checkIn, so the deposit is valid and a same-block cancel gets the second tier.
    function test_depositAndCancelInCutoffBlock_spec4_3() public {
        uint256 p = 3_000e6 + 1;
        Quote memory q = _std(1, p);
        q.cutoffs[0].cutoffUtc = uint40(block.timestamp);
        bytes32 id = _dep(q);
        vm.prank(q.guest);
        esc.cancelByGuest(id);
        (uint256 er,,) = _fig(p, 5_000, ESCROW_FEE);
        assertEq(escV.guestClaimable(q.guest), er);
    }

    function test_cancelByProperty_boundary_spec3_5() public {
        uint256 p = 3_000e6 + 3;
        Quote memory q = _std(0, p);
        bytes32 id = _dep(q);
        vm.prank(attacker);
        vm.expectRevert();
        esc.cancelByProperty(id);
        uint256 snap = vm.snapshotState();
        vm.warp(q.checkInUtc);
        vm.prank(escOwner);
        vm.expectRevert(IEscrowErrors.PropertyCancelTooLate.selector);
        esc.cancelByProperty(id);
        vm.revertToState(snap);
        vm.warp(q.checkInUtc - 1);
        vm.prank(escOwner);
        esc.cancelByProperty(id);
        assertEq(escV.guestClaimable(q.guest), p, "cancelByProperty refunds 100%");
        assertEq(escV.ownerClaimable() + escV.feeClaimable(feeR1), 0);
    }

    // ------------------------------------------------------------------ fee change timing (spec 3.4, 4.2, 5.2)

    function test_quoteSignedJustBeforeFeeChange_spec4_2() public {
        vm.prank(admin);
        esc.proposeFeeBps(800);
        uint256 eff = block.timestamp + FEE_DELAY;
        vm.warp(eff - 1);
        Quote memory oldFee = _std(0, 3_000e6);
        oldFee.expiresAt = uint40(eff + 1 hours); // straddles the change (5.2 would cap it; the chain must not rely on that)
        Quote memory newFee = _std(1, 3_000e6);
        newFee.feeBps = 800;
        bytes memory sigNew = _signQuote(signerPk, escAddr, newFee);
        _expectDepositRevert(newFee, sigNew, IEscrowErrors.FeeMismatch.selector);
        Quote memory oldFee2 = _std(2, 3_000e6);
        oldFee2.expiresAt = uint40(eff + 1 hours);
        bytes memory sigOld2 = _signQuote(signerPk, escAddr, oldFee2);

        bytes32 id = _dep(oldFee); // at eff - 1: the old fee is still live
        assertEq(esc.getBooking(id).feeBps, ESCROW_FEE);

        vm.warp(eff); // the new fee is effective from this second
        assertEq(esc.effectiveFeeBps(), 800);
        _expectDepositRevert(oldFee2, sigOld2, IEscrowErrors.FeeMismatch.selector);
        vm.startPrank(newFee.guest);
        esc.deposit(newFee, sigNew);
        vm.stopPrank();

        // the old booking settles at its locked fee (spec 2 term locking)
        vm.warp(uint256(oldFee.checkOutUtc) + GRACE);
        esc.settle(id);
        (,, uint256 own) = _fig(3_000e6, 0, ESCROW_FEE);
        assertEq(escV.feeClaimable(feeR1), 3_000e6 - own, "settled with the locked fee");
    }

    function test_quoteWithStaleGuestYieldBps_reverts_spec4_2() public {
        Quote memory q = _std(0, 3_000e6);
        bytes memory sig = _signQuote(signerPk, escAddr, q);
        vm.prank(escOwner);
        esc.setGuestYieldBps(4_000);
        _expectDepositRevert(q, sig, IEscrowErrors.GuestYieldMismatch.selector);
    }

    function test_proposeFeeAboveEscrowMax_reverts_spec3_4() public {
        vm.prank(admin);
        vm.expectRevert(IEscrowErrors.FeeAboveMax.selector);
        esc.proposeFeeBps(ESCROW_MAX_FEE + 1);
        vm.prank(attacker);
        vm.expectRevert(IEscrowErrors.NotFactoryAdmin.selector);
        esc.proposeFeeBps(0);
    }

    // ------------------------------------------------------------------ fee recipient read at settlement, arbitrator snapshot (3.4)

    function test_feeRecipientLive_arbitratorSnapshotted_spec3_4() public {
        Quote memory q = _std(0, 3_000e6);
        bytes32 idOld = _dep(q);
        vm.startPrank(admin);
        IFactoryAdmin(address(factory)).proposeFeeRecipient(feeR2);
        esc.proposeArbitrator(arbA2);
        vm.stopPrank();
        vm.warp(block.timestamp + 7 days);
        assertEq(esc.effectiveArbitrator(), arbA2);
        Quote memory q2 = _std(1, 3_000e6);
        q2.checkInUtc = q.checkInUtc; // same stay dates, so both are in their dispute window together
        q2.checkOutUtc = q.checkOutUtc;
        bytes32 idNew = _dep(q2);
        assertEq(esc.getBooking(idOld).arbitrator, arbA1, "old booking keeps its arbitrator");
        assertEq(esc.getBooking(idNew).arbitrator, arbA2, "new booking snapshots the effective arbitrator");

        // both delivered and disputed by their guests
        vm.warp(q2.checkOutUtc);
        vm.prank(q.guest);
        esc.openDispute(idOld, 1_000e6, bytes32(0));
        vm.prank(q2.guest);
        esc.openDispute(idNew, 1_000e6, bytes32(0));
        vm.prank(arbA2);
        vm.expectRevert(IEscrowErrors.NotArbitrator.selector);
        esc.resolve(idOld, 10_000, 0);
        vm.prank(arbA1);
        vm.expectRevert(IEscrowErrors.NotArbitrator.selector);
        esc.resolve(idNew, 10_000, 0);
        vm.prank(arbA1);
        esc.resolve(idOld, 0, 0);
        // the fee recipient is read at settlement: every fee here went to the new recipient
        (,, uint256 own) = _fig(3_000e6, 0, ESCROW_FEE);
        assertEq(escV.feeClaimable(feeR1), 0);
        assertGt(escV.feeClaimable(feeR2), 0);
        assertEq(escV.feeClaimable(feeR2), (3_000e6 - own) + (2_000e6 * uint256(ESCROW_FEE) / 10_000), "fees to live recipient");
    }

    // ------------------------------------------------------------------ permit front-running (spec 4.2)

    function _permitSig(uint256 gi, uint256 value, uint256 deadline) internal view returns (uint8, bytes32, bytes32) {
        bytes32 sh = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                guests[gi],
                escAddr,
                value,
                usdc.nonces(guests[gi]),
                deadline
            )
        );
        return vm.sign(guestPks[gi], keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));
    }

    function test_permitFrontRun_doesNotGriefDeposit_spec4_2() public {
        Quote memory q = _std(0, 3_000e6);
        bytes memory sig = _signQuote(signerPk, escAddr, q);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(0, q.priceAtomic, dl);
        vm.prank(attacker); // mempool watcher lands the permit first
        usdc.permit(q.guest, escAddr, q.priceAtomic, dl, v, r, s);
        uint256 before = usdc.balanceOf(q.guest);
        vm.prank(q.guest);
        bytes32 id = esc.depositWithPermit(q, sig, dl, v, r, s);
        assertEq(before - usdc.balanceOf(q.guest), q.priceAtomic);
        assertEq(uint8(esc.bookingState(id)), uint8(BookingState.ESCROWED));
    }

    function test_permitGarbage_withAllowanceSucceeds_withoutReverts_spec4_2() public {
        Quote memory q = _std(0, 3_000e6);
        bytes memory sig = _signQuote(signerPk, escAddr, q);
        vm.prank(q.guest);
        vm.expectRevert(); // no allowance: the transferFrom must fail
        esc.depositWithPermit(q, sig, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        vm.startPrank(q.guest);
        usdc.approve(escAddr, q.priceAtomic);
        esc.depositWithPermit(q, sig, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ blacklisted guest (spec 4.5)

    function test_blacklistedGuest_claimStaysPending_noRedirect_spec4_5() public {
        uint256 p = 3_000e6;
        Quote memory q = _std(0, p);
        bytes32 id = _dep(q);
        Quote memory q2 = _std(1, p);
        bytes32 id2 = _dep(q2);
        vm.prank(q.guest);
        esc.cancelByGuest(id); // 100% refund
        usdc.setBlacklisted(q.guest, true);
        vm.prank(q.guest);
        vm.expectRevert(); // the token refuses the transfer
        esc.claim();
        assertEq(escV.guestClaimable(q.guest), p, "credit kept");
        // others unaffected: the second booking settles and everyone else claims
        vm.warp(uint256(q2.checkOutUtc) + GRACE);
        esc.settle(id2);
        (, uint256 fee, uint256 own) = _fig(p, 0, ESCROW_FEE);
        assertEq(_claimAs(payout1), own + _ownerYield());
        assertEq(_claimAs(feeR1), fee);
        // once lifted, the guest is paid exactly the credit
        usdc.setBlacklisted(q.guest, false);
        assertEq(_claimAs(q.guest), p);
        assertEq(usdc.receivedFromEscrow(attacker), 0);
    }

    function _ownerYield() internal pure returns (uint256) {
        return 0; // no vault gains in this scenario
    }

    function test_blacklistedPayout_ownerRotatesAndClaims_ADR0007() public {
        Quote memory q = _std(0, 3_000e6);
        bytes32 id = _dep(q);
        vm.warp(uint256(q.checkOutUtc) + GRACE);
        esc.settle(id);
        usdc.setBlacklisted(payout1, true);
        vm.prank(payout1);
        vm.expectRevert();
        esc.claim();
        vm.prank(escOwner);
        esc.setPayoutAddress(payout2);
        (,, uint256 own) = _fig(3_000e6, 0, ESCROW_FEE);
        assertEq(_claimAs(payout2), own, "owner bucket follows the current payout address");
    }

    // ------------------------------------------------------------------ loss window boundary (spec 6.4, ADR 0009/0010)

    struct LossSetup {
        bytes32 idA;
        uint256 loss;
        uint256 t;
    }

    /// Booking A (10,000 USDC) open; booking B (1,000) cancelled with 0% refund so the owner holds
    /// 950 of credits and the fee recipient 50; reserve 100; 8,000 deployed; then a vault loss.
    function _lossSetup(uint256 burn) internal returns (LossSetup memory s) {
        Quote memory a = _std(0, 10_000e6);
        s.idA = _dep(a);
        Quote memory b = _std(1, 1_000e6);
        b.cutoffs = _cuts(uint40(block.timestamp + 1 days), 0, uint40(block.timestamp + 2 days), 0);
        b.finalBps = 0;
        bytes32 idB = _dep(b);
        vm.prank(b.guest);
        esc.cancelByGuest(idB);
        vm.startPrank(escOwner);
        usdc.approve(escAddr, 100e6);
        esc.fundReserve(100e6);
        vm.stopPrank();
        vm.prank(rebalancer);
        esc.deploy(8_000e6);
        uint256 before = _assetsOf(escAddr);
        usdc.adminBurn(address(vault), burn);
        s.loss = escV.lastAssets() - _assetsOf(escAddr);
        assertGt(before, _assetsOf(escAddr));
        esc.observeShortfall();
        s.t = block.timestamp;
        assertEq(escV.shortfallSince(), s.t, "observation starts the window");
    }

    function test_lossExactlyAtConfirmationWindowBoundary_spec6_4() public {
        LossSetup memory s = _lossSetup(189_000e6); // ~1,500 USDC of the escrow's share
        vm.warp(s.t + LOSS_WINDOW - 1);
        vm.expectRevert(IEscrowErrors.LossWindowOpen.selector);
        esc.recogniseLoss();
        vm.warp(s.t + LOSS_WINDOW);
        esc.recogniseLoss(); // "stays below for LOSS_CONFIRMATION_WINDOW": recognisable at exactly +6h
        // absorption order: reserve, owner credits, then lossDebt
        assertEq(escV.reserve(), 0);
        assertEq(escV.ownerClaimable(), 0);
        assertEq(escV.lossDebt(), s.loss - 100e6 - 950e6, "remainder booked as lossDebt");
        assertEq(escV.feeClaimable(feeR1), 50e6, "fee credits never absorb a loss");
        assertEq(escV.lastAssets(), _assetsOf(escAddr), "baseline lowered to assets");
    }

    function test_lossDebtGatesDepositsDeployOwnerAndFeeClaims_spec6_4() public {
        LossSetup memory s = _lossSetup(189_000e6);
        vm.warp(s.t + LOSS_WINDOW);
        esc.recogniseLoss();
        assertGt(escV.lossDebt(), 0);

        Quote memory q = _std(2, 1_000e6);
        _expectDepositRevert(q, _signQuote(signerPk, escAddr, q), IEscrowErrors.LossDebtOutstanding.selector);
        vm.prank(rebalancer);
        vm.expectRevert(IEscrowErrors.LossDebtOutstanding.selector);
        esc.deploy(1e6);
        vm.prank(feeR1);
        vm.expectRevert(IEscrowErrors.LossDebtOutstanding.selector);
        esc.claim();

        // guest A cancels before the first cutoff: 100% refund, paid first from idle then the vault.
        // Assets are short by lossDebt, so the guest gets everything liquid now (spec 6.4: priority,
        // not a guarantee) and the rest after the owner's top-up.
        vm.prank(guests[0]);
        esc.cancelByGuest(s.idA);
        uint256 liquid = usdc.balanceOf(escAddr) + vault.maxWithdraw(escAddr);
        uint256 first = _claimAs(guests[0]);
        assertEq(first, liquid < 10_000e6 ? liquid : 10_000e6, "guest paid min(claimable, liquid)");
        assertEq(escV.guestClaimable(guests[0]), 10_000e6 - first, "unpaid part stays credited");

        uint256 debt = escV.lossDebt();
        vm.startPrank(escOwner);
        usdc.approve(escAddr, debt);
        esc.topUpLoss(debt);
        vm.stopPrank();
        assertEq(escV.lossDebt(), 0);
        assertEq(_claimAs(guests[0]), 10_000e6 - first, "guest made whole after top-up");
        assertEq(_claimAs(feeR1), 50e6, "fee paid after the guest, never absorbed the loss");
    }

    function test_ownerClaimBlockedDuringObservedShortfall_ADR0009() public {
        LossSetup memory s = _lossSetup(189_000e6);
        assertGt(s.loss, MIN_LOSS); // window still open, nothing recognised
        vm.prank(payout1);
        vm.expectRevert(IEscrowErrors.LossDebtOutstanding.selector);
        esc.claim();
        vm.prank(feeR1);
        vm.expectRevert(IEscrowErrors.LossDebtOutstanding.selector);
        esc.claim();
        vm.prank(rebalancer);
        vm.expectRevert(IEscrowErrors.ShortfallPending.selector);
        esc.deploy(1e6);
        vm.prank(escOwner);
        try esc.proposeReserveWithdrawal(100e6, 0) {} catch {}
        vm.prank(guardian);
        vm.expectRevert(); // ADR 0009 section 3: blocked while a shortfall is observed
        esc.confirmReserveWithdrawal(100e6, 0);
    }

    function test_recoveryInsideWindow_noPhantomYield_ADR0009() public {
        LossSetup memory s = _lossSetup(189_000e6);
        uint256 accBefore = escV.accYieldPerUnit();
        usdc.mint(address(vault), 189_000e6); // the vault recovers exactly
        vm.warp(s.t + LOSS_WINDOW);
        vm.expectRevert(IEscrowErrors.NoLossToRecognise.selector);
        esc.recogniseLoss();
        assertLe(escV.accYieldPerUnit() - accBefore, 1e18 * 3 / uint256(10_000e6), "recovery paid out as yield");
    }

    function test_subThresholdLoss_neverRecognised_ADR0010() public {
        Quote memory a = _std(3, 10_000e6);
        bytes32 id = _dep(a);
        vm.prank(rebalancer);
        esc.deploy(8_000e6);
        usdc.adminBurn(address(vault), 100e6); // escrow share ~0.79 USDC
        uint256 sf = escV.lastAssets() - _assetsOf(escAddr);
        assertGt(sf, 0);
        assertLt(sf, MIN_LOSS);
        esc.observeShortfall();
        vm.warp(block.timestamp + LOSS_WINDOW + 1);
        vm.expectRevert(IEscrowErrors.NoLossToRecognise.selector);
        esc.recogniseLoss();
        // not gated: the owner can still be paid (ADR 0010 section 4 residual risk)
        vm.warp(uint256(a.checkOutUtc) + GRACE);
        esc.settle(id);
        assertGt(_claimAs(payout1), 0);
    }

    // ------------------------------------------------------------------ disputes timing (spec 7, ADR 0011)

    function test_disputeWindowAndDefault_spec7() public {
        Quote memory q = _std(0, 3_000e6);
        bytes32 id = _dep(q);
        vm.warp(q.checkOutUtc - 1);
        vm.prank(q.guest);
        vm.expectRevert(IEscrowErrors.NotDelivered.selector);
        esc.openDispute(id, 1e6, bytes32(0));
        vm.warp(q.checkOutUtc);
        vm.prank(escOwner);
        vm.expectRevert(IEscrowErrors.NotGuest.selector);
        esc.openDispute(id, 1e6, bytes32(0));
        vm.startPrank(q.guest);
        vm.expectRevert(IEscrowErrors.InvalidContested.selector);
        esc.openDispute(id, 0, bytes32(0));
        vm.expectRevert(IEscrowErrors.InvalidContested.selector);
        esc.openDispute(id, 3_000e6 + 1, bytes32(0));
        esc.openDispute(id, 1_000e6, bytes32(0));
        vm.stopPrank();
        uint256 opened = block.timestamp;
        assertEq(esc.disputeDeadline(id), opened + DISPUTE_WINDOW);

        // a freeze after opening extends the deadline by the frozen time (ADR 0011 section 3)
        vm.prank(guardian);
        esc.freezeBooking(id);
        vm.warp(block.timestamp + 2 days);
        vm.prank(guardian);
        esc.unfreezeBooking(id);
        uint256 dl = opened + DISPUTE_WINDOW + 2 days;
        assertEq(esc.disputeDeadline(id), dl);
        vm.warp(dl - 1);
        vm.expectRevert(IEscrowErrors.DisputeWindowOpen.selector);
        esc.resolveByDefault(id);
        vm.prank(arbA1);
        vm.expectRevert(IEscrowErrors.InvalidReasonCode.selector);
        esc.resolve(id, 0, 7); // DEFAULT_TIMEOUT is reserved
        vm.warp(dl);
        vm.prank(attacker);
        esc.resolveByDefault(id);
        // guestBps = 0: the owner keeps the contested amount less the fee
        (,, uint256 ownU) = _fig(2_000e6, 0, ESCROW_FEE);
        (,, uint256 ownC) = _fig(1_000e6, 0, ESCROW_FEE);
        assertEq(escV.ownerClaimable(), ownU + ownC);
        assertEq(escV.guestClaimable(q.guest), 0);
    }

    function test_openDisputeAtGraceBoundary_andSettleAtGrace_spec3_5_4_6() public {
        Quote memory q = _std(0, 3_000e6);
        bytes32 id = _dep(q);
        vm.warp(uint256(q.checkOutUtc) + GRACE - 1);
        vm.prank(attacker);
        vm.expectRevert(IEscrowErrors.SettleTooEarly.selector);
        esc.settle(id);
        vm.warp(uint256(q.checkOutUtc) + GRACE);
        vm.prank(q.guest);
        vm.expectRevert(IEscrowErrors.DisputeTooLate.selector);
        esc.openDispute(id, 1e6, bytes32(0));
        vm.prank(attacker);
        esc.settle(id); // permissionless
        assertEq(uint8(esc.bookingState(id)), uint8(BookingState.SETTLED));
    }

    /// Property 9: the booking's own arbitrator, compromised, can move only the contested amount.
    function test_compromisedArbitrator_boundedToContested_spec7() public {
        uint256 p = 3_000e6;
        Quote memory q = _std(0, p);
        bytes32 id = _dep(q);
        Quote memory q2 = _std(1, p);
        _dep(q2);
        vm.warp(q.checkOutUtc);
        vm.prank(q.guest);
        esc.openDispute(id, 500e6, bytes32(0));
        vm.prank(arbA1);
        vm.expectRevert(IEscrowErrors.BpsOutOfRange.selector);
        esc.resolve(id, 10_001, 0);
        vm.prank(arbA1);
        esc.resolve(id, 10_000, 6);
        assertEq(escV.guestClaimable(q.guest), 500e6, "guest refund bounded by contested");
        assertEq(escV.guestClaimable(q2.guest), 0, "other booking untouched");
        (,, uint256 ownU) = _fig(p - 500e6, 0, ESCROW_FEE);
        assertEq(escV.ownerClaimable(), ownU, "uncontested part settled as delivered");
        assertEq(usdc.receivedFromEscrow(arbA1), 0);
    }

    // ------------------------------------------------------------------ freeze budget (ADR 0007)

    function test_freezeBudget_anyoneUnfreezesAfter30Days_ADR0007() public {
        Quote memory q = _std(0, 3_000e6);
        bytes32 id = _dep(q);
        vm.prank(attacker);
        vm.expectRevert(IEscrowErrors.NotGuardian.selector);
        esc.freezeBooking(id);
        vm.prank(guardian);
        esc.freezeBooking(id);
        vm.prank(q.guest);
        vm.expectRevert();
        esc.cancelByGuest(id); // FROZEN halts every transition
        vm.warp(block.timestamp + MAX_FREEZE - 1);
        vm.prank(attacker);
        vm.expectRevert();
        esc.unfreezeBooking(id);
        vm.warp(block.timestamp + 1);
        vm.prank(attacker);
        esc.unfreezeBooking(id);
        vm.prank(guardian);
        vm.expectRevert(IEscrowErrors.FreezeBudgetExhausted.selector);
        esc.freezeBooking(id);
        vm.warp(uint256(q.checkOutUtc) + GRACE);
        esc.settle(id); // GRACE was not extended by the freeze
    }

    // ------------------------------------------------------------------ yield attribution (spec 6.1)

    function test_noYieldAccruedBeforeDeposit_spec6_1() public {
        Quote memory a = _std(0, 10_000e6);
        bytes32 idA = _dep(a);
        vm.prank(rebalancer);
        esc.deploy(8_000e6);
        usdc.mint(address(vault), 12_600e6); // ~100 USDC to the escrow's 8,000 of 1,008,000
        uint256 accMid;
        Quote memory b = _std(1, 10_000e6);
        bytes32 idB = _dep(b); // accrues the gain first, over A only
        accMid = escV.accYieldPerUnit();
        assertEq(esc.getBooking(idB).accAtDeposit, accMid);
        vm.warp(uint256(a.checkOutUtc) + GRACE);
        esc.settle(idA);
        esc.settle(idB);
        (,, uint256 ownB) = _fig(10_000e6, 0, ESCROW_FEE);
        uint256 bOwnerTotal = escV.ownerClaimable();
        (,, uint256 ownA) = _fig(10_000e6, 0, ESCROW_FEE);
        uint256 yA = 10_000e6 * accMid / 1e18;
        assertGt(yA, 90e6, "A earned the gain");
        // B earned nothing: the owner bucket is both principals plus A's owner share only
        assertEq(bOwnerTotal, ownA + ownB + (yA - yA * 5_000 / 10_000));
        assertEq(escV.guestClaimable(b.guest), 0, "no yield for B");
        assertEq(escV.guestClaimable(a.guest), yA * 5_000 / 10_000, "A vested half");
    }

    // ------------------------------------------------------------------ rebalancer caps (spec 6.3)

    function test_rebalancerCaps_spec6_3() public {
        Quote memory a = _std(0, 10_000e6);
        _dep(a);
        vm.prank(attacker);
        vm.expectRevert(IEscrowErrors.NotRebalancer.selector);
        esc.deploy(1e6);
        vm.prank(rebalancer);
        vm.expectRevert(); // breaks both the 10% buffer and the 90% cap; the spec fixes no order
        esc.deploy(9_000e6 + 1);
        vm.prank(escOwner);
        esc.setMaxDeployBps(5_000);
        vm.prank(rebalancer);
        vm.expectRevert(IEscrowErrors.DeployCapExceeded.selector);
        esc.deploy(5_000e6 + 1);
        vm.prank(escOwner);
        vm.expectRevert(); // spec 13: maxDeployBps <= 10,000 - MIN_BUFFER_BPS
        esc.setMaxDeployBps(9_001);
        vm.prank(rebalancer);
        esc.deploy(5_000e6);
        vm.prank(rebalancer);
        esc.redeem(5_000e6);
        assertEq(usdc.receivedFromEscrow(rebalancer), 0);
    }

    /// ERC-4626 rounding: an honest deploy into a live vault whose share price is not 1 leaves
    /// assets a few units below principal. INV-1 as written (spec 10.4) has no band for this.
    function test_INV1_asWritten_breaksOnHonestDeployRounding_spec10_4() public {
        usdc.mint(address(vault), 370_000e6 + 3); // share price ~1.37 before the escrow enters
        Quote memory a = _std(0, 10_000e6 + 1);
        _dep(a);
        vm.prank(rebalancer);
        esc.deploy(7_777_777_777);
        uint256 hard = escV.totalOpenPrincipal() + escV.totalDisputed() + escV.totalClaimable();
        assertGe(_assetsOf(escAddr), hard, "INV-1 as written: assets < open principal after an honest deploy");
    }

    // ------------------------------------------------------------------ liveness with a broken vault (property 11)

    /// Property 11: settle (credit-only, moves no tokens) should stay callable. With the vault's
    /// views reverting, accrue() cannot price the position.
    function test_settleWithBrokenVault_property11() public {
        Quote memory a = _std(0, 10_000e6);
        bytes32 id = _dep(a);
        vm.prank(rebalancer);
        esc.deploy(5_000e6);
        vault.setBricked(true);
        vm.warp(uint256(a.checkOutUtc) + GRACE);
        esc.settle(id);
        assertEq(uint8(esc.bookingState(id)), uint8(BookingState.SETTLED));
    }
}

/// @notice The empty-vault variant: the vault has no third-party LP (a freshly deployed ERC-4626).
contract C9AdversarialEmptyVault is C9Base {
    function _seedVault() internal override {}

    function setUp() public {
        _deployAll();
    }

    /// Property 10 / ADR 0008 inflation risk: an attacker donates to the empty vault, then a routine
    /// deploy mints very few shares and the escrow's position is worth less than it put in. The loss
    /// is booked against the owner (after the window) though no one's entitlement should move.
    function test_P10_deployIntoDonatedEmptyVault_losesValue_ADR0008() public {
        Quote memory a;
        a.resourceId = keccak256("villa-crete");
        a.checkInUtc = uint40(block.timestamp + 30 days);
        a.checkOutUtc = uint40(block.timestamp + 33 days);
        a.priceAtomic = 20_000e6;
        a.feeBps = ESCROW_FEE;
        a.guestYieldBps = 5_000;
        a.cutoffs = new Cutoff[](1);
        a.cutoffs[0] = Cutoff(uint40(block.timestamp + 10 days), 10_000);
        a.guest = guests[0];
        a.expiresAt = uint40(block.timestamp + 1 hours);
        bytes memory sig = _signQuote(signerPk, escAddr, a);
        vm.startPrank(a.guest);
        usdc.approve(escAddr, a.priceAtomic);
        esc.deposit(a, sig);
        vm.stopPrank();
        vm.prank(attacker);
        usdc.transfer(address(vault), 1_000e6); // first-depositor donation
        vm.prank(rebalancer);
        esc.deploy(1_999e6);
        uint256 lost = escV.lastAssets() - _assetsOf(escAddr);
        emit log_named_uint("escrow value lost on one deploy (atomic)", lost);
        assertEq(lost, 0, "deploy destroyed escrow value (rebalancer + donation)");
    }
}
