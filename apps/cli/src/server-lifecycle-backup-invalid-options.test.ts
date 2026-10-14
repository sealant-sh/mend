import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";

const { cleanups, versions, withVersions } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
describe("server lifecycle", { timeout: 30_000 }, () => {
  describe("upgrade backups", () => {
    it.each(["-1", "two", "1.5"])(
      "refuses --keep-backups %s before touching anything",
      async (keep) => {
        const f = await withVersions();
        const count = f.calls().length;
        expect(await f.upgradeKeeping(versions[0], keep)).toMatchObject({
          _tag: "error",
          message: expect.stringContaining("--keep-backups takes a whole number"),
        });
        expect(
          f
            .calls()
            .slice(count)
            .every(
              (call) => call.args[2] === "volume" && ["ls", "inspect"].includes(call.args[3] ?? ""),
            ),
        ).toBe(true);
        expect(fs.existsSync(path.join(f.configDir, "backups"))).toBe(false);
      },
    );
  });
});
