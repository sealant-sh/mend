import { loadPublicNetwork } from "@mend/network";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { Effect } from "effect";
import { nitro } from "nitro/vite";
import { defineConfig, esmExternalRequirePlugin } from "vite";

import { devProxyRoutes } from "./src/entry/proxy-headers.ts";

// Dev runs two processes (`pnpm dev`, scripts/dev.mjs): this vite server for the app on 3105, and
// the Mend API server (apps/api) on 3101. The proxy keeps them one origin, the shape production
// has, where the web server proxies /api to the API.

// Vite's DNS-rebinding guard receives the same explicit hosts as auth and
// CORS. It accepts hostnames rather than origins, so scheme and port remain
// enforced by those request boundaries.
const publicNetwork = Effect.runSync(loadPublicNetwork);
const allowedHosts = [
  ...new Set(publicNetwork.allowedOrigins.map((origin) => new URL(origin).hostname)),
];

const apiTarget = process.env["MEND_API_URL"] ?? "http://localhost:3101";

const config = defineConfig({
  // Vite's own resolver, not vite-tsconfig-paths: that plugin returns a bare id, so a module first
  // reached through "#/" lost its package.json type, and Rolldown's CommonJS interop for it (and
  // every chunk hash above it) depended on which importer happened to load it first.
  resolve: { tsconfigPaths: true },
  build: {
    rolldownOptions: {
      // Effect's Schema builders are pure: a schema nothing reads is dropped like any unused value.
      treeshake: { manualPureFunctions: ["Schema"] },
    },
  },
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          // `.output` runs with no node_modules beside it. Vite 8 bundles CommonJS dependencies
          // the app cannot resolve itself into the SSR build and leaves their require("react") as
          // a runtime call nitro cannot follow; as imports, nitro bundles them with React.
          plugins: [esmExternalRequirePlugin({ external: [/^react(-dom)?(\/|$)/] })],
        },
      },
    },
  },
  server: {
    // Steered from any device on the operator's network, so dev binds every interface. A fixed
    // port: `pnpm dev` hands its environment, PORT included, to the API server too.
    host: true,
    port: 3105,
    allowedHosts,
    proxy: {
      // Vite owns WebSocket upgrades; nitro's earlier middleware handles HTTP through devProxy.
      "/api": { target: apiTarget, ws: true },
      // /trpc needs no proxy: it is a Start SERVER route, served by vite dev itself.
    },
  },
  plugins: [
    tailwindcss(),
    tanstackStart({
      router: {
        // Loaders are split out of the route tree too, not only components, so one route's page
        // code never rides in front of another's.
        codeSplittingOptions: {
          defaultBehavior: [
            ["loader"],
            ["component"],
            ["pendingComponent"],
            ["errorComponent"],
            ["notFoundComponent"],
          ],
        },
      },
    }),
    // `vite build` emits a self-contained node server at .output/server/index.mjs.
    nitro({
      // Nitro handles extensionless requests before Vite's HTTP proxy runs.
      // Without this, auth and SSE requests fall into the app's HTML 404.
      devProxy: devProxyRoutes(apiTarget),
      compressPublicAssets: { gzip: true, brotli: true },
    }),
    viteReact(),
  ],
});

export default config;
