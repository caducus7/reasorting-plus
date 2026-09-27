// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IEscrow, Quote, Cutoff} from "../../../src/interfaces/IEscrow.sol";
import {Escrow} from "../../../src/Escrow.sol";
import {EscrowFactory} from "../../../src/EscrowFactory.sol";
import {C9Usdc} from "./mocks/C9Usdc.sol";
import {C9Vault} from "./mocks/C9Vault.sol";

/// @notice Getters that exist on the published Escrow ABI (contracts/abi/Escrow.json) but not on
/// IEscrow. Declared here from the ABI signatures only.
interface IEscrowViews {
    function accYieldPerUnit() external view returns (uint256);
    function lastAssets() external view returns (uint256);
    function lossDebt() external view returns (uint256);
    function reserve() external view returns (uint256);
    function totalOpenPrincipal() external view returns (uint256);
    function totalDisputed() external view returns (uint256);
    function totalPendingYield() external view returns (uint256);
    function totalClaimable() external view returns (uint256);
    function yieldUnallocated() external view returns (uint256);
    function ownerClaimable() external view returns (uint256);
    function pendingOwnerYield() external view returns (uint256);
    function guestClaimable(address) external view returns (uint256);
    function feeClaimable(address) external view returns (uint256);
    function pendingGuestYield(address) external view returns (uint256);
    function shortfallSince() external view returns (uint40);
    function guestYieldBps() external view returns (uint16);
    function payoutAddress() external view returns (address);
    function paused() external view returns (bool);
    function maxDeployBps() external view returns (uint16);
    function maxFeeBps() external view returns (uint16);
    function minNightlyAtomic() external view returns (uint256);
    function maxOpenPrincipalAtomic() external view returns (uint256);
    function rebalancer() external view returns (address);
    function vault() external view returns (address);
    function pendingReserveWithdrawal() external view returns (uint256, uint8);
    function eip712Domain()
        external
        view
        returns (bytes1, string memory, string memory, uint256, address, bytes32, uint256[] memory);
}

/// @notice Factory functions on the published ABI (contracts/abi/EscrowFactory.json) beyond IEscrowFactory.
interface IFactoryAdmin {
    function approveOwner(address escrowOwner, uint16 maxFeeBps, uint16 feeBps, uint256 maxOpenPrincipalAtomic)
        external;
    function proposeFeeRecipient(address newFeeRecipient) external;
    function feeRecipient() external view returns (address);
    function createEscrow(address payoutAddress, address quoteSigner, uint256 minNightlyAtomic)
        external
        returns (address);
}

