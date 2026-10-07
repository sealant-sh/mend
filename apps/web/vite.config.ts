import { loadPublicNetwork } from "@mend/network";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { Effect } from "effect";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
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

// The standalone acceptance fixture is opt-in and loopback-only. Real sessions use SDK Services.
const desktopPreview = process.env.MEND_DESKTOP_PREVIEW_URL;
if (desktopPreview && new URL(desktopPreview).hostname !== "127.0.0.1") {
  throw new Error("MEND_DESKTOP_PREVIEW_URL must target this machine's loopback");
}

const config = defineConfig({
  server: {
    // The workbench is steered from any device on the operator's network
    // (ARCHITECTURE.md §9), so dev binds every interface, not just loopback.
    host: desktopPreview ? "127.0.0.1" : true,
    port: 3105,
    allowedHosts,
    proxy: {
      // Vite owns WebSocket upgrades for terminals and tunnels. Nitro's
      // earlier middleware handles HTTP through devProxy below.
      "/api": { target: apiTarget, ws: true },
      ...(desktopPreview
        ? {
            "/__desktop-preview": {
              target: desktopPreview,
              ws: true,
              rewrite: (path: string) => path.replace(/^\/__desktop-preview/, ""),
            },
          }
        : {}),
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
