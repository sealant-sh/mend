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
export default defineConfig({
  plugins: [
    vitestCiGuard({ packageName: "@mend/web" }),
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    viteReact(),
  ],
});
