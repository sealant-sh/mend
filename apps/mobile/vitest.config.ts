import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/mobile" })],
  resolve: { tsconfigPaths: true, alias: { "react-native": "react-native-web" } },
});
