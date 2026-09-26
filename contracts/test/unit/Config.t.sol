// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EscrowTestBase} from "../utils/EscrowTestBase.sol";

contract ConfigTest is EscrowTestBase {
    // ------------------------------------------------------------------ fee timelock (spec 3.4)

    function test_feeChange_notEffectiveBefore_effectiveAtExactly_noTxInBetween() public {
        vm.expectEmit(address(escrow));
        emit FeeChangeProposed(1_000, uint64(block.timestamp + 7 days));
        vm.prank(admin);
        escrow.proposeFeeBps(1_000);
        uint256 at = escrow.pendingFeeAt();
        vm.warp(at - 1);
        assertEq(escrow.effectiveFeeBps(), FEE);
        vm.warp(at);
        assertEq(escrow.effectiveFeeBps(), 1_000); // lazy: a pure function of time
        assertEq(escrow.feeBps(), FEE); // not yet promoted in storage
        _deposit(
            _quoteFor(
                guest, uint40(block.timestamp + 30 days), uint40(block.timestamp + 32 days), 1_000 * USDC
            )
        );
        assertEq(escrow.feeBps(), 1_000); // promoted by the next state-changing call
        assertEq(escrow.pendingFeeAt(), 0);
    }

    /// Review 0001 finding 13: a new proposal must not undo a change that is already effective.
    function test_feeChange_newProposalKeepsEffectiveValue() public {
        vm.prank(admin);
        escrow.proposeFeeBps(1_000);
        vm.warp(block.timestamp + 7 days);
        vm.prank(admin);
        escrow.proposeFeeBps(1_500);
        assertEq(escrow.effectiveFeeBps(), 1_000, "effective value survives the new proposal");
    }

    function test_feeChange_capAndAccess() public {
        vm.prank(admin);
        vm.expectRevert(FeeAboveMax.selector);
        escrow.proposeFeeBps(2_001);
        vm.prank(owner);
        vm.expectRevert(NotFactoryAdmin.selector);
        escrow.proposeFeeBps(100);
    }

    function test_arbitratorChange_timelockAndAccess() public {
        address newArb = makeAddr("newArb");
        vm.prank(admin);
        escrow.proposeArbitrator(newArb);
        vm.warp(block.timestamp + 7 days - 1);
        assertEq(escrow.effectiveArbitrator(), arb);
        vm.warp(block.timestamp + 1);
        assertEq(escrow.effectiveArbitrator(), newArb);
        vm.prank(admin);
        vm.expectRevert(ZeroAddress.selector);
        escrow.proposeArbitrator(address(0));
        vm.prank(owner);
        vm.expectRevert(NotFactoryAdmin.selector);
        escrow.proposeArbitrator(newArb);
        // promote on the next proposal
        vm.prank(admin);
        escrow.proposeArbitrator(makeAddr("third"));
        assertEq(escrow.arbitrator(), newArb);
    }

    // ------------------------------------------------------------------ owner setters

    function test_ownerSetters_andEvents() public {
        vm.startPrank(owner);
        vm.expectEmit(address(escrow));
        emit GuestYieldBpsSet(4_000);
        escrow.setGuestYieldBps(4_000);
        vm.expectEmit(address(escrow));
        emit MinNightlySet(1);
        escrow.setMinNightlyAtomic(1);
        vm.expectEmit(address(escrow));
        emit MaxDeployBpsSet(9_000);
        escrow.setMaxDeployBps(9_000);
        vm.expectEmit(address(escrow));
        emit RebalancerSet(address(7));
        escrow.setRebalancer(address(7));
        vm.expectEmit(address(escrow));
        emit MaxOpenPrincipalSet(5);
        escrow.setMaxOpenPrincipal(5);
        vm.expectEmit(address(escrow));
        emit QuoteSignerRotated(address(8));
        escrow.setQuoteSigner(address(8));
        vm.expectEmit(address(escrow));
        emit PayoutAddressSet(address(9));
        escrow.setPayoutAddress(address(9));
        vm.stopPrank();
        assertEq(escrow.guestYieldBps(), 4_000);
        assertEq(escrow.rebalancer(), address(7));
        assertEq(escrow.quoteSigner(), address(8));
        assertEq(escrow.payoutAddress(), address(9));
    }

    function test_ownerSetters_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(BpsOutOfRange.selector);
        escrow.setGuestYieldBps(10_001);
        vm.expectRevert(BpsOutOfRange.selector);
        escrow.setMaxDeployBps(9_001); // must leave MIN_BUFFER_BPS
        vm.expectRevert(ZeroAddress.selector);
        escrow.setPayoutAddress(address(0));
        vm.expectRevert(ZeroAddress.selector);
        escrow.setQuoteSigner(address(0));
        vm.expectRevert(ZeroMinNightly.selector);
        escrow.setMinNightlyAtomic(0);
        vm.stopPrank();
    }

    function test_ownerSetters_onlyOwner() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin);
        vm.startPrank(admin);
        vm.expectRevert(err);
        escrow.setGuestYieldBps(1);
        vm.expectRevert(err);
        escrow.setMinNightlyAtomic(1);
        vm.expectRevert(err);
        escrow.setMaxDeployBps(1);
        vm.expectRevert(err);
        escrow.setRebalancer(address(1));
        vm.expectRevert(err);
        escrow.setMaxOpenPrincipal(1);
        vm.expectRevert(err);
        escrow.setQuoteSigner(address(1));
        vm.expectRevert(err);
        escrow.setPayoutAddress(address(1));
        vm.stopPrank();
    }

    function test_guardianOnlyForPause() public {
        vm.prank(owner);
        vm.expectRevert(NotGuardian.selector);
        escrow.pauseDeposits();
        vm.prank(owner);
        vm.expectRevert(NotGuardian.selector);
        escrow.unpauseDeposits();
    }

    function test_renounceDisabled_twoStepTransferWorks() public {
        vm.prank(owner);
        vm.expectRevert(RenounceDisabled.selector);
        escrow.renounceOwnership();
        address next = makeAddr("nextOwner");
        vm.prank(owner);
        escrow.transferOwnership(next);
        assertEq(escrow.owner(), owner);
        vm.prank(next);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), next);
    }

    function test_cannotReinitialise() public {
        vm.expectRevert(); // InvalidInitialization
        escrow.initialize(_init());
    }

    function test_implementationCannotBeInitialised() public {
        vm.expectRevert(); // InvalidInitialization (_disableInitializers)
        impl.initialize(_init());
    }

    /// Defence in depth: the escrow re-checks fee bounds even though the factory already does.
    function test_initialize_feeBoundsOnBareClone() public {
        EscrowInit memory p = _init();
        p.maxFeeBps = 2_001;
        Escrow bare = Escrow(Clones.clone(address(impl)));
        vm.expectRevert(FeeAboveMax.selector);
        bare.initialize(p);
        p = _init();
        p.feeBps = p.maxFeeBps + 1;
        vm.expectRevert(FeeAboveMax.selector);
        bare.initialize(p);
        p = _init();
        p.minNightlyAtomic = 0;
        vm.expectRevert(ZeroMinNightly.selector);
        bare.initialize(p);
        p = _init();
        p.arbitrator = address(0);
        vm.expectRevert(ZeroAddress.selector);
        bare.initialize(p);
    }

    function _init() internal view returns (EscrowInit memory) {
        return EscrowInit(owner, payout, signer, address(usdc), address(0), arb, 2_000, FEE, CAP, 100 * USDC);
    }
}

import {EscrowInit} from "../../src/interfaces/IEscrow.sol";
import {Escrow} from "../../src/Escrow.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
