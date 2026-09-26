import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test against the shared package's source so `pnpm --filter api-stub test` needs no prior build.
const sharedSrc = fileURLToPath(new URL("../../packages/shared/src", import.meta.url));
const abiSrc = fileURLToPath(new URL("../../packages/abi/src", import.meta.url));

export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 180_000, fileParallelism: false },
  resolve: {
    alias: [
      { find: /^@chain\/shared\/api\/v1$/, replacement: `${sharedSrc}/api/v1.ts` },
      { find: /^@chain\/shared\/api\/openapi$/, replacement: `${sharedSrc}/api/openapi.ts` },
      { find: /^@chain\/shared\/eip712$/, replacement: `${sharedSrc}/eip712.ts` },
      { find: /^@chain\/shared$/, replacement: `${sharedSrc}/index.ts` },
      { find: /^@chain\/abi$/, replacement: `${abiSrc}/index.ts` },
    ],
  },
});
