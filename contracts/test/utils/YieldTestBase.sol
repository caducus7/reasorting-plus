// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowTestBase} from "./EscrowTestBase.sol";
import {MockVault} from "./Mocks.sol";
import {Escrow} from "../../src/Escrow.sol";
import {Quote} from "../../src/interfaces/IEscrow.sol";

/// Escrow with an ERC-4626 vault whose share price the test moves: `_gain` mints USDC into the
/// vault, `_loss` burns it. `rebalancer` deploys and redeems.
abstract contract YieldTestBase is EscrowTestBase {
    MockVault internal vault;
    address internal rebalancer = makeAddr("rebalancer");

    function setUp() public virtual override {
        super.setUp();
        vault = new MockVault(IERC20(address(usdc)));
        _seedVault(address(vault), 1);
        vm.prank(admin);
        factory.setDefaultVault(address(vault));
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100 * USDC));
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
    }

    /// The deployer's initial deposit against the inflation attack (docs/adr/0013 §1): `amount`
    /// USDC atomic units, shares burned to 0xdead so the seed can never be withdrawn.
    function _seedVault(address v, uint256 amount) internal {
        address lp = makeAddr("vaultSeeder");
        usdc.mint(lp, amount);
        vm.startPrank(lp);
        usdc.approve(v, amount);
        MockVault(v).deposit(amount, address(0xdEaD));
        vm.stopPrank();
    }

    /// Owner funds the reserve up to the floor that deploy requires (docs/adr/0013 §5).
    function _fundReserveFloor() internal {
        uint256 have = escrow.reserve();
        if (have >= 1 * USDC) return;
        _fund(owner, 1 * USDC - have);
        vm.prank(owner);
        escrow.fundReserve(1 * USDC - have);
    }

    function _gain(uint256 amount) internal {
        usdc.mint(address(vault), amount);
    }

    function _loss(uint256 amount) internal {
        usdc.burn(address(vault), amount);
    }

    function _deploy(uint256 amount) internal {
        _fundReserveFloor();
        vm.prank(rebalancer);
        escrow.deploy(amount);
    }

    /// Deploys the maximum the caps allow: 90% of liabilities, keeping a 10% idle buffer.
    function _deployMax() internal {
        uint256 liabilities = escrow.totalOpenPrincipal() + escrow.totalDisputed()
            + escrow.totalPendingYield() + escrow.totalClaimable();
        uint256 deployed = vault.previewRedeem(vault.balanceOf(address(escrow)));
        uint256 cap = liabilities * 9_000 / 10_000;
        if (cap > deployed) _deploy(cap - deployed);
    }

    function _settleAfterStay(bytes32 id, Quote memory q) internal {
        vm.warp(uint256(q.checkOutUtc) + 72 hours);
        escrow.settle(id);
    }

    /// Books identity (LedgerLib header): exact after every state-changing call.
    function _assertBooksBalance() internal view {
        assertEq(
            escrow.lastAssets() + escrow.lossDebt(),
            escrow.totalOpenPrincipal() + escrow.totalDisputed() + escrow.totalClaimable()
                + escrow.totalPendingYield() + escrow.reserve() + escrow.yieldUnallocated(),
            "books identity"
        );
    }
}
