import { vitestCiGuard } from "@mend/test-ci/vitest";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vitestCiGuard({ packageName: "@mend/db" })],
  test: {
    // Every test here waits on a real PostgreSQL server, and many run the whole migration
    // registry (over 200 migrations) or create and drop a database, which waits for a server-wide
    // checkpoint. On a developer machine that server is shared by every checkout's tests: a
    // migration run that takes 1.7 s alone took over 5 s, vitest's default, while other gates ran.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
