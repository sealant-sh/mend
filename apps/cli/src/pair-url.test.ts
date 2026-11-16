// The rejected --url cases of `mend pair`, split from pair.test.ts so neither file runs near CI's
// per-file limit (SLNT-1040).
import { describe, expect, it } from "vitest";

import { runCli, startFakeMend } from "./pair-test-fixtures.ts";

// Each test here spawns the CLI from source; on a loaded CI runner one start has taken 3 s, so
// vitest's 5 s default left little headroom.
describe("mend pair", { timeout: 30_000 }, () => {
  it.each([
    "https://unlisted.example",
    "https://mend.example/",
    "https://MEND.example",
    "https://mend.example:443",
    "http://mend.example",
    "https://mend.example/path",
    "https://mend.example?query=1",
    "https://mend.example#fragment",
    "https://user@mend.example",
    " https://mend.example",
    "",
  ])("rejects unconfigured --url %s without printing a QR or code", async (override) => {
    const fake = await startFakeMend((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          code: "ABCDEFGH",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          urls: ["https://mend.example", "http://100.64.1.2:3105"],
        }),
      );
    });
    try {
      const result = await runCli(fake.url, ["pair", "--url", override], { token: "test-token" });
      expect(result.code).toBe(1);
      expect(result.stderr).toBe(
        "mend: --url must exactly match one of the server's configured pairing URLs\n",
      );
      expect(result.stdout).toBe("");
    } finally {
      await fake.close();
    }
  });
});
