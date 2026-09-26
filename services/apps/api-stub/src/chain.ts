// EIP-712 types and calldata for the spec 4.1 Quote and the escrow calls the checkout submits.
// Encodings are real (so the bundle has the right shape); addresses and signature are fake.

import { encodeFunctionData, erc20Abi, hashStruct, keccak256, type Hex } from "viem";
import type { v1 } from "@chain/shared";
import { STUB_ESCROW, STUB_USDC } from "./fixtures.js";

type Quote = v1.Quote;
type Call = v1.Call;

/** EIP-712 struct types from spec 4.1. bookingId = hashStruct(quote). */
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

const QUOTE_TUPLE = {
  name: "q",
  type: "tuple",
  components: [
    { name: "resourceId", type: "bytes32" },
    { name: "checkInUtc", type: "uint40" },
    { name: "checkOutUtc", type: "uint40" },
    { name: "priceAtomic", type: "uint256" },
    { name: "feeBps", type: "uint16" },
    { name: "guestYieldBps", type: "uint16" },
    { name: "policyHash", type: "bytes32" },
    {
      name: "cutoffs",
      type: "tuple[]",
      components: [
        { name: "cutoffUtc", type: "uint40" },
        { name: "refundBps", type: "uint16" },
      ],
    },
    { name: "finalBps", type: "uint16" },
    { name: "guest", type: "address" },
    { name: "expiresAt", type: "uint40" },
    { name: "salt", type: "bytes32" },
  ],
} as const;

/** The subset of the spec 4.2 / 4.5 escrow interface the stub encodes. */
export const ESCROW_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "nonpayable",
    inputs: [QUOTE_TUPLE, { name: "quoteSig", type: "bytes" }],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelByGuest",
    stateMutability: "nonpayable",
    inputs: [{ name: "bookingId", type: "bytes32" }],
    outputs: [],
  },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
] as const;

function toTyped(q: Quote) {
  return {
    ...q,
    resourceId: q.resourceId as Hex,
    policyHash: q.policyHash as Hex,
    salt: q.salt as Hex,
    guest: q.guest as Hex,
    priceAtomic: BigInt(q.priceAtomic),
  };
}

export function bookingIdOf(q: Quote): Hex {
  return hashStruct({ types: QUOTE_TYPES, primaryType: "Quote", data: toTyped(q) });
}

function stubCall(to: Hex, data: Hex): Call {
  return { to, data, value: "0", stub: true };
}

export function approveCall(amount: bigint): Call {
  return stubCall(STUB_USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [STUB_ESCROW, amount] }));
}

export function depositCall(q: Quote, quoteSig: Hex): Call {
  return stubCall(STUB_ESCROW, encodeFunctionData({ abi: ESCROW_ABI, functionName: "deposit", args: [toTyped(q), quoteSig] }));
}

export function cancelByGuestCall(bookingId: Hex): Call {
  return stubCall(STUB_ESCROW, encodeFunctionData({ abi: ESCROW_ABI, functionName: "cancelByGuest", args: [bookingId] }));
}

export function claimCall(): Call {
  return stubCall(STUB_ESCROW, encodeFunctionData({ abi: ESCROW_ABI, functionName: "claim" }));
}

/** Deterministic fake deposit transaction hash for a booking. */
export function fakeTxHash(bookingId: Hex): Hex {
  return keccak256(bookingId);
}
