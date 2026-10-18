import { loadPublicNetwork } from "@mend/network";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { Effect } from "effect";
import { nitro } from "nitro/vite";
import { defineConfig, esmExternalRequirePlugin } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Dev runs two processes: this vite server for the app, and the Mend API
// server (apps/api) on 3101. The proxy keeps them one origin — the same
// shape production has, where the web server proxies /api to the API.

// Vite's DNS-rebinding guard receives the same explicit hosts as auth and
// CORS. It accepts hostnames rather than origins, so scheme and port remain
// enforced by those request boundaries.
const publicNetwork = Effect.runSync(loadPublicNetwork);
const allowedHosts = [
  ...new Set(publicNetwork.allowedOrigins.map((origin) => new URL(origin).hostname)),
];

const apiTarget = process.env.MEND_API_URL ?? "http://localhost:3101";

const config = defineConfig({
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          // The production image ships .output alone, with no node_modules. Vite 8 bundles
          // CommonJS dependencies apps/web cannot resolve itself (@base-ui's
          // use-sync-external-store) into the SSR build, and leaves their require("react") as a
          // runtime call that nitro cannot follow: every page then fails with "Cannot find module
          // 'react'". As imports, nitro bundles them with the rest of React.
          plugins: [esmExternalRequirePlugin({ external: [/^react(-dom)?(\/|$)/] })],
        },
      },
    },
  },
  server: {
    // The workbench is steered from any device on the operator's network
    // (ARCHITECTURE.md §9), so dev binds every interface, not just loopback.
    host: true,
    port: 3105,
    allowedHosts,
    proxy: {
      // Vite owns WebSocket upgrades for terminals and tunnels. Nitro's
      // earlier middleware handles HTTP through devProxy below.
      "/api": { target: apiTarget, ws: true },
      // /trpc needs no proxy: it is a Start SERVER route, served by vite dev
      // itself (and by nitro in production).
    },
  },
  plugins: [
    tsconfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    // The official deployment layer: `vite build` emits a self-contained node
    // server at .output/server/index.mjs (+ static assets in .output/public).
    nitro({
      // Nitro handles extensionless requests before Vite's HTTP proxy runs.
      // Without this, auth and SSE requests fall into the app's HTML 404.
      devProxy: {
        "/api/**": { target: apiTarget },
      },
    }),
    viteReact(),
  ],
});

export default config;
