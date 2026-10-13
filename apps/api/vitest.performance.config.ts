import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/worktree-reads.perf.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
