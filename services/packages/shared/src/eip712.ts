// EIP-712 types for the escrow quote (chain-spec.md 4.1). bookingId = hashStruct(quote).
// Single source for every service; pinned to the Solidity QuoteLib by a shared test vector
// (contracts/test/unit/QuoteLib.t.sol and packages/shared/test/eip712.test.ts).

import { hashStruct, type Address, type Hex } from "viem";
import type { Quote } from "./api/v1.js";

export const ESCROW_EIP712_NAME = "BookingEscrow";
export const ESCROW_EIP712_VERSION = "1";

export const QUOTE_TYPES = {
  Cutoff: [
    { name: "cutoffUtc", type: "uint40" },
    { name: "refundBps", type: "uint16" },
  ],
  Quote: [
    { name: "resourceId", type: "bytes32" },
    { name: "checkInUtc", type: "uint40" },
    { name: "checkOutUtc", type: "uint40" },
    { name: "priceAtomic", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "guestYieldBps", type: "uint16" },
    { name: "policyHash", type: "bytes32" },
    { name: "cutoffs", type: "Cutoff[]" },
    { name: "finalBps", type: "uint16" },
    { name: "guest", type: "address" },
    { name: "expiresAt", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** The JSON quote (API form) as typed-data message values. */
export function quoteMessage(q: Quote) {
  return {
    ...q,
    resourceId: q.resourceId as Hex,
    policyHash: q.policyHash as Hex,
    salt: q.salt as Hex,
    guest: q.guest as Address,
    priceAtomic: BigInt(q.priceAtomic),
  };
}

export function bookingIdOf(q: Quote): Hex {
  return hashStruct({ types: QUOTE_TYPES, primaryType: "Quote", data: quoteMessage(q) });
}

export function quoteTypedData(q: Quote, chainId: number, escrow: Address) {
  return {
    domain: { name: ESCROW_EIP712_NAME, version: ESCROW_EIP712_VERSION, chainId, verifyingContract: escrow },
    types: QUOTE_TYPES,
    primaryType: "Quote" as const,
    message: quoteMessage(q),
  };
}
