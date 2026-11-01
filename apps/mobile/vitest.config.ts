import { vitestCiGuard } from "@mend/test-ci/vitest";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/mobile" })],
  resolve: { tsconfigPaths: true, alias: { "react-native": "react-native-web" } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "mobile",
          exclude: [...configDefaults.exclude, "src/components/change-proof-artifacts.test.tsx"],
        },
      },
      {
        extends: true,
        resolve: {
          // Native media and keychain hosts do not exist in jsdom; keep the panel and data real.
          alias: Object.fromEntries(
            [
              "expo",
              "expo-video",
              "expo-image",
              "expo-router",
              "expo-secure-store",
              "expo-notifications",
              "react-native-safe-area-context",
              "@react-native-async-storage/async-storage",
            ].map((name) => [
              name,
              new URL("./src/test/proof-native.tsx", import.meta.url).pathname,
            ]),
          ),
        },
        test: {
          name: "proof-artifacts",
          include: ["src/components/change-proof-artifacts.test.tsx"],
        },
      },
    ],
  },
});
