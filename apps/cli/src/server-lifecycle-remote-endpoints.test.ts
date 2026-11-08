import { afterEach, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it(
  "keeps remote addresses and the last overlay across upgrade, restart and start",
  { timeout: 120_000 },
  async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        [
          "setup",
          "--offline",
          "--session-endpoint-url",
          "https://mend.example.com:8443",
          "--blob-store-public-url",
          "https://mend.example.com:10000",
        ],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    const before = f.files();
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()["compose.remote-endpoints.yaml"]).toBe(
      before["compose.remote-endpoints.yaml"],
    );
    expect(f.files()["server.env"]).toBe(
      before["server.env"]?.replace("MEND_VERSION=0.23.0", "MEND_VERSION=0.24.0"),
    );
    for (const command of [["restart"], ["stop"], ["start", "--offline"]]) {
      expect(await serverCommand(command, f.runtime)).toEqual({ _tag: "ok" });
      expect(f.state().upFiles?.at(-1)).toBe("compose.remote-endpoints.yaml");
    }
  },
);
