import { fileURLToPath } from "node:url";

import { vitestCiGuard } from "@mend/test-ci/vitest";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Source tests need the application's transforms and aliases. The deployment
// plugins in vite.config.ts also start a server runtime, which has no owner
// in Vitest's lifecycle.
//
// defineConfig comes from the app's Vite 8, which the plugins are typed
// against; vitest/config's is typed against Vitest 3's own Vite 7. This file
// sets no `test` options, so Vite's config type covers everything here.
/** Vitest's own hook, as vitestCiGuard uses: every test file runs these setup files first. */
const testSetup = {
  name: "mend-web-test-setup",
  configureVitest({
    project,
  }: {
    readonly project: { readonly config: { readonly setupFiles: string[] } };
  }) {
    project.config.setupFiles.push(
      fileURLToPath(new URL("./src/isomorphic-test-setup.ts", import.meta.url)),
      fileURLToPath(new URL("./src/window-test-teardown.ts", import.meta.url)),
    );
  },
};

export default defineConfig({
  plugins: [
    vitestCiGuard({ packageName: "@mend/web" }),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    viteReact(),
    testSetup,
  ],
});
