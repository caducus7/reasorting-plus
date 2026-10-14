// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

// Gaps listed in docs/handoffs/C9.md ("not exercised"), closed as targeted unit tests. They are not
// added to C9's independent suite, whose value is that its author never read C1-C3's code.
//   1. One address holding the guest, fee and owner buckets at once: which is debited first on a
//      partial claim (LedgerLib._debit: guest, then fee, then owner), and guests-first during a loss.
//   2. Reentrancy through a token with a receive hook (ERC-777 style): every re-entry into the escrow
//      from inside its own transfer reverts, and the attacker is paid once.
//   3. Two owners' escrows from one factory: a quote for one is rejected by the other (EIP-712
//      domain binds verifyingContract) and their ledgers never mix.

import {stdStorage, StdStorage} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {MockUSDC, MockVault} from "../utils/Mocks.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {Quote} from "../../src/interfaces/IEscrow.sol";

interface IReceiveHook {
    function onTokenReceived(address from, uint256 amount) external;
}

/// USDC stand-in that calls the recipient after crediting it, like ERC-777 tokensReceived.
contract HookedUSDC is MockUSDC {
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to.code.length != 0 && from != address(0)) {
            try IReceiveHook(to).onTokenReceived(from, value) {} catch {}
        }
    }
}

/// A guest contract that re-enters the escrow from the token hook and records each outcome.
contract ReentrantGuest is IReceiveHook {
    Escrow public escrow;
    bytes32 public bookingId;
    bytes4[] public reentryErrors;
    uint256 public hooks;

    function setEscrow(Escrow e) external {
        escrow = e;
    }

    function depositAndApprove(IERC20 token, Quote calldata q, bytes calldata sig) external {
        token.approve(address(escrow), q.priceAtomic);
        bookingId = escrow.deposit(q, sig);
    }

    function cancel() external {
        escrow.cancelByGuest(bookingId);
    }

    function claim() external returns (uint256) {
        return escrow.claim();
    }

    function onTokenReceived(address, uint256) external {
        if (msg.sender != address(escrow.usdc())) return;
        hooks++;
        _try(abi.encodeCall(Escrow.claim, ()));
        _try(abi.encodeCall(Escrow.cancelByGuest, (bookingId)));
        _try(abi.encodeCall(Escrow.settle, (bookingId)));
    }

    function _try(bytes memory call) private {
        (bool ok, bytes memory ret) = address(escrow).call(call);
        reentryErrors.push(ok ? bytes4(0) : bytes4(ret));
    }

    function reentryCount() external view returns (uint256) {
        return reentryErrors.length;
    }
}

