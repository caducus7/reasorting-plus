// The stub serves the shared /v1 OpenAPI document plus its scenario header.

import { buildOpenApi as build } from "@chain/shared/api/openapi";
import { SCENARIOS, SCENARIO_HEADER } from "./scenario.js";

export function buildOpenApi() {
  return build({
    title: "Direct booking Service API (stub)",
    description:
      "chain-spec.md section 5.3. Served by api-stub (C0) with fixtures; calls carrying `stub: true` " +
      "have fake addresses and calldata. Money fields are USDC atomic units as decimal strings.",
    header: { name: SCENARIO_HEADER, description: `Stub only. Comma-separated: ${SCENARIOS.join(", ")}` },
  });
}
