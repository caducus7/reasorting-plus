import { describe, expect, it } from "vitest";
import { bookingIdOf } from "../src/eip712.js";

describe("bookingIdOf", () => {
  // Same vector as contracts/test/unit/QuoteLib.t.sol::test_bookingIdMatchesViemVector.
  it("matches the Solidity QuoteLib vector", () => {
    const id = bookingIdOf({
      resourceId: "0x44f68f1266a79abc7890beb4d91798109aa8bbe84efb1d8f50db3cf9b5ce51ea",
      checkInUtc: 1795611600,
      checkOutUtc: 1796209200,
      priceAtomic: "5600000000",
      feeBps: 500,
      guestYieldBps: 5000,
      policyHash: "0x1111111111111111111111111111111111111111111111111111111111111111",
      cutoffs: [
        { cutoffUtc: 1793030400, refundBps: 10000 },
        { cutoffUtc: 1794412800, refundBps: 5000 },
        { cutoffUtc: 1795017600, refundBps: 2500 },
      ],
      finalBps: 0,
      guest: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      expiresAt: 1790000000,
      salt: "0x2222222222222222222222222222222222222222222222222222222222222222",
    });
    expect(id).toBe("0x2752bd9fec3f68b8d62310995b40e43f31b750970bda6151900b2a8a7741b6eb");
  });
});
