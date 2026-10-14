import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Each operation spawns real processes; full lifecycle sequences need more time on CI.
describe("server lifecycle", { timeout: 30_000 }, () => {
  it.each(["assets", "image-missing", "image-label", "compose-config", "backup-directory"])(
    "fails %s preflight without stopping the app or changing the pin",
    async (failure) => {
      const f = await fixture();
      expect(await f.setup()).toEqual({ _tag: "ok" });
      const old = f.active();
      if (failure === "assets")
        fs.writeFileSync(path.join(f.assets, "compose.v2.yaml"), "services: invalid");
      if (failure === "image-missing") f.update({ images: { "0.23.0": "0.23.0" } });
      if (failure === "image-label")
        f.update({ images: { "0.23.0": "0.23.0", "0.24.0": "0.99.0" } });
      if (failure === "compose-config") f.update({ fail: failure });
      if (failure === "backup-directory")
        fs.writeFileSync(path.join(f.configDir, "backups"), "blocked");
      expect((await f.upgrade())._tag).toBe("error");
      expect(f.active()).toBe(old);
      expect(f.state().appRunning).toBe(true);
      expect(f.calls().some((call) => call.command[0] === "stop")).toBe(false);
    },
  );
});
