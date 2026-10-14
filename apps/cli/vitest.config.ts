import { defineConfig } from "vitest/config";

import { cliCiGuard } from "./test/ci-reporter.ts";

const ci = process.env["CI"];
const enforceDuration = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";

// The dashboard's renderer (opentui) loads through node:ffi, which Node 26 keeps behind a flag;
// main.ts re-execs with it for the dashboard, and the rendered dashboard tests need it the same way.
export default defineConfig({
  plugins: enforceDuration ? [cliCiGuard({ fileBudgetMs: 60_000 })] : [],
  test: {
    poolOptions: {
      forks: { execArgv: ["--experimental-ffi"] },
      threads: { execArgv: ["--experimental-ffi"] },
    },
  },
});
