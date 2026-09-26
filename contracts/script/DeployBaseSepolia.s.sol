// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";

/// @notice Deploys the Escrow implementation and the EscrowFactory to Base Sepolia. Refuses any other chain.
///
/// Simulate (no transactions sent):
///   forge script script/DeployBaseSepolia.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL
/// Deploy, with the owner's testnet wallet (never a raw key in a file):
///   forge script script/DeployBaseSepolia.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --account <keystore> --broadcast
///
/// Environment: FACTORY_ADMIN, FEE_RECIPIENT, GUARDIAN, ARBITRATOR (Safes before mainnet, spec 12.3);
/// DEFAULT_VAULT optional (ERC-4626 over USDC, default none).
contract DeployBaseSepolia is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// Circle native USDC on Base Sepolia. The EIP-55 checksum validates. One Base docs page
    /// (base/docs call-a-paid-service.mdx, commit 5d18728) prints `...3dCF7c`, which fails its own
    /// checksum; this constant is the checksum-valid form. The checks below confirm on-chain.
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (Escrow impl, EscrowFactory factory) {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "DeployBaseSepolia: wrong chain");
        require(USDC.code.length > 0, "DeployBaseSepolia: USDC has no code");
        require(IERC20Metadata(USDC).decimals() == 6, "DeployBaseSepolia: USDC decimals");
        require(
            keccak256(bytes(IERC20Metadata(USDC).symbol())) == keccak256("USDC"),
            "DeployBaseSepolia: USDC symbol"
        );

        address admin = vm.envAddress("FACTORY_ADMIN");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        address guardian = vm.envAddress("GUARDIAN");
        address arbitrator = vm.envAddress("ARBITRATOR");
        address vault = vm.envOr("DEFAULT_VAULT", address(0));

        vm.startBroadcast();
        impl = new Escrow();
        factory = new EscrowFactory(admin, USDC, address(impl), feeRecipient, guardian, arbitrator, vault);
        vm.stopBroadcast();

        console2.log("Escrow implementation:", address(impl));
        console2.log("EscrowFactory:        ", address(factory));
    }
}
