import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Three bundles, one config: main and preload run in Node/Electron, and the renderer is the tiny
// Sheet-styled Connect/Offline shell on @mend/ui. Once connected, the window loads the live Mend
// server web app directly. `dependencies` in package.json is empty on purpose so every import is
// bundled into out/ and the packaged app ships no node_modules (electron-builder.config.ts).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    build: {
      // Sandboxed preloads run as CommonJS and must be self-contained with no external imports.
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "#": resolve(import.meta.dirname, "src/renderer/src"),
      },
    },
    plugins: [tailwindcss(), react()],
  },
});
