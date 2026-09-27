// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Script} from "forge-std/Script.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";
import {MockUSDC, BatchWallet} from "../test/utils/Mocks.sol";

/// @notice Local Anvil deployment for service integration tests (C5 onwards). Refuses any chain but
/// 31337. Uses Anvil's default dev keys (CLAUDE.md section 9): never use these anywhere else.
/// Writes deployments/local.json.
///
///   anvil &
///   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
contract DeployLocal is Script {
    // Anvil default accounts 0..5 (public test mnemonic).
    uint256 internal constant ADMIN_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant OWNER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;
    uint256 internal constant SIGNER_KEY = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a;
    address internal constant GUARDIAN = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // account 3
    address internal constant ARBITRATOR = 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65; // account 4
    address internal constant FEE_RECIPIENT = 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc; // account 5

    function run() external {
        require(block.chainid == 31337, "DeployLocal: Anvil only");
        address owner = vm.addr(OWNER_KEY);

        vm.startBroadcast(ADMIN_KEY);
        MockUSDC usdc = new MockUSDC();
        Escrow impl = new Escrow();
        EscrowFactory factory = new EscrowFactory(
            vm.addr(ADMIN_KEY), address(usdc), address(impl), FEE_RECIPIENT, GUARDIAN, ARBITRATOR, address(0)
        );
        factory.approveOwner(owner, 2_000, 500, 1_000_000e6);
        BatchWallet wallet = new BatchWallet();
        vm.stopBroadcast();

        vm.startBroadcast(OWNER_KEY);
        address escrow = factory.createEscrow(owner, vm.addr(SIGNER_KEY), 100e6);
        vm.stopBroadcast();

        string memory o = "local";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "factory", address(factory));
        vm.serializeAddress(o, "escrow", escrow);
        vm.serializeAddress(o, "owner", owner);
        vm.serializeAddress(o, "quoteSigner", vm.addr(SIGNER_KEY));
        vm.serializeAddress(o, "admin", vm.addr(ADMIN_KEY));
        vm.serializeAddress(o, "arbitrator", ARBITRATOR);
        vm.serializeAddress(o, "feeRecipient", FEE_RECIPIENT);
        string memory json = vm.serializeAddress(o, "batchWallet", address(wallet));
        vm.writeJson(json, "./deployments/local.json");
    }
}
