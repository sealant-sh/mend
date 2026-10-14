import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

// The dashboard's renderer (opentui) loads through node:ffi, which Node 26 keeps behind a flag;
// main.ts re-execs with it for the dashboard, and the rendered dashboard tests need it the same way.
export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@sealant/mend" })],
  test: {
    poolOptions: {
      forks: { execArgv: ["--experimental-ffi"] },
      threads: { execArgv: ["--experimental-ffi"] },
    },
  },
});
