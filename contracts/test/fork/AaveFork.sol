// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Minimal Aave V3 Pool surface used by the fork tests.
interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    function borrow(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        uint16 referralCode,
        address onBehalfOf
    ) external;
    function getVirtualUnderlyingBalance(address asset) external view returns (uint128);
}

/// Base mainnet fork fixtures for C4 (D5). Every address is from bgd-labs/aave-address-book
/// `src/AaveV3Base.sol` at commit f9858202f5cd9a22a8b3555762802441c6b9c207 (2026-09-26), and is
/// re-checked on the fork in AaveSpikeForkTest.test_addressesMatchTheAddressBookOnChain.
abstract contract AaveFork is Test {
    uint256 internal constant FORK_BLOCK = 50_715_726; // same pinned block as C1 (2026-09-01)

    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // USDC_UNDERLYING
    address internal constant POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5; // POOL
    address internal constant A_USDC = 0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB; // USDC_A_TOKEN
    address internal constant STATA_USDC = 0xC768c589647798a6EE01A91FdE98EF2ed046DBD6; // USDC_STATA_TOKEN
    address internal constant WETH = 0x4200000000000000000000000000000000000006; // WETH_UNDERLYING
    address internal constant ACL_ADMIN = 0x9390B1735def18560c509E2d0bc090E9d6BA257a; // ACL_ADMIN
    address internal constant ACL_MANAGER = 0x43955b0899Ab7232E3a454cf84AedD22Ad46FD33; // ACL_MANAGER

    bool internal forked;

    function _fork() internal {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        forked = true;
    }

    function _available() internal view returns (uint256) {
        return IAavePool(POOL).getVirtualUnderlyingBalance(USDC);
    }

    /// Liquidity crunch: a funded account supplies WETH and borrows USDC until only `leave` USDC is
    /// available in the market (brief test 2).
    function _crunch(uint256 leave) internal {
        address whale = makeAddr("aave-borrower");
        uint256 avail = _available();
        require(avail > leave, "already tighter than requested");
        deal(WETH, whale, 60_000 ether);
        vm.startPrank(whale);
        IERC20(WETH).approve(POOL, type(uint256).max);
        IAavePool(POOL).supply(WETH, 60_000 ether, whale, 0);
        IAavePool(POOL).borrow(USDC, avail - leave, 2, 0, whale);
        vm.stopPrank();
    }
}
