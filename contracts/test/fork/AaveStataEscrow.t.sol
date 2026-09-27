// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {AaveFork} from "./AaveFork.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {Quote, Cutoff} from "../../src/interfaces/IEscrow.sol";

interface IStataPause {
    function setPaused(bool) external;
}

interface IAclManager {
    function addEmergencyAdmin(address admin) external;
}

/// C4 brief tests 1 to 3 through the real escrow, with Aave's StataTokenV2 (the D5 choice,
/// docs/adr/0016) as the escrow's vault, on the pinned Base fork.
contract AaveStataEscrowForkTest is AaveFork {
    Escrow internal escrow;
    IERC4626 internal vault = IERC4626(STATA_USDC);
    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");
    address internal payout = makeAddr("payout");
    address internal rebalancer = makeAddr("rebalancer");
    address internal signer;
    uint256 internal signerKey;
    address internal guest;

    function setUp() public {
        _fork();
        if (!forked) return;
        (signer, signerKey) = makeAddrAndKey("c4-fork-quote-signer");
        guest = makeAddr("c4-fork-guest");
        Escrow impl = new Escrow();
        EscrowFactory factory = new EscrowFactory(
            admin, USDC, address(impl), makeAddr("feeTo"), makeAddr("guardian"), makeAddr("arb"), STATA_USDC
        );
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, 500, 1e15);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(payout, signer, 100e6));
        vm.startPrank(owner);
        escrow.setRebalancer(rebalancer);
        deal(USDC, owner, 1e6);
        IERC20(USDC).approve(address(escrow), 1e6);
        escrow.fundReserve(1e6); // reserve floor (ADR 0013 §5)
        vm.stopPrank();
    }

    function _book(uint256 price) internal returns (bytes32 id, Quote memory q) {
        q.resourceId = keccak256("villa");
        q.checkInUtc = uint40(block.timestamp + 60 days);
        q.checkOutUtc = uint40(block.timestamp + 67 days);
        q.priceAtomic = price;
        q.feeBps = escrow.effectiveFeeBps();
        q.guestYieldBps = escrow.guestYieldBps();
        q.policyHash = keccak256("policy");
        q.cutoffs = new Cutoff[](1);
        q.cutoffs[0] = Cutoff(uint40(block.timestamp + 30 days), 10_000);
        q.finalBps = 0;
        q.guest = guest;
        q.expiresAt = uint40(block.timestamp + 15 minutes);
        q.salt = keccak256(abi.encode(price, block.timestamp));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, escrow.quoteDigest(q));
        deal(USDC, guest, price);
        vm.startPrank(guest);
        IERC20(USDC).approve(address(escrow), price);
        id = escrow.deposit(q, abi.encodePacked(r, s, v));
        vm.stopPrank();
    }

    function _deploy(uint256 amount) internal {
        vm.prank(rebalancer);
        escrow.deploy(amount);
    }

    function _position() internal view returns (uint256) {
        return vault.previewRedeem(vault.balanceOf(address(escrow)));
    }

    /// Brief test 1: deposit then full withdraw returns principal plus accrued minus at most 2 atomic
    /// units of rounding. Measured: 1 unit on a same-block round trip (AaveSpike), documented in the ADR.
    function test_roundTripReturnsPrincipalPlusAccruedLessTwo() public {
        _book(1_000_000e6);
        uint256 amount = 900_000e6;
        _deploy(amount);
        vm.warp(block.timestamp + 30 days);
        uint256 accruedView = _position();
        uint256 idleBefore = IERC20(USDC).balanceOf(address(escrow));
        uint256 max = vault.maxWithdraw(address(escrow));
        vm.prank(rebalancer);
        escrow.redeem(max);
        uint256 got = IERC20(USDC).balanceOf(address(escrow)) - idleBefore;
        assertGt(accruedView, amount, "yield accrued over 30 days");
        assertGe(got + 2, accruedView, "full withdraw returns principal plus accrued, less at most 2");
        assertLe(vault.balanceOf(address(escrow)), 1e12, "at most dust shares remain");
    }

    /// Brief test 2: available liquidity below our position. The pull is partial and nothing reverts;
    /// the guest's claim pays what the escrow can and the rest stays credited (spec 4.5).
    function test_liquidityCrunchPaysPartiallyAndKeepsTheRest() public {
        (bytes32 id,) = _book(2_000_000e6);
        _deploy(1_800_000e6);
        _crunch(300_000e6); // the market has 300k USDC left, below our 1.8M position
        vm.prank(guest);
        escrow.cancelByGuest(id); // 100% tier
        uint256 idle = IERC20(USDC).balanceOf(address(escrow));
        vm.prank(guest);
        uint256 paid = escrow.claim();
        assertGe(paid, idle + 300_000e6 - 2, "idle plus what the market could pay");
        assertLt(paid, 2_000_000e6, "partial");
        assertEq(escrow.claimableOf(guest), 2_000_000e6 - paid, "the rest stays credited");
    }

    /// Brief test 3: totalAssets never over-reports what withdraw can return at full liquidity.
    function testFuzz_totalAssetsNeverOverReports(uint256 amount, uint256 dt) public {
        _book(1_000_000e6);
        amount = bound(amount, 1e6, 900_000e6);
        dt = bound(dt, 0, 365 days);
        _deploy(amount);
        vm.warp(block.timestamp + dt);
        uint256 reported = escrow.totalAssets();
        uint256 shares = vault.balanceOf(address(escrow));
        vm.prank(address(escrow));
        vault.redeem(shares, address(escrow), address(escrow));
        // idle + what redeeming every share returned >= idle + previewRedeem(shares)
        assertGe(IERC20(USDC).balanceOf(address(escrow)), reported, "no over-report");
    }

    /// Aave pauses the wrapper while its maxWithdraw still reads the position (docs/adr/0016). A
    /// guest claim does not revert: it pays from idle, and the rest stays credited.
    function test_wrapperPauseDoesNotBlockGuestClaims() public {
        (bytes32 id,) = _book(1_000_000e6);
        _deploy(900_000e6);
        address pauser = makeAddr("aave-emergency-admin");
        vm.prank(ACL_ADMIN);
        IAclManager(ACL_MANAGER).addEmergencyAdmin(pauser);
        vm.prank(pauser);
        IStataPause(STATA_USDC).setPaused(true);
        vm.prank(guest);
        escrow.cancelByGuest(id);
        uint256 idle = IERC20(USDC).balanceOf(address(escrow));
        vm.prank(guest);
        assertEq(escrow.claim(), idle, "idle paid despite the paused wrapper");
        assertEq(escrow.claimableOf(guest), 1_000_000e6 - idle);
    }
}
