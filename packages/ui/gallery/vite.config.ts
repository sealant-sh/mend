// The kit's gallery: every primitive in every variant and size, in light and dark. A dev page
// only (`pnpm --filter @mend/ui gallery`); no app bundles or images include it.
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@mend/ui": fileURLToPath(new URL("../src", import.meta.url)) },
  },
  server: { port: 5199 },
});
