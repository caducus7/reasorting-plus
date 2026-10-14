import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.rehearsal.ts"], testTimeout: 1_800_000, hookTimeout: 600_000, fileParallelism: false, bail: 1 } });
