import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/sessions" })],
  test: { execArgv: ["--expose-gc"], globalSetup: ["./test/docker-fixtures.setup.ts"] },
});
