// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

/// @notice Onboarding terms the factory admin offers an owner; the owner accepts by calling
/// `createEscrow` (docs/adr/0007, review 0001 finding 4).
struct OwnerTerms {
    bool approved;
    uint16 maxFeeBps; // immutable ceiling for this escrow, <= MAX_FEE_BPS
    uint16 feeBps; // initial fee, <= maxFeeBps
    uint256 maxOpenPrincipalAtomic; // initial escrowed-value cap (spec 12.3)
}

interface IEscrowFactory {
    event EscrowCreated(
        address indexed escrow,
        address indexed owner,
        address indexed implementation,
        uint16 maxFeeBps,
        uint16 feeBps,
        address arbitrator,
        address vault
    );
    event OwnerApproved(
        address indexed owner, uint16 maxFeeBps, uint16 feeBps, uint256 maxOpenPrincipalAtomic
    );
    event OwnerApprovalRevoked(address indexed owner);
    event FeeRecipientProposed(address feeRecipient, uint64 effectiveAt);
    event ImplementationSet(address implementation);
    event DefaultArbitratorSet(address arbitrator);
    event DefaultVaultSet(address vault);
    event GuardianSet(address guardian);

    error ZeroAddress();
    error FeeAboveMax();
    error NotApproved();
    error VaultAssetMismatch();

    function MAX_FEE_BPS() external view returns (uint16);
    function FEE_CHANGE_DELAY() external view returns (uint32);
    function FEE_RECIPIENT_DELAY() external view returns (uint32);
    function ARBITRATOR_DELAY() external view returns (uint32);

    function usdc() external view returns (address);
    function owner() external view returns (address); // factoryAdmin
    function guardian() external view returns (address);
    function feeRecipient() external view returns (address);
    function isEscrow(address escrow) external view returns (bool);

    function createEscrow(address payoutAddress, address quoteSigner, uint256 minNightlyAtomic)
        external
        returns (address escrow);
}
