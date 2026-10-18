import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

// The site's vite.config.ts runs SSR in the Workers runtime (the Cloudflare plugin), and Vitest 5
// runs tests in that environment too. The tests here are Node scripts, so they take none of the
// site's plugins.
export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/marketing" })],
});
