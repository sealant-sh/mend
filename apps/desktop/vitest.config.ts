import { fileURLToPath, URL } from "node:url";

import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

// The vendored ghostty terminal tests exercise DOM APIs (jsdom stands in;
// canvas metrics fall back, which the tests account for).
export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/desktop" })],
  resolve: {
    alias: {
      "#": fileURLToPath(new URL("./src/renderer/src", import.meta.url)),
    },
  },
  // .wasm as plain assets so `?inline` / `?url` imports resolve (t3's setting).
  assetsInclude: ["**/*.wasm"],
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
