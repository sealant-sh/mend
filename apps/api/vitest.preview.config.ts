import { defineConfig } from "vitest/config";

/** Not part of `test`; run with `pnpm test:preview-acceptance`. */
export default defineConfig({
  test: {
    include: ["test/**/*.acceptance.ts"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
