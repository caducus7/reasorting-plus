// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DeployTestnetVault} from "../../script/DeployTestnetVault.s.sol";
import {MockYieldVault} from "../../src/testnet/MockYieldVault.sol";

/// Runs the testnet vault script against a Base Sepolia fork (BASE_SEPOLIA_RPC_URL; skipped without).
/// Nothing is broadcast: forge tests never send transactions.
contract DeployTestnetVaultForkTest is Test {
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function test_deploysAndBurnsTheSeedOnSepolia() public {
        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        address vaultOwner = makeAddr("vaultOwner");
        vm.setEnv("VAULT_OWNER", vm.toString(vaultOwner));
        DeployTestnetVault s = new DeployTestnetVault();
        deal(USDC, msg.sender, 1); // the broadcaster in a test is the default sender
        MockYieldVault v = s.run();
        assertEq(v.asset(), USDC);
        assertEq(v.owner(), vaultOwner);
        assertEq(v.apyBps(), 500);
        assertEq(v.balanceOf(address(0xdEaD)), 1e12, "seed shares burned");
        assertEq(IERC20(USDC).balanceOf(address(v)), 1);
    }

    function test_refusesAnyOtherChain() public {
        DeployTestnetVault s = new DeployTestnetVault();
        vm.expectRevert(bytes("DeployTestnetVault: wrong chain"));
        s.run();
    }
}
