import { describe, expect, it } from "vitest";
import { KEYS, redactKeys } from "../src/fork.js";

describe("redactKeys", () => {
  it("removes --private-key arguments and every run key from report text", () => {
    const t = `Command failed: forge script x --private-key ${KEYS[0]} --slow; signer ${KEYS[2]}`;
    const r = redactKeys(t);
    expect(r).not.toContain(KEYS[0]!.slice(2));
    expect(r).not.toContain(KEYS[2]!.slice(2));
    expect(r).toContain("--private-key <redacted>");
  });
});
