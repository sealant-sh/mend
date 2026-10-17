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
    it("--keep-backups 0 keeps every backup and --keep-backups 1 keeps only this upgrade's", async () => {
      const f = await withVersions();
      for (const version of versions.slice(0, 3))
        expect(await f.upgradeKeeping(version, "0")).toEqual({ _tag: "ok" });
      expect(f.backups()).toHaveLength(3);
      expect(f.lines).toContain("Upgrade backups · all kept (--keep-backups 0)");
      expect(f.lines.some((line) => line.startsWith("Removed upgrade backup "))).toBe(false);
      // The first as a release before 0.36 wrote it: no outcome recorded, and the output says so.
      const legacy =
        f
          .backups()
          .map((name) => path.join(f.configDir, "backups", name, "recovery.json"))
          .find((file) => JSON.parse(fs.readFileSync(file, "utf8")).sequence === 1) ?? "";
      const {
        state: _state,
        sequence: _sequence,
        createdAt: _createdAt,
        ...old
      } = JSON.parse(fs.readFileSync(legacy, "utf8"));
      fs.writeFileSync(legacy, JSON.stringify(old));
      expect(await f.upgradeKeeping(versions[3], "1")).toEqual({ _tag: "ok" });
      expect(f.backups()).toHaveLength(1);
      const removals = f.lines.filter((line) => line.startsWith("Removed upgrade backup "));
      expect(removals).toHaveLength(3);
      expect(
        removals.filter((line) => line.endsWith(" · from before 0.36, no recorded outcome")),
      ).toEqual([expect.stringContaining(path.dirname(legacy))]);
    });
  });
});
