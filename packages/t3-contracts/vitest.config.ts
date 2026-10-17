import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/t3-contracts" })],
  resolve: {
    // t3code's own tests import vitest through vite-plus (t3:vite.config.ts); it re-exports vitest.
    alias: [{ find: /^vite-plus\/test$/, replacement: "vitest" }],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
