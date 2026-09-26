// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;

import {Cutoff, Quote} from "../interfaces/IEscrow.sol";

/// @notice EIP-712 struct hashing and policy-curve rules for `Quote` (spec 4.1, 4.2 guard 11, 4.3).
/// `hash` and `validCurve` are external: the library is deployed once and linked into the Escrow
/// implementation to keep it under EIP-170 (docs/adr/0010).
library QuoteLib {
    uint16 internal constant BPS = 10_000;
    uint256 internal constant MAX_CUTOFFS = 8;

    bytes32 internal constant CUTOFF_TYPEHASH = keccak256("Cutoff(uint40 cutoffUtc,uint16 refundBps)");

    /// @dev Referenced struct types are appended in alphabetical order (EIP-712 `encodeType`).
    bytes32 internal constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 resourceId,uint40 checkInUtc,uint40 checkOutUtc,uint256 priceAtomic,uint16 feeBps,"
        "uint16 guestYieldBps,bytes32 policyHash,Cutoff[] cutoffs,uint16 finalBps,address guest,uint40 expiresAt,"
        "bytes32 salt)Cutoff(uint40 cutoffUtc,uint16 refundBps)"
    );

    /// @notice EIP-712 `hashStruct(quote)`, which is also the bookingId (spec 4.1).
    function hash(Quote calldata q) external pure returns (bytes32) {
        bytes32[] memory cutoffHashes = new bytes32[](q.cutoffs.length);
        for (uint256 i; i < q.cutoffs.length; ++i) {
            cutoffHashes[i] =
                keccak256(abi.encode(CUTOFF_TYPEHASH, q.cutoffs[i].cutoffUtc, q.cutoffs[i].refundBps));
        }
        // Two-part encoding keeps the legacy code generator within stack limits; the bytes are
        // identical to a single abi.encode because every member is a static 32-byte word.
        bytes memory head = abi.encode(
            QUOTE_TYPEHASH,
            q.resourceId,
            q.checkInUtc,
            q.checkOutUtc,
            q.priceAtomic,
            q.feeBps,
            q.guestYieldBps
        );
        bytes memory tail = abi.encode(
            q.policyHash, keccak256(abi.encodePacked(cutoffHashes)), q.finalBps, q.guest, q.expiresAt, q.salt
        );
        return keccak256(bytes.concat(head, tail));
    }

    /// @notice Guard 11: 1..8 cutoffs, strictly increasing and all before check-in, refund
    /// non-increasing and <= 100%, and `finalBps` no higher than the last cutoff.
    function validCurve(Cutoff[] calldata cutoffs, uint16 finalBps, uint40 checkInUtc)
        external
        pure
        returns (bool)
    {
        uint256 n = cutoffs.length;
        if (n == 0 || n > MAX_CUTOFFS) return false;
        for (uint256 i; i < n; ++i) {
            Cutoff calldata c = cutoffs[i];
            if (c.refundBps > BPS || c.cutoffUtc >= checkInUtc) return false;
            if (i > 0 && (c.cutoffUtc <= cutoffs[i - 1].cutoffUtc || c.refundBps > cutoffs[i - 1].refundBps))
            {
                return false;
            }
        }
        return finalBps <= cutoffs[n - 1].refundBps;
    }

    /// @notice Spec 4.3 for a guest cancellation at `nowUtc`. Caller ensures `nowUtc < checkOutUtc`.
    function refundBps(Cutoff[] storage cutoffs, uint16 finalBps, uint40 checkInUtc, uint256 nowUtc)
        internal
        view
        returns (uint16)
    {
        if (nowUtc >= checkInUtc) return finalBps;
        uint256 n = cutoffs.length;
        for (uint256 i; i < n; ++i) {
            Cutoff storage c = cutoffs[i];
            if (nowUtc < c.cutoffUtc) return c.refundBps;
        }
        return finalBps;
    }
}
