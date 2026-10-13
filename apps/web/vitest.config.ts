import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

// Source tests need the application's transforms and aliases. The deployment
// plugins in vite.config.ts also start a server runtime, which has no owner
// in Vitest's lifecycle.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ["./tsconfig.json"] }), tailwindcss(), viteReact()],
});
