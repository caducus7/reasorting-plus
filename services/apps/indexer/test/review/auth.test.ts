// Review 0005 R6: the read API requires the bearer token; without a configured token it fails closed
// everywhere except Anvil.
import { expect, it } from "vitest";
import { authorize } from "../../src/core/auth.js";

const T = "t".repeat(40);
it("authorize", () => {
  expect(authorize(undefined, "", "31337")).toBe(200); // Anvil, no token configured
  expect(authorize(undefined, "", "8453")).toBe(503); // mainnet, none configured: closed
  expect(authorize(`Bearer ${T}`, "short", "84532")).toBe(503); // a weak token is not a token
  expect(authorize(undefined, T, "8453")).toBe(401);
  expect(authorize("Bearer wrong", T, "8453")).toBe(401);
  expect(authorize(`Bearer ${T}x`, T, "8453")).toBe(401);
  expect(authorize(`Bearer ${T}`, T, "8453")).toBe(200);
  expect(authorize(`Bearer ${T}`, T, "31337")).toBe(200); // a configured token is enforced on Anvil too
  expect(authorize(undefined, T, "31337")).toBe(401);
});
