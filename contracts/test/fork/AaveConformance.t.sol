// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AaveFork} from "./AaveFork.sol";
import {AdapterConformance} from "../utils/AdapterConformance.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";

/// Conformance: Aave's StataTokenV2 (the D5 choice, docs/adr/0016) on the pinned Base fork.
contract AaveStataConformanceForkTest is AaveFork, AdapterConformance {
    Escrow internal escrow;
    address internal owner = makeAddr("owner");
    address internal rebalancer = makeAddr("rebalancer");
    uint256 internal signerKey;

    function setUp() public {
        _fork();
        if (!forked) return;
        address signer;
        (signer, signerKey) = makeAddrAndKey("c4-conformance-signer");
        Escrow impl = new Escrow();
        address admin = makeAddr("admin");
        EscrowFactory factory = new EscrowFactory(
            admin, USDC, address(impl), makeAddr("feeTo"), makeAddr("guardian"), makeAddr("arb"), STATA_USDC
        );
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, 500, 1e15);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(makeAddr("payout"), signer, 100e6));
        vm.prank(owner);
        escrow.setRebalancer(rebalancer);
    }

    function _cEscrow() internal view override returns (Escrow) {
        return escrow;
    }

    function _cUsdc() internal pure override returns (IERC20) {
        return IERC20(USDC);
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
        deal(USDC, to, IERC20(USDC).balanceOf(to) + amount);
    }

    function _cLimit(uint256 leave) internal override {
        _crunch(leave); // market-wide: borrow the pool down to `leave`
    }
}