/// @notice Deployment and quote-signing helpers shared by the C9 invariant and adversarial suites.
/// Constants are the spec's values (section 13), never read from the implementation.
abstract contract C9Base is Test {
    // spec 13
    uint256 internal constant GRACE = 72 hours;
    uint256 internal constant DISPUTE_WINDOW = 14 days;
    uint256 internal constant MAX_NIGHTS = 60;
    uint256 internal constant MIN_BUFFER_BPS = 1_000;
    uint256 internal constant LOSS_WINDOW = 6 hours;
    uint256 internal constant MAX_FREEZE = 30 days;
    uint256 internal constant FEE_DELAY = 7 days;
    uint256 internal constant ARB_DELAY = 7 days;
    uint256 internal constant FEE_RECIPIENT_DELAY = 7 days;
    uint256 internal constant MIN_LOSS = 1e6; // ADR 0010 section 4
    uint16 internal constant MAX_FEE_BPS = 2_000;

    // deployment parameters used by this suite
    uint16 internal constant ESCROW_MAX_FEE = 1_500;
    uint16 internal constant ESCROW_FEE = 500;
    uint256 internal constant CAP = 1e15;
    uint256 internal constant MIN_NIGHTLY = 50e6;
    uint256 internal constant T0 = 1_760_000_000;

    bytes32 internal constant CUTOFF_TYPEHASH = keccak256("Cutoff(uint40 cutoffUtc,uint16 refundBps)");
    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 resourceId,uint40 checkInUtc,uint40 checkOutUtc,uint256 priceAtomic,uint16 feeBps,"
        "uint16 guestYieldBps,bytes32 policyHash,Cutoff[] cutoffs,uint16 finalBps,address guest,uint40 expiresAt,"
        "bytes32 salt)Cutoff(uint40 cutoffUtc,uint16 refundBps)"
    );

    C9Usdc internal usdc;
    C9Vault internal vault;
    Escrow internal impl;
    EscrowFactory internal factory;
    address internal escAddr;
    IEscrow internal esc;
    IEscrowViews internal escV;

    address internal admin;
    address internal guardian;
    address internal arbA1;
    address internal arbA2;
    address internal feeR1;
    address internal feeR2;
    address internal escOwner;
    address internal payout1;
    address internal payout2;
    address internal rebalancer;
    address internal attacker;
    address internal signer;
    uint256 internal signerPk;
    uint256 internal attackerPk;
    address[4] internal guests;
    uint256[4] internal guestPks;

    function _deployAll() internal {
        vm.warp(T0);
        admin = makeAddr("c9.factoryAdmin");
        guardian = makeAddr("c9.guardian");
        arbA1 = makeAddr("c9.arbitrator1");
        arbA2 = makeAddr("c9.arbitrator2");
        feeR1 = makeAddr("c9.feeRecipient1");
        feeR2 = makeAddr("c9.feeRecipient2");
        escOwner = makeAddr("c9.owner");
        payout1 = makeAddr("c9.payout1");
        payout2 = makeAddr("c9.payout2");
        rebalancer = makeAddr("c9.rebalancer");
        (attacker, attackerPk) = makeAddrAndKey("c9.attacker");
        (signer, signerPk) = makeAddrAndKey("c9.quoteSigner.local");
        for (uint256 i; i < 4; i++) {
            (guests[i], guestPks[i]) = makeAddrAndKey(string.concat("c9.guest", vm.toString(i)));
        }

        usdc = new C9Usdc();
        vault = new C9Vault(usdc);
        _seedVault(); // before the factory accepts the vault (docs/adr/0013 §1)
        impl = new Escrow();
        factory = new EscrowFactory(admin, address(usdc), address(impl), feeR1, guardian, arbA1, address(vault));

        vm.prank(admin);
        IFactoryAdmin(address(factory)).approveOwner(escOwner, ESCROW_MAX_FEE, ESCROW_FEE, CAP);
        vm.prank(escOwner);
        escAddr = IFactoryAdmin(address(factory)).createEscrow(payout1, signer, MIN_NIGHTLY);
        esc = IEscrow(escAddr);
        escV = IEscrowViews(escAddr);
        vm.prank(escOwner);
        esc.setRebalancer(rebalancer);

        usdc.watch(escAddr, address(vault));
        for (uint256 i; i < 4; i++) {
            usdc.setAllowedFromEscrow(guests[i], true);
            usdc.mint(guests[i], 1e13);
        }
        usdc.setAllowedFromEscrow(payout1, true);
        usdc.setAllowedFromEscrow(payout2, true);
        usdc.setAllowedFromEscrow(feeR1, true);
        usdc.setAllowedFromEscrow(feeR2, true);
        usdc.setAllowedFromEscrow(address(vault), true);
        usdc.mint(escOwner, 1e13);
        usdc.mint(attacker, 1e13);
    }

    /// A third-party LP holds 1M USDC in the vault, as in a live market (the Aave wrapper is never
    /// empty). The empty-vault inflation case is covered separately by a targeted test.
    function _seedVault() internal virtual {
        address lp = makeAddr("c9.vaultLp");
        usdc.mint(lp, 1e12);
        vm.startPrank(lp);
        usdc.approve(address(vault), 1e12);
        vault.deposit(1e12, lp);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- EIP-712 (independent)

    function _hashCutoffs(Cutoff[] memory cs) internal pure returns (bytes32) {
        bytes32[] memory hs = new bytes32[](cs.length);
        for (uint256 i; i < cs.length; i++) {
            hs[i] = keccak256(abi.encode(CUTOFF_TYPEHASH, cs[i].cutoffUtc, cs[i].refundBps));
        }
        return keccak256(abi.encodePacked(hs));
    }

    /// @dev Spec 4.1: bookingId = EIP-712 hashStruct(quote), computed here from the struct definition.
    function _hashStruct(Quote memory q) internal pure returns (bytes32) {
        bytes memory a = abi.encode(
            QUOTE_TYPEHASH, q.resourceId, q.checkInUtc, q.checkOutUtc, q.priceAtomic, q.feeBps, q.guestYieldBps
        );
        bytes memory b = abi.encode(
            q.policyHash, _hashCutoffs(q.cutoffs), q.finalBps, q.guest, q.expiresAt, q.salt
        );
        return keccak256(bytes.concat(a, b));
    }

    function _domainSeparator(address escrow) internal view returns (bytes32) {
        (, string memory name, string memory version,,,,) = IEscrowViews(escrow).eip712Domain();
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                escrow
            )
        );
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signQuote(uint256 pk, address escrow, Quote memory q) internal view returns (bytes memory) {
        return _sign(pk, IEscrow(escrow).quoteDigest(q));
    }

    function _assetsOf(address escrow) internal view returns (uint256) {
        return usdc.balanceOf(escrow) + vault.previewRedeem(vault.balanceOf(escrow));
    }
}
