import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Three bundles, one config: main and preload run in Node, the renderer is an
// ordinary Vite React app. externalizeDepsPlugin leaves out only what
// package.json lists under `dependencies`, and that list is empty on purpose:
// every import is bundled, so the packaged app ships no node_modules
// (electron-builder.config.ts). The renderer never holds the server URL or the
// bearer — it reaches the Mend server through the preload bridge
// (src/shared/bridge.ts), so nothing in the page can leak it.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    // .wasm as plain assets so the vendored ghostty adapter's `?url` imports
    // resolve (mirrors t3code's vite config).
    assetsInclude: ["**/*.wasm"],
    resolve: {
      alias: {
        "#": resolve(import.meta.dirname, "src/renderer/src"),
      },
    },
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }),
      tailwindcss(),
      react(),
    ],
  },
});
