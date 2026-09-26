// `x-stub-scenario` header: a comma-separated list of scenario names (C0 brief).

export const SCENARIOS = [
  "unavailable", // prepare -> 409 unavailable
  "terms_changed", // prepare -> 409 terms_changed
  "slow", // every /v1 endpoint waits 2s
  "error", // every /v1 endpoint returns 500
  "cancelled", // booking is SETTLED after a guest cancellation
  "settled", // booking is SETTLED after a completed stay
  "yield_zero", // no yield accrued
] as const;

export type Scenario = (typeof SCENARIOS)[number];

export const SCENARIO_HEADER = "x-stub-scenario";
export const SLOW_MS = 2_000;

export class InvalidScenario extends Error {}

export function parseScenarios(header: string | undefined): ReadonlySet<Scenario> {
  const out = new Set<Scenario>();
  if (header === undefined || header.trim() === "") return out;
  for (const raw of header.split(",")) {
    const name = raw.trim();
    if (!(SCENARIOS as readonly string[]).includes(name)) throw new InvalidScenario(`unknown scenario ${name}`);
    out.add(name as Scenario);
  }
  if (out.has("cancelled") && out.has("settled")) throw new InvalidScenario("cancelled and settled are exclusive");
  if (out.has("unavailable") && out.has("terms_changed")) {
    throw new InvalidScenario("unavailable and terms_changed are exclusive");
  }
  return out;
}
