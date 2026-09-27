import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], exclude: ["test/anvil/**"], testTimeout: 60_000 } });
