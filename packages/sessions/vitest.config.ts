import { defineConfig } from "vitest/config";

import { sessionsCiGuard } from "./test/ci-reporter.ts";

const ci = process.env["CI"];
const enforceDuration = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0";

export default defineConfig({
  plugins: [sessionsCiGuard(enforceDuration ? { fileBudgetMs: 60_000 } : {})],
});
