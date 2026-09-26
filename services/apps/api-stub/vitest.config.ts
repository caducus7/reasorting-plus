import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test against the shared package's source so `pnpm --filter api-stub test` needs no prior build.
const sharedSrc = fileURLToPath(new URL("../../packages/shared/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@chain\/shared\/api\/v1$/, replacement: `${sharedSrc}/api/v1.ts` },
      { find: /^@chain\/shared$/, replacement: `${sharedSrc}/index.ts` },
    ],
  },
});
