// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {Escrow} from "../../src/Escrow.sol";
import {EscrowFactory} from "../../src/EscrowFactory.sol";
import {Quote, Cutoff} from "../../src/interfaces/IEscrow.sol";

interface IFiatTokenV2_2 {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address) external view returns (uint256);
    function PERMIT_TYPEHASH() external view returns (bytes32);
}

/// Real Base USDC on a pinned mainnet fork (C1 acceptance). Run with:
///   BASE_RPC_URL=https://mainnet.base.org forge test --match-path 'test/fork/*'
/// Skips when BASE_RPC_URL is unset.
contract UsdcDepositForkTest is Test {
    /// Native USDC on Base mainnet. Sources: base/docs (commit 5d18728, 2026-09-25) and
    /// bgd-labs/aave-address-book AaveV3Base.USDC_UNDERLYING (commit f985820, 2026-09-26).
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    /// Pinned for reproducibility. Derived from Base's 2 s block time from genesis
    /// (1686789347), aimed at 2026-09-01; test_forkBlockIsWhereWeThinkItIs checks it.
    uint256 internal constant FORK_BLOCK = 50_715_726;

    Escrow internal escrow;
    EscrowFactory internal factory;
    uint256 internal signerKey;
    address internal signer;
    uint256 internal guestKey;
    address internal guest;
    address internal admin = makeAddr("admin");
    address internal owner = makeAddr("owner");

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc, FORK_BLOCK);
        (signer, signerKey) = makeAddrAndKey("signer");
        (guest, guestKey) = makeAddrAndKey("guest");
        Escrow impl = new Escrow();
        factory = new EscrowFactory(
            admin, USDC, address(impl), makeAddr("feeTo"), makeAddr("guardian"), makeAddr("arb"), address(0)
        );
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, 500, 1e15);
        vm.prank(owner);
        escrow = Escrow(factory.createEscrow(makeAddr("payout"), signer, 100e6));
    }

    function test_forkBlockIsWhereWeThinkItIs() public view {
        assertGe(block.timestamp, 1_788_220_800 - 1 days); // 2026-09-01 ± 1 day
        assertLe(block.timestamp, 1_788_220_800 + 1 days);
    }

    /// Brief: confirm the Base USDC permit interface before relying on depositWithPermit.
    function test_usdcIsFiatTokenV2WithEip2612Permit() public view {
        IFiatTokenV2_2 t = IFiatTokenV2_2(USDC);
        assertEq(t.name(), "USD Coin");
        assertEq(t.decimals(), 6);
        assertEq(t.version(), "2");
        assertEq(
            t.PERMIT_TYPEHASH(),
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
        );
        assertEq(
            t.DOMAIN_SEPARATOR(),
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("USD Coin"),
                    keccak256("2"),
                    uint256(8453),
                    USDC
                )
            )
        );
    }

    function _quote() internal view returns (Quote memory q) {
        q.resourceId = keccak256("villa");
        q.checkInUtc = uint40(block.timestamp + 60 days);
        q.checkOutUtc = uint40(block.timestamp + 67 days);
        q.priceAtomic = 5_600e6;
        q.feeBps = 500;
        q.guestYieldBps = 5_000;
        q.policyHash = keccak256("policy");
        q.cutoffs = new Cutoff[](1);
        q.cutoffs[0] = Cutoff(uint40(block.timestamp + 30 days), 10_000);
        q.guest = guest;
        q.expiresAt = uint40(block.timestamp + 15 minutes);
        q.salt = keccak256(abi.encode(block.number));
    }

    function _sign(Quote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, escrow.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _permit(uint256 value, uint256 deadline) internal view returns (uint8, bytes32, bytes32) {
        IFiatTokenV2_2 t = IFiatTokenV2_2(USDC);
        bytes32 structHash = keccak256(
            abi.encode(t.PERMIT_TYPEHASH(), guest, address(escrow), value, t.nonces(guest), deadline)
        );
        return vm.sign(guestKey, keccak256(abi.encodePacked("\x19\x01", t.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_deposit_allowancePath() public {
        Quote memory q = _quote();
        deal(USDC, guest, q.priceAtomic);
        bytes memory sig = _sign(q);
        vm.startPrank(guest);
        IERC20(USDC).approve(address(escrow), q.priceAtomic);
        escrow.deposit(q, sig);
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(address(escrow)), q.priceAtomic);
    }

    function test_depositWithPermit() public {
        Quote memory q = _quote();
        deal(USDC, guest, q.priceAtomic);
        bytes memory sig = _sign(q);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(q.priceAtomic, deadline);
        vm.prank(guest);
        escrow.depositWithPermit(q, sig, deadline, v, r, s);
        assertEq(IERC20(USDC).balanceOf(address(escrow)), q.priceAtomic);
    }

    function test_depositWithPermit_frontRun() public {
        Quote memory q = _quote();
        deal(USDC, guest, q.priceAtomic);
        bytes memory sig = _sign(q);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(q.priceAtomic, deadline);
        vm.prank(makeAddr("griefer"));
        IERC20Permit(USDC).permit(guest, address(escrow), q.priceAtomic, deadline, v, r, s);
        vm.prank(guest);
        escrow.depositWithPermit(q, sig, deadline, v, r, s);
        assertEq(IERC20(USDC).balanceOf(address(escrow)), q.priceAtomic);
    }

    function test_cancelAndClaimRealUsdc() public {
        test_deposit_allowancePath();
        bytes32 id = escrow.hashQuote(_quote());
        vm.startPrank(guest);
        escrow.cancelByGuest(id);
        escrow.claim();
        vm.stopPrank();
        assertEq(IERC20(USDC).balanceOf(guest), 5_600e6);
    }
}
