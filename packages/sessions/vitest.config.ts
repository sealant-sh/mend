import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

import { sessionsCiGuard } from "./test/ci-reporter.ts";

export default defineConfig({
  plugins: [sessionsCiGuard(), vitestCiGuard({ packageName: "@mend/sessions" })],
});
