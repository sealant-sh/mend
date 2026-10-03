import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // t3code's own tests import vitest through vite-plus (t3:vite.config.ts); it re-exports vitest.
    alias: [{ find: /^vite-plus\/test$/, replacement: "vitest" }],
  },
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
