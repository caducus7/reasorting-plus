// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {IEscrowFactory} from "../../src/interfaces/IEscrowFactory.sol";
import {MockUSDC, MockVault} from "../utils/Mocks.sol";

contract FactoryTest is Test {
    MockUSDC usdc;
    Escrow impl;
    EscrowFactory factory;
    address admin = makeAddr("admin");
    address owner = makeAddr("owner");
    address feeTo = makeAddr("feeTo");
    address guardian = makeAddr("guardian");
    address arb = makeAddr("arb");

    function setUp() public {
        usdc = new MockUSDC();
        impl = new Escrow();
        factory = new EscrowFactory(admin, address(usdc), address(impl), feeTo, guardian, arb, address(0));
    }

    function test_constants() public view {
        assertEq(factory.MAX_FEE_BPS(), 2_000);
        assertEq(factory.FEE_CHANGE_DELAY(), 7 days);
        assertEq(factory.FEE_RECIPIENT_DELAY(), 7 days);
        assertEq(factory.ARBITRATOR_DELAY(), 7 days);
        assertEq(factory.owner(), admin);
        assertEq(factory.usdc(), address(usdc));
    }

    function test_constructor_zeroAddresses() public {
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(admin, address(0), address(impl), feeTo, guardian, arb, address(0));
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(admin, address(usdc), address(impl), address(0), guardian, arb, address(0));
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(admin, address(usdc), address(impl), feeTo, address(0), arb, address(0));
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        new EscrowFactory(admin, address(usdc), address(impl), feeTo, guardian, address(0), address(0));
    }

    // ------------------------------------------------------------------ onboarding (ADR 0007)

    function test_createRequiresApproval() public {
        vm.prank(owner);
        vm.expectRevert(IEscrowFactory.NotApproved.selector);
        factory.createEscrow(owner, owner, 1);
    }

    function test_approveCreateConsumesApproval() public {
        vm.expectEmit(address(factory));
        emit IEscrowFactory.OwnerApproved(owner, 1_500, 300, 1e12);
        vm.prank(admin);
        factory.approveOwner(owner, 1_500, 300, 1e12);

        vm.prank(owner);
        Escrow e = Escrow(factory.createEscrow(makeAddr("payout"), makeAddr("signer"), 100e6));
        assertTrue(factory.isEscrow(address(e)));
        assertEq(e.owner(), owner);
        assertEq(e.maxFeeBps(), 1_500);
        assertEq(e.feeBps(), 300);
        assertEq(e.maxOpenPrincipalAtomic(), 1e12);
        assertEq(e.arbitrator(), arb);
        assertEq(address(e.factory()), address(factory));
        assertEq(address(e.usdc()), address(usdc));
        assertEq(e.guestYieldBps(), 5_000);
        assertEq(e.maxDeployBps(), 9_000);
        assertEq(e.minNightlyAtomic(), 100e6);

        vm.prank(owner);
        vm.expectRevert(IEscrowFactory.NotApproved.selector);
        factory.createEscrow(owner, owner, 1);
    }

    function test_onlyApprovedAddressCanCreate() public {
        vm.prank(admin);
        factory.approveOwner(owner, 1_500, 300, 1e12);
        vm.prank(makeAddr("squatter"));
        vm.expectRevert(IEscrowFactory.NotApproved.selector);
        factory.createEscrow(owner, owner, 1);
    }

    function test_createValidatesRoles() public {
        vm.prank(admin);
        factory.approveOwner(owner, 1_500, 300, 1e12);
        vm.prank(owner);
        vm.expectRevert(); // Escrow ZeroAddress on payout
        factory.createEscrow(address(0), owner, 1);
    }

    function test_createRequiresNonZeroFloor() public {
        vm.prank(admin);
        factory.approveOwner(owner, 1_500, 300, 1e12);
        vm.prank(owner);
        vm.expectRevert(); // Escrow.ZeroMinNightly
        factory.createEscrow(owner, owner, 0);
    }

    function test_approve_feeBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(IEscrowFactory.FeeAboveMax.selector);
        factory.approveOwner(owner, 2_001, 0, 1);
        vm.expectRevert(IEscrowFactory.FeeAboveMax.selector);
        factory.approveOwner(owner, 1_000, 1_001, 1);
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.approveOwner(address(0), 1_000, 100, 1);
        vm.stopPrank();
    }

    function test_revoke() public {
        vm.startPrank(admin);
        factory.approveOwner(owner, 1_000, 100, 1);
        factory.revokeOwner(owner);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(IEscrowFactory.NotApproved.selector);
        factory.createEscrow(owner, owner, 1);
    }

    function test_adminOnly() public {
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner);
        vm.startPrank(owner);
        vm.expectRevert(err);
        factory.approveOwner(owner, 1, 1, 1);
        vm.expectRevert(err);
        factory.revokeOwner(owner);
        vm.expectRevert(err);
        factory.proposeFeeRecipient(owner);
        vm.expectRevert(err);
        factory.setImplementation(address(impl));
        vm.expectRevert(err);
        factory.setDefaultArbitrator(owner);
        vm.expectRevert(err);
        factory.setDefaultVault(address(0));
        vm.expectRevert(err);
        factory.setGuardian(owner);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ fee recipient timelock (spec 3.4)

    function test_feeRecipient_timelockBoundary() public {
        address next = makeAddr("next");
        vm.prank(admin);
        factory.proposeFeeRecipient(next);
        uint256 at = factory.pendingFeeRecipientAt();
        assertEq(at, block.timestamp + 7 days);
        vm.warp(at - 1);
        assertEq(factory.feeRecipient(), feeTo);
        vm.warp(at);
        assertEq(factory.feeRecipient(), next);
    }

    function test_feeRecipient_newProposalKeepsEffectiveValue() public {
        address next = makeAddr("next");
        vm.startPrank(admin);
        factory.proposeFeeRecipient(next);
        vm.warp(block.timestamp + 7 days);
        factory.proposeFeeRecipient(makeAddr("third"));
        vm.stopPrank();
        assertEq(factory.feeRecipient(), next);
        vm.prank(admin);
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.proposeFeeRecipient(address(0));
    }

    // ------------------------------------------------------------------ defaults

    function test_setters() public {
        vm.startPrank(admin);
        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.setImplementation(makeAddr("eoa")); // no code
        Escrow impl2 = new Escrow();
        factory.setImplementation(address(impl2));
        assertEq(factory.implementation(), address(impl2));

        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.setDefaultArbitrator(address(0));
        factory.setDefaultArbitrator(makeAddr("arb2"));

        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.setGuardian(address(0));
        factory.setGuardian(makeAddr("g2"));

        MockVault wrongAsset = new MockVault(IERC20(address(new MockUSDC())));
        vm.expectRevert(IEscrowFactory.VaultAssetMismatch.selector);
        factory.setDefaultVault(address(wrongAsset));
        MockVault v = new MockVault(IERC20(address(usdc)));
        vm.expectRevert(IEscrowFactory.VaultNotSeeded.selector);
        factory.setDefaultVault(address(v));
        vm.stopPrank();
        usdc.mint(address(this), 1);
        usdc.approve(address(v), 1);
        v.deposit(1, address(0xdEaD)); // seed (docs/adr/0013 §1)
        vm.startPrank(admin);
        factory.setDefaultVault(address(v));
        assertEq(factory.defaultVault(), address(v));
        factory.setDefaultVault(address(0));

        vm.expectRevert(IEscrowFactory.ZeroAddress.selector);
        factory.renounceOwnership();
        vm.stopPrank();
    }

    function test_newImplementationOnlyForNewEscrows() public {
        vm.prank(admin);
        factory.approveOwner(owner, 1_000, 100, 1);
        vm.prank(owner);
        address e1 = factory.createEscrow(owner, owner, 1);
        Escrow impl2 = new Escrow();
        vm.prank(admin);
        factory.setImplementation(address(impl2));
        vm.prank(admin);
        factory.approveOwner(owner, 1_000, 100, 1);
        vm.prank(owner);
        address e2 = factory.createEscrow(owner, owner, 1);
        // EIP-1167 runtime code embeds the implementation address at bytes 10..30
        assertEq(address(bytes20(_slice(e1.code, 10))), address(impl));
        assertEq(address(bytes20(_slice(e2.code, 10))), address(impl2));
    }

    function _slice(bytes memory b, uint256 start) internal pure returns (bytes memory out) {
        out = new bytes(20);
        for (uint256 i; i < 20; ++i) {
            out[i] = b[start + i];
        }
    }
}
