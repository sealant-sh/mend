import type { UserConfig } from "vite";

// No runtime import: the app is copied to a temporary directory with no node_modules.
const config: UserConfig = {
  server: {
    // The preview gateway rewrites Host to localhost:<port>.
    allowedHosts: ["localhost"],
  },
};

export default config;
