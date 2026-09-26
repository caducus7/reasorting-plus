// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {EscrowTestBase} from "../utils/EscrowTestBase.sol";
import {Quote, Cutoff} from "../../src/interfaces/IEscrow.sol";

contract QuoteLibTest is EscrowTestBase {
    /// Cross-workstream vector: the same quote hashed by services/apps/api-stub (viem hashStruct).
    /// If this fails, the checkout and the contract disagree on bookingId.
    function test_bookingIdMatchesViemVector() public view {
        Quote memory q;
        q.resourceId = 0x44f68f1266a79abc7890beb4d91798109aa8bbe84efb1d8f50db3cf9b5ce51ea;
        q.checkInUtc = 1795611600;
        q.checkOutUtc = 1796209200;
        q.priceAtomic = 5_600_000_000;
        q.feeBps = 500;
        q.guestYieldBps = 5_000;
        q.policyHash = 0x1111111111111111111111111111111111111111111111111111111111111111;
        q.cutoffs = new Cutoff[](3);
        q.cutoffs[0] = Cutoff(1793030400, 10_000);
        q.cutoffs[1] = Cutoff(1794412800, 5_000);
        q.cutoffs[2] = Cutoff(1795017600, 2_500);
        q.finalBps = 0;
        q.guest = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
        q.expiresAt = 1790000000;
        q.salt = 0x2222222222222222222222222222222222222222222222222222222222222222;
        assertEq(escrow.hashQuote(q), 0x2752bd9fec3f68b8d62310995b40e43f31b750970bda6151900b2a8a7741b6eb);
    }

    /// The digest is domain-bound to this escrow and chain: a signature for one escrow is useless on another.
    function test_digestBoundToEscrowAndChain() public {
        Quote memory q = _quote();
        bytes32 d1 = escrow.quoteDigest(q);
        vm.prank(admin);
        factory.approveOwner(owner, 2_000, FEE, CAP);
        vm.prank(owner);
        address other = factory.createEscrow(payout, signer, 100 * USDC);
        assertEq(escrow.quoteDigest(q), d1, "same escrow, same digest");
        (bool ok, bytes memory ret) = other.staticcall(abi.encodeCall(escrow.quoteDigest, (q)));
        assertTrue(ok);
        assertTrue(abi.decode(ret, (bytes32)) != d1, "different escrow, different digest");
        vm.chainId(999);
        assertTrue(escrow.quoteDigest(q) != d1, "different chain, different digest");
    }
}
