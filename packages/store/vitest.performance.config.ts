import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/capture-verify-measure.perf.ts"],
    testTimeout: 600_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
