// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {MockYieldVault} from "../src/testnet/MockYieldVault.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";

/// @notice Deploys the TESTNET MockYieldVault (spec 6.6) on Base Sepolia and burns its seed deposit
/// (ADR 0013 §1: 1 atomic unit to 0xdEaD mints 1e12 shares with the decimals offset of 12, above
/// MIN_VAULT_SUPPLY). Refuses any other chain, so the mock can never reach mainnet by this script.
///
/// Simulate (no transactions sent; the sender needs 1 atomic unit of Sepolia USDC for the seed):
///   forge script script/DeployTestnetVault.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --sender <wallet>
/// Deploy, with the owner's testnet wallet (never a raw key in a file):
///   forge script script/DeployTestnetVault.s.sol --rpc-url $BASE_SEPOLIA_RPC_URL --account <keystore> --broadcast
///
/// The script does not call `setDefaultVault`: the factory admin (a Safe before mainnet) does, with
/// the calldata printed at the end. Top up the yield budget by transferring USDC to the vault.
///
/// Environment: VAULT_OWNER (holds the APY, limit and loss knobs); VAULT_APY_BPS optional (default
/// 500, 5%); FACTORY optional (only to print the target of the setDefaultVault call).
contract DeployTestnetVault is Script {
    uint256 internal constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /// Circle native USDC on Base Sepolia; same constant and checks as DeployBaseSepolia.s.sol.
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant SEED_SINK = address(0xdEaD);
    uint256 internal constant SEED_ASSETS = 1;

    function run() external returns (MockYieldVault vault) {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "DeployTestnetVault: wrong chain");
        require(USDC.code.length > 0, "DeployTestnetVault: USDC has no code");
        require(IERC20Metadata(USDC).decimals() == 6, "DeployTestnetVault: USDC decimals");
        require(
            keccak256(bytes(IERC20Metadata(USDC).symbol())) == keccak256("USDC"),
            "DeployTestnetVault: USDC symbol"
        );
        address vaultOwner = vm.envAddress("VAULT_OWNER");
        uint256 apyBps = vm.envOr("VAULT_APY_BPS", uint256(500));

        vm.startBroadcast();
        vault = new MockYieldVault(IERC20(USDC), vaultOwner, apyBps);
        IERC20(USDC).approve(address(vault), SEED_ASSETS);
        vault.deposit(SEED_ASSETS, SEED_SINK);
        vm.stopBroadcast();

        require(vault.totalSupply() >= 1e6, "DeployTestnetVault: seed below MIN_VAULT_SUPPLY");
        console2.log("MockYieldVault:", address(vault));
        console2.log("Seed shares burned to 0xdEaD:", vault.balanceOf(SEED_SINK));
        address factory = vm.envOr("FACTORY", address(0));
        if (factory != address(0)) console2.log("Factory admin calls:", factory);
        console2.log("setDefaultVault calldata:");
        console2.logBytes(abi.encodeCall(EscrowFactory.setDefaultVault, (address(vault))));
    }
}
