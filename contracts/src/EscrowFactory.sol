// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {Escrow} from "./Escrow.sol";
import {EscrowInit} from "./interfaces/IEscrow.sol";
import {IEscrowFactory, OwnerTerms} from "./interfaces/IEscrowFactory.sol";
import {Params} from "./libraries/Params.sol";

/// @title EscrowFactory
/// @notice Deploys one `Escrow` per property owner as an EIP-1167 minimal clone of the current
/// implementation, and holds platform-level configuration (spec 3.2 to 3.4). `owner()` is the
/// factoryAdmin and must be a Safe. It can never move escrowed funds.
contract EscrowFactory is IEscrowFactory, Ownable2Step {
    uint16 public constant MAX_FEE_BPS = Params.MAX_FEE_BPS;
    uint32 public constant FEE_CHANGE_DELAY = Params.FEE_CHANGE_DELAY;
    uint32 public constant FEE_RECIPIENT_DELAY = Params.FEE_RECIPIENT_DELAY;
    uint32 public constant ARBITRATOR_DELAY = Params.ARBITRATOR_DELAY;

    address public immutable usdc;

    /// @notice Implementation cloned for **new** escrows. Existing escrows never change.
    address public implementation;
    address public defaultArbitrator;
    address public defaultVault; // ERC-4626 over USDC, or address(0) (docs/adr/0008)
    /// @notice Read live by every escrow, so a compromised guardian Safe is replaced in one call.
    address public guardian;

    address internal _feeRecipient;
    address public pendingFeeRecipient;
    uint64 public pendingFeeRecipientAt;

    mapping(address => OwnerTerms) public ownerTerms;
    mapping(address => bool) public isEscrow;

    constructor(
        address admin,
        address usdc_,
        address implementation_,
        address feeRecipient_,
        address guardian_,
        address defaultArbitrator_,
        address defaultVault_
    ) Ownable(admin) {
        if (
            usdc_ == address(0) || implementation_ == address(0) || feeRecipient_ == address(0)
                || guardian_ == address(0) || defaultArbitrator_ == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        _setImplementation(implementation_);
        _feeRecipient = feeRecipient_;
        _setGuardian(guardian_);
        _setDefaultArbitrator(defaultArbitrator_);
        _setDefaultVault(defaultVault_);
        emit FeeRecipientProposed(feeRecipient_, uint64(block.timestamp));
    }

    // ------------------------------------------------------------------------------------------
    // Onboarding: admin offers terms, owner accepts by creating (docs/adr/0007)

    function approveOwner(
        address escrowOwner,
        uint16 maxFeeBps,
        uint16 feeBps,
        uint256 maxOpenPrincipalAtomic
    ) external onlyOwner {
        if (escrowOwner == address(0)) revert ZeroAddress();
        if (maxFeeBps > MAX_FEE_BPS || feeBps > maxFeeBps) revert FeeAboveMax();
        ownerTerms[escrowOwner] = OwnerTerms(true, maxFeeBps, feeBps, maxOpenPrincipalAtomic);
        emit OwnerApproved(escrowOwner, maxFeeBps, feeBps, maxOpenPrincipalAtomic);
    }

    function revokeOwner(address escrowOwner) external onlyOwner {
        delete ownerTerms[escrowOwner];
        emit OwnerApprovalRevoked(escrowOwner);
    }

    /// @notice Called by the approved owner, which is their on-chain consent to `maxFeeBps`.
    /// Consumes the approval; a later escrow (e.g. a migration) needs a fresh one.
    function createEscrow(address payoutAddress, address quoteSigner, uint256 minNightlyAtomic)
        external
        returns (address escrow)
    {
        OwnerTerms memory t = ownerTerms[msg.sender];
        if (!t.approved) revert NotApproved();
        delete ownerTerms[msg.sender];

        address impl = implementation;
        address arb = defaultArbitrator;
        address v = defaultVault;
        escrow = Clones.clone(impl);
        isEscrow[escrow] = true;
        emit EscrowCreated(escrow, msg.sender, impl, t.maxFeeBps, t.feeBps, arb, v);

        Escrow(escrow)
            .initialize(
                EscrowInit({
                owner: msg.sender,
                payoutAddress: payoutAddress,
                quoteSigner: quoteSigner,
                usdc: usdc,
                vault: v,
                arbitrator: arb,
                maxFeeBps: t.maxFeeBps,
                feeBps: t.feeBps,
                maxOpenPrincipalAtomic: t.maxOpenPrincipalAtomic,
                minNightlyAtomic: minNightlyAtomic
            })
            );
    }

    // ------------------------------------------------------------------------------------------
    // Fee recipient, timelocked and read at settlement (spec 3.4)

    function feeRecipient() public view returns (address) {
        return (pendingFeeRecipientAt != 0 && block.timestamp >= pendingFeeRecipientAt)
            ? pendingFeeRecipient
            : _feeRecipient;
    }

    function proposeFeeRecipient(address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        _feeRecipient = feeRecipient(); // promote an already-effective change before overwriting
        uint64 effectiveAt = uint64(block.timestamp + FEE_RECIPIENT_DELAY);
        pendingFeeRecipient = newFeeRecipient;
        pendingFeeRecipientAt = effectiveAt;
        emit FeeRecipientProposed(newFeeRecipient, effectiveAt);
    }

    // ------------------------------------------------------------------------------------------
    // Defaults for new escrows, and the guardian

    function setImplementation(address a) external onlyOwner {
        _setImplementation(a);
    }

    function setDefaultArbitrator(address a) external onlyOwner {
        _setDefaultArbitrator(a);
    }

    function setDefaultVault(address a) external onlyOwner {
        _setDefaultVault(a);
    }

    function setGuardian(address a) external onlyOwner {
        _setGuardian(a);
    }

    function _setImplementation(address a) private {
        if (a.code.length == 0) revert ZeroAddress();
        implementation = a;
        emit ImplementationSet(a);
    }

    function _setDefaultArbitrator(address a) private {
        if (a == address(0)) revert ZeroAddress();
        defaultArbitrator = a;
        emit DefaultArbitratorSet(a);
    }

    function _setDefaultVault(address a) private {
        if (a != address(0)) {
            if (IERC4626(a).asset() != usdc) revert VaultAssetMismatch();
            // The deployer's initial deposit (docs/adr/0013 §1); deploy re-checks it.
            if (IERC4626(a).totalSupply() < Params.MIN_VAULT_SUPPLY) revert VaultNotSeeded();
        }
        defaultVault = a;
        emit DefaultVaultSet(a);
    }

    function _setGuardian(address a) private {
        if (a == address(0)) revert ZeroAddress();
        guardian = a;
        emit GuardianSet(a);
    }

    /// @dev Renouncing would freeze fee and arbitrator administration for every escrow.
    function renounceOwnership() public view override onlyOwner {
        revert ZeroAddress();
    }

    // IEscrowFactory
    function owner() public view override(Ownable, IEscrowFactory) returns (address) {
        return super.owner();
    }
}
