// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ERC1271WalletMock} from "@openzeppelin/contracts/mocks/ERC1271WalletMock.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {BatchWallet, FeeOnTransferToken} from "../utils/Mocks.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {Quote, Cutoff, Booking, BookingState} from "../../src/interfaces/IEscrow.sol";

contract DepositTest is EscrowTestBase {
    using stdStorage for StdStorage;

    function _expectDepositRevert(Quote memory q, bytes memory sig, bytes4 err) internal {
        _fund(q.guest, q.priceAtomic);
        vm.prank(q.guest);
        vm.expectRevert(err);
        escrow.deposit(q, sig);
    }

    function _expectRevert(Quote memory q, bytes4 err) internal {
        _expectDepositRevert(q, _sign(q), err);
    }

    // ------------------------------------------------------------------ happy path

    function test_deposit_storesTermsAndPullsExactly() public {
        Quote memory q = _quote();
        bytes32 expectedId = escrow.hashQuote(q);
        _fund(guest, q.priceAtomic);
        bytes memory sig = _sign(q);
        vm.expectEmit(address(escrow));
        emit BookingDeposited(
            expectedId,
            guest,
            q.resourceId,
            q.checkInUtc,
            q.checkOutUtc,
            q.priceAtomic,
            FEE,
            5_000,
            q.policyHash,
            q.cutoffs,
            0,
            arb,
            0
        );
        vm.prank(guest);
        bytes32 id = escrow.deposit(q, sig);
        assertEq(id, expectedId);

        Booking memory b = escrow.getBooking(id);
        assertEq(b.guest, guest);
        assertEq(b.principalAtomic, 5_600 * USDC);
        assertEq(b.feeBps, FEE);
        assertEq(b.arbitrator, arb);
        assertEq(uint8(b.state), uint8(BookingState.ESCROWED));
        assertEq(escrow.getCutoffs(id).length, 3);
        assertEq(usdc.balanceOf(address(escrow)), 5_600 * USDC);
        assertEq(escrow.totalOpenPrincipal(), 5_600 * USDC);
        assertEq(escrow.lastAssets(), 5_600 * USDC);
    }

    // ------------------------------------------------------------------ guards, spec 4.2 order

    function test_guard1_badSignature() public {
        Quote memory q = _quote();
        (, uint256 otherKey) = makeAddrAndKey("not-the-signer");
        _expectDepositRevert(q, _signWith(otherKey, q), InvalidQuoteSignature.selector);
    }

    function test_guard1_tamperedField() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        q.priceAtomic -= 1; // signature no longer covers this quote
        _expectDepositRevert(q, sig, InvalidQuoteSignature.selector);
    }

    function test_guard2_senderNotGuest() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        address other = makeAddr("other");
        _fund(other, q.priceAtomic);
        vm.prank(other);
        vm.expectRevert(NotQuoteGuest.selector);
        escrow.deposit(q, sig);
    }

    function test_guard3_expired() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        vm.warp(q.expiresAt + 1);
        _expectDepositRevert(q, sig, QuoteExpired.selector);
    }

    function test_guard3_atExpiryStillOk() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        vm.warp(q.expiresAt);
        _fund(guest, q.priceAtomic);
        vm.prank(guest);
        escrow.deposit(q, sig);
    }

    function test_guard4_bookingIdUsed() public {
        Quote memory q = _quote();
        _deposit(q);
        _expectRevert(q, BookingExists.selector);
    }

    function test_guard5_paused() public {
        vm.prank(guardian);
        escrow.pauseDeposits();
        _expectRevert(_quote(), PausableUpgradeable.EnforcedPause.selector);
        vm.prank(guardian);
        escrow.unpauseDeposits();
        _deposit(_quote());
    }

    function test_guard5_lossDebt() public {
        stdstore.target(address(escrow)).sig("lossDebt()").checked_write(uint256(1));
        _expectRevert(_quote(), LossDebtOutstanding.selector);
    }

    function test_guard6_checkInNotFuture() public {
        Quote memory q =
            _quoteFor(guest, uint40(block.timestamp), uint40(block.timestamp + 3 days), 1_000 * USDC);
        q.cutoffs = new Cutoff[](1);
        q.cutoffs[0] = Cutoff(uint40(block.timestamp - 1), 0);
        _expectRevert(q, InvalidStayTimes.selector);
    }

    function test_guard6_checkOutNotAfterCheckIn() public {
        Quote memory q = _quote();
        q.checkOutUtc = q.checkInUtc;
        _expectRevert(q, InvalidStayTimes.selector);
    }

    function test_guard7_tooManyNights() public {
        Quote memory q = _quote();
        q.checkOutUtc = q.checkInUtc + 60 days + 1; // ceil -> 61 nights
        q.priceAtomic = 61 * 100 * USDC;
        _expectRevert(q, InvalidNights.selector);
        q.checkOutUtc = q.checkInUtc + 60 days; // exactly 60 is allowed
        q.priceAtomic = 60 * 100 * USDC;
        _deposit(q);
    }

    function test_guard8_priceBelowFloor() public {
        Quote memory q = _quote(); // 7 nights (ceil of 7 days), floor 100/night
        q.priceAtomic = 700 * USDC - 1;
        _expectRevert(q, PriceBelowFloor.selector);
        q.priceAtomic = 700 * USDC;
        _deposit(q);
    }

    function test_guard9_feeMismatch() public {
        Quote memory q = _quote();
        q.feeBps = FEE - 1; // the signer tries to waive part of the platform fee
        _expectRevert(q, FeeMismatch.selector);
        q.feeBps = FEE + 1;
        _expectRevert(q, FeeMismatch.selector);
    }

    function test_guard10_guestYieldMismatch() public {
        Quote memory q = _quote();
        vm.prank(owner);
        escrow.setGuestYieldBps(4_000); // quote now carries stale terms
        _expectRevert(q, GuestYieldMismatch.selector);
    }

    function test_guard11_cutoffCount() public {
        Quote memory q = _quote();
        q.cutoffs = new Cutoff[](0);
        _expectRevert(q, InvalidCutoffs.selector);
        q.cutoffs = new Cutoff[](9);
        for (uint256 i; i < 9; ++i) {
            q.cutoffs[i] = Cutoff(uint40(block.timestamp + 1 days + i), 10_000);
        }
        _expectRevert(q, InvalidCutoffs.selector);
        q.cutoffs = new Cutoff[](8);
        for (uint256 i; i < 8; ++i) {
            q.cutoffs[i] = Cutoff(uint40(block.timestamp + 1 days + i), 10_000);
        }
        _deposit(q); // 8 is allowed
    }

    function test_guard11_notStrictlyIncreasing() public {
        Quote memory q = _quote();
        q.cutoffs[1].cutoffUtc = q.cutoffs[0].cutoffUtc;
        _expectRevert(q, InvalidCutoffs.selector);
    }

    function test_guard11_refundIncreases() public {
        Quote memory q = _quote();
        q.cutoffs[2].refundBps = q.cutoffs[1].refundBps + 1;
        _expectRevert(q, InvalidCutoffs.selector);
    }

    function test_guard11_refundAbove100() public {
        Quote memory q = _quote();
        q.cutoffs[0].refundBps = 10_001;
        _expectRevert(q, InvalidCutoffs.selector);
    }

    function test_guard11_cutoffNotBeforeCheckIn() public {
        Quote memory q = _quote();
        q.cutoffs[2].cutoffUtc = q.checkInUtc;
        _expectRevert(q, InvalidCutoffs.selector);
    }

    function test_guard11_finalAboveLast() public {
        Quote memory q = _quote();
        q.finalBps = q.cutoffs[2].refundBps + 1;
        _expectRevert(q, InvalidCutoffs.selector);
    }

    function test_cap_escrowedValue() public {
        vm.prank(owner);
        escrow.setMaxOpenPrincipal(10_000 * USDC);
        _deposit(_quote()); // 5,600
        _expectRevert(_quote(), EscrowCapExceeded.selector); // 11,200 > 10,000
        Quote memory q = _quoteFor(guest, uint40(T0 + 60 days), uint40(T0 + 64 days), 4_400 * USDC);
        _deposit(q); // exactly 10,000
    }

    function test_guard12_balanceDeltaMismatch() public {
        FeeOnTransferToken fot = new FeeOnTransferToken();
        EscrowFactory f2 =
            new EscrowFactory(admin, address(fot), address(impl), feeTo, guardian, arb, address(0));
        vm.prank(admin);
        f2.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(f2.createEscrow(payout, signer, 100 * USDC));
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        fot.mint(guest, q.priceAtomic);
        vm.startPrank(guest);
        fot.approve(address(escrow), q.priceAtomic);
        vm.expectRevert(TransferAmountMismatch.selector);
        escrow.deposit(q, sig);
        vm.stopPrank();
    }

    function test_insufficientAllowanceReverts() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        usdc.mint(guest, q.priceAtomic);
        vm.prank(guest);
        vm.expectRevert(); // ERC20InsufficientAllowance
        escrow.deposit(q, sig);
    }

    // ------------------------------------------------------------------ brief test 5: fee cannot be waived

    function testFuzz_feeMustEqualEffective(uint16 quotedFee) public {
        vm.assume(quotedFee != FEE);
        Quote memory q = _quote();
        q.feeBps = quotedFee;
        _expectRevert(q, FeeMismatch.selector);
    }

    function testFuzz_feeAcrossPendingChange(uint16 newFee, uint256 offset) public {
        newFee = uint16(bound(newFee, 0, 2_000));
        vm.assume(newFee != FEE);
        offset = bound(offset, 0, 30 days);
        vm.prank(admin);
        escrow.proposeFeeBps(newFee);
        uint256 effectiveAt = escrow.pendingFeeAt();
        vm.warp(block.timestamp + offset);
        bool effective = block.timestamp >= effectiveAt;

        Quote memory stale = _quoteFor(
            guest, uint40(block.timestamp + 60 days), uint40(block.timestamp + 62 days), 1_000 * USDC
        );
        stale.feeBps = effective ? FEE : newFee; // the wrong one for this moment
        _expectRevert(stale, FeeMismatch.selector);

        Quote memory ok = _quoteFor(
            guest, uint40(block.timestamp + 60 days), uint40(block.timestamp + 62 days), 1_000 * USDC
        );
        assertEq(ok.feeBps, effective ? newFee : FEE);
        _deposit(ok);
    }

    // ------------------------------------------------------------------ entry points and signers

    function test_smartWallet_approveAndDepositInOneTx() public {
        BatchWallet wallet = new BatchWallet();
        Quote memory q = _quoteFor(address(wallet), uint40(T0 + 60 days), uint40(T0 + 67 days), 5_600 * USDC);
        bytes memory sig = _sign(q);
        usdc.mint(address(wallet), q.priceAtomic);
        BatchWallet.Call[] memory calls = new BatchWallet.Call[](2);
        calls[0] =
            BatchWallet.Call(address(usdc), abi.encodeCall(IERC20.approve, (address(escrow), q.priceAtomic)));
        calls[1] = BatchWallet.Call(address(escrow), abi.encodeCall(escrow.deposit, (q, sig)));
        wallet.execute(calls);
        assertEq(escrow.getBooking(escrow.hashQuote(q)).guest, address(wallet));
        assertEq(usdc.balanceOf(address(escrow)), q.priceAtomic);
    }

    function test_erc1271QuoteSigner() public {
        ERC1271WalletMock signerWallet = new ERC1271WalletMock(signer); // signer EOA owns the wallet
        vm.prank(owner);
        escrow.setQuoteSigner(address(signerWallet));
        Quote memory q = _quote();
        _deposit(q); // signed by `signer`, validated through the wallet's isValidSignature
        vm.prank(owner);
        escrow.setQuoteSigner(makeAddr("rotated"));
        _expectRevert(_quote(), InvalidQuoteSignature.selector);
    }

    function _permitSig(uint256 key, address owner_, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner_,
                address(escrow),
                value,
                usdc.nonces(owner_),
                deadline
            )
        );
        return vm.sign(key, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_depositWithPermit() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        usdc.mint(guest, q.priceAtomic);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(guestKey, guest, q.priceAtomic, deadline);
        vm.prank(guest);
        escrow.depositWithPermit(q, sig, deadline, v, r, s);
        assertEq(usdc.balanceOf(address(escrow)), q.priceAtomic);
    }

    function test_depositWithPermit_frontRunPermitStillDeposits() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        usdc.mint(guest, q.priceAtomic);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(guestKey, guest, q.priceAtomic, deadline);
        // A third party lifts the permit from the mempool and submits it first.
        vm.prank(makeAddr("griefer"));
        usdc.permit(guest, address(escrow), q.priceAtomic, deadline, v, r, s);
        vm.prank(guest);
        escrow.depositWithPermit(q, sig, deadline, v, r, s); // permit now reverts inside try/catch
        assertEq(usdc.balanceOf(address(escrow)), q.priceAtomic);
    }

    function test_depositWithPermit_badPermitNoAllowanceReverts() public {
        Quote memory q = _quote();
        bytes memory sig = _sign(q);
        usdc.mint(guest, q.priceAtomic);
        vm.prank(guest);
        vm.expectRevert(); // permit swallowed, then transferFrom fails on allowance
        escrow.depositWithPermit(q, sig, block.timestamp + 1, 27, bytes32(0), bytes32(0));
    }

    function test_arbitratorSnapshotUsesEffectiveValue() public {
        address newArb = makeAddr("newArb");
        vm.prank(admin);
        escrow.proposeArbitrator(newArb);
        vm.warp(block.timestamp + 7 days); // effective, but no transaction has promoted it
        assertEq(escrow.arbitrator(), arb);
        assertEq(escrow.effectiveArbitrator(), newArb);
        bytes32 id = _deposit(
            _quoteFor(
                guest, uint40(block.timestamp + 30 days), uint40(block.timestamp + 32 days), 1_000 * USDC
            )
        );
        assertEq(escrow.getBooking(id).arbitrator, newArb);
    }
}
