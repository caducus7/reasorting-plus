// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {AdapterConformance} from "../utils/AdapterConformance.sol";
import {Escrow} from "../../src/Escrow.sol";
import {MockYieldVault} from "../../src/testnet/MockYieldVault.sol";

/// Conformance: no vault (address(0), the former NullAdapter).
contract NoVaultConformanceTest is EscrowTestBase, AdapterConformance {
    address internal rebalancer = makeAddr("rebalancer");

    function setUp() public virtual override {
        super.setUp();
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
    }

    function _cEscrow() internal view override returns (Escrow) {
        return escrow;
    }

    function _cUsdc() internal view override returns (IERC20) {
        return IERC20(address(usdc));
    }

    function _cSignerKey() internal view override returns (uint256) {
        return signerKey;
    }

    function _cRebalancer() internal view override returns (address) {
        return rebalancer;
    }

    function _cOwner() internal view override returns (address) {
        return owner;
    }

    function _cDeal(address to, uint256 amount) internal override {
        usdc.mint(to, amount);
    }

    function _cLimit(uint256) internal virtual override {}
}

/// Conformance: the testnet MockYieldVault (spec 6.6 mock vault).
contract MockYieldVaultConformanceTest is NoVaultConformanceTest {
    MockYieldVault internal mv;
    address internal vaultOwner = makeAddr("vaultOwner");

    function setUp() public override {
        EscrowTestBase.setUp();
        mv = new MockYieldVault(IERC20(address(usdc)), vaultOwner, 500); // 5% APY
        usdc.mint(address(this), 1);
        usdc.approve(address(mv), 1);
        mv.deposit(1, address(0xdEaD)); // burned seed (ADR 0013 §1)
        usdc.mint(address(mv), 1_000e6); // yield budget
        vm.prank(admin);
        factory.setDefaultVault(address(mv));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
    }

    function _cLimit(uint256 leave) internal override {
        vm.prank(vaultOwner);
        mv.setWithdrawLimit(leave);
    }
}
