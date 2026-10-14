import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { readServerInstallation, serverCommand } from "./server-setup.ts";
import { withServerStore } from "./server-store.ts";

const { cleanups, fixture, gatewayAnswers, FOUNDING_OR_SECRET, asBoxOn773 } =
  lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("the edge and the posture", { timeout: 120_000 }, () => {
  it("an upgrade takes a generation 0.36.0-next.773's CLI wrote: the lines added since come in at what the config says, the secrets unchanged", async () => {
    const f = await fixture();
    const rendered = await asBoxOn773(f);
    const old = f.active();
    const written = fs.readFileSync(path.join(old, "server.env"), "utf8");
    expect(written).not.toContain("MEND_T3_GATEWAY_BIND_HOST");
    // Read as that CLI left it: status, a restart and an upgrade.
    expect(await serverCommand(["status"], gatewayAnswers(f))).toEqual({ _tag: "ok" });
    expect(await serverCommand(["restart"], gatewayAnswers(f))).toEqual({ _tag: "ok" });
    expect(f.active()).toBe(old);
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.active()).not.toBe(old);
    // The next generation is this CLI's own render of the same config and identity.
    expect(f.files()["server.env"]).toBe(
      rendered.replace("MEND_VERSION=0.23.0\n", "MEND_VERSION=0.24.0\n"),
    );
    expect(f.files()["server.env"]).toContain(
      "MEND_T3_GATEWAY_BIND_HOST=127.0.0.1\nMEND_T3_GATEWAY_PUBLISHED=127.0.0.1:3120\n",
    );
    expect(f.files()["compose.t3.yaml"]).toContain("${MEND_T3_GATEWAY_BIND_HOST:?");
    // The older generation stays as it was written.
    expect(fs.readFileSync(path.join(old, "server.env"), "utf8")).toBe(written);
  });

  it("reads a generation that lacks any line a later CLI added, so the next new line cannot break an upgrade", async () => {
    const f = await fixture();
    await asBoxOn773(f);
    // Back to this CLI's own render, then without each line in turn, as a CLI from before it.
    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    const envFile = path.join(f.active(), "server.env");
    const full = fs.readFileSync(envFile, "utf8");
    const later = full
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .filter((key) => key !== "" && !FOUNDING_OR_SECRET.test(key));
    expect(later).toContain("MEND_T3_GATEWAY_URL");
    for (const key of later) {
      fs.writeFileSync(envFile, full.replace(new RegExp(`^${key}=.*\n`, "m"), ""));
      const read = await withServerStore(f.configDir, async (store) =>
        readServerInstallation(store),
      );
      expect([key, read]).toMatchObject([key, { _tag: "ok", value: { _tag: "ok" } }]);
    }
  });
});
