import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The tests run a real gateway and a fake Mend over sockets, several steps each. Every wait
    // inside a test is bounded on its own (`eventually`, a feed's `next`: 5 s) and fails naming its
    // step; the test as a whole only backs them, so a slow CI runner never fails a test that would
    // pass, and a real hang still fails where it hangs.
    testTimeout: 30_000,
  },
});