contract ClaimEdgesTest is EscrowTestBase {
    using stdStorage for StdStorage;

    uint256 internal constant P = 5_600 * USDC;

    function _claimAs(Escrow e, address who) internal returns (uint256 paid) {
        vm.prank(who);
        paid = e.claim();
    }

    // ---------------------------------------------------------------- 1. one address, three buckets

    /// An escrow whose payout address and fee recipient are the same account `holder`, with a vault.
    function _sameHolderEscrow(address holder) internal returns (MockVault v) {
        v = new MockVault(IERC20(address(usdc)));
        usdc.mint(address(this), 1);
        usdc.approve(address(v), 1);
        v.deposit(1, address(0xdEaD)); // seed (docs/adr/0013 §1)
        factory = new EscrowFactory(admin, address(usdc), address(impl), holder, guardian, arb, address(v));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(holder, signer, 100 * USDC));
    }

    function _threeBuckets(address holder) internal returns (MockVault v) {
        v = _sameHolderEscrow(holder);
        // Owner and fee buckets: a delivered stay (5% fee on 5,600).
        Quote memory q = _quote();
        bytes32 stay = _deposit(q);
        // Guest bucket: the holder books and cancels more than 30 days out (100% refund).
        bytes32 own = _deposit(_quoteFor(holder, uint40(T0 + 90 days), uint40(T0 + 92 days), 1_000 * USDC));
        vm.prank(holder);
        escrow.cancelByGuest(own);
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        escrow.settle(stay);
        assertEq(escrow.guestClaimable(holder), 1_000 * USDC);
        assertEq(escrow.feeClaimable(holder), 280 * USDC);
        assertEq(escrow.ownerClaimable(), 5_320 * USDC);
    }

    function test_sameAddressAllBuckets_partialClaimDebitsGuestThenFeeThenOwner() public {
        address holder = makeAddr("holder");
        MockVault v = _threeBuckets(holder);
        // 6,600 held; move 6,000 to the vault and let it pay only 900: 1,500 available in total.
        vm.startPrank(address(escrow));
        usdc.approve(address(v), 6_000 * USDC);
        v.deposit(6_000 * USDC, address(escrow));
        vm.stopPrank();
        v.setWithdrawLimit(900 * USDC);

        vm.expectEmit(address(escrow));
        emit Claimed(holder, 6_600 * USDC, 1_500 * USDC);
        assertEq(_claimAs(escrow, holder), 1_500 * USDC);
        assertEq(escrow.guestClaimable(holder), 0, "guest bucket first");
        assertEq(escrow.feeClaimable(holder), 0, "fee bucket second");
        assertEq(escrow.ownerClaimable(), 5_100 * USDC, "owner bucket last");
        assertEq(escrow.totalClaimable(), 5_100 * USDC);

        v.setWithdrawLimit(type(uint256).max);
        assertEq(_claimAs(escrow, holder), 5_100 * USDC);
        assertEq(escrow.claimableOf(holder), 0);
    }

    function test_sameAddressAllBuckets_duringLossOnlyTheGuestBucketPays() public {
        address holder = makeAddr("holder");
        _threeBuckets(holder);
        stdstore.target(address(escrow)).sig("lossDebt()").checked_write(1); // a recognised loss
        assertEq(_claimAs(escrow, holder), 1_000 * USDC);
        assertEq(escrow.feeClaimable(holder), 280 * USDC, "fee waits while lossDebt > 0");
        assertEq(escrow.ownerClaimable(), 5_320 * USDC, "owner waits while lossDebt > 0");
        vm.prank(holder);
        vm.expectRevert(LossDebtOutstanding.selector);
        escrow.claim();
    }

    // ---------------------------------------------------------------- 2. reentrancy via token hook

    function test_reentryFromTokenHook_revertsEveryTime_andPaysOnce() public {
        HookedUSDC token = new HookedUSDC();
        usdc = token;
        factory = new EscrowFactory(admin, address(token), address(impl), feeTo, guardian, arb, address(0));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));

        ReentrantGuest g = new ReentrantGuest();
        g.setEscrow(escrow);
        Quote memory q = _quoteFor(address(g), uint40(T0 + 60 days), uint40(T0 + 67 days), P);
        token.mint(address(g), P);
        g.depositAndApprove(token, q, _sign(q));
        g.cancel(); // 100% refund credited
        assertEq(escrow.guestClaimable(address(g)), P);

        uint256 paid = g.claim();
        assertEq(paid, P);
        assertEq(token.balanceOf(address(g)), P, "paid exactly once");
        assertEq(escrow.guestClaimable(address(g)), 0);
        assertEq(g.hooks(), 1);
        assertEq(g.reentryCount(), 3);
        for (uint256 i; i < 3; i++) {
            assertEq(g.reentryErrors(i), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        }
        assertEq(token.balanceOf(address(escrow)), escrow.lastAssets(), "books still match the balance");
    }

    // ---------------------------------------------------------------- 3. two owners, one factory

    function test_twoEscrows_quotesDoNotCross_andLedgersStaySeparate() public {
        address owner2 = makeAddr("owner2");
        vm.prank(admin);
        factory.approveOwner(owner2, 2_000, FEE, CAP);
        vm.prank(owner2);
        // Same quote signer key for both owners: only the EIP-712 domain separates them.
        Escrow other = Escrow(factory.createEscrow(makeAddr("payout2"), signer, 100 * USDC));
        uint256 otherBalance = usdc.balanceOf(address(other));

        Quote memory q = _quote();
        bytes memory sigForA = _sign(q);
        usdc.mint(guest, 2 * P);
        vm.startPrank(guest);
        usdc.approve(address(other), P);
        vm.expectRevert(InvalidQuoteSignature.selector);
        other.deposit(q, sigForA);
        usdc.approve(address(escrow), P);
        bytes32 id = escrow.deposit(q, sigForA);
        vm.stopPrank();

        assertEq(escrow.totalOpenPrincipal(), P);
        assertEq(other.totalOpenPrincipal(), 0);
        assertEq(usdc.balanceOf(address(other)), otherBalance, "nothing reached the other escrow");

        vm.prank(guest);
        escrow.cancelByGuest(id);
        assertEq(escrow.guestClaimable(guest), P);
        assertEq(other.claimableOf(guest), 0);
        assertEq(_claimAs(other, guest), 0, "a claim on the other escrow pays nothing");
        assertEq(_claimAs(escrow, guest), P);
        assertEq(usdc.balanceOf(address(other)), otherBalance);
        assertEq(other.totalClaimable(), 0);
    }
}
