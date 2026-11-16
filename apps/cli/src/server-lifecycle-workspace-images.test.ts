import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OVERLAY = "compose.workspace-images.yaml";
const DEFAULTS_LINE =
  "workspace images · the worker keeps the newest 10 with no workspace on them, and any built in the last 168 hours · sealant's defaults, not set on this install";
const SET_LINE =
  "workspace images · the worker keeps the newest 3 with no workspace on them, and any built in the last 24 hours · set on this install";

describe("the workspace images the bundled worker keeps", { timeout: 120_000 }, () => {
  it("are sealant's defaults on a new install, which writes nothing for them", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files[OVERLAY]).toBeUndefined();
    expect(JSON.parse(files["server.json"] ?? "{}")).not.toHaveProperty("workspaceImages");
    expect(files["server.env"]).not.toContain("WORKSPACE_IMAGE");
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines).toContain(DEFAULTS_LINE);
  });

  it("reach the mend container from the config, and survive a rerun and an upgrade", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const envBefore = f.files()["server.env"];
    f.lines.length = 0;
    expect(
      await serverCommand(
        ["setup", "--offline", "--workspace-image-keep", "3", "--workspace-image-min-age", "24"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      `${SET_LINE}. The worker sweeps half a minute after Mend starts, then hourly.`,
    );
    const files = f.files();
    expect(JSON.parse(files["server.json"] ?? "{}").workspaceImages).toEqual({
      keep: 3,
      minAgeHours: 24,
    });
    expect(files[OVERLAY]).toContain(
      '  mend:\n    environment:\n      WORKSPACE_IMAGE_RETAINED_PLANS: "3"\n      WORKSPACE_IMAGE_MIN_AGE_HOURS: "24"\n',
    );
    // server.env is untouched: a CLI from before the setting still reads the install.
    expect(files["server.env"]).toBe(envBefore);
    expect(f.state().upFiles).toContain(OVERLAY);

    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines).toContain(SET_LINE);

    // A rerun that names neither keeps both, and says nothing about them.
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--yes"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines.some((line) => line.startsWith("workspace images"))).toBe(false);
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);

    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);
    expect(JSON.parse(f.files()["server.json"] ?? "{}").workspaceImages).toEqual({
      keep: 3,
      minAgeHours: 24,
    });
    expect(f.state().upFiles).toContain(OVERLAY);
  });

  it("go back to sealant's defaults one at a time with default", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--offline", "--workspace-image-keep", "0", "--workspace-image-min-age", "1"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--workspace-image-keep", "default"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(JSON.parse(f.files()["server.json"] ?? "{}").workspaceImages).toEqual({
      minAgeHours: 1,
    });
    expect(f.files()[OVERLAY]).not.toContain("WORKSPACE_IMAGE_RETAINED_PLANS");
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines).toContain(
      "workspace images · the worker keeps the newest 10 with no workspace on them, and any built in the last 1 hour · the count is sealant's default",
    );

    expect(
      await serverCommand(
        ["setup", "--offline", "--workspace-image-min-age", "default"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.files()[OVERLAY]).toBeUndefined();
    expect(JSON.parse(f.files()["server.json"] ?? "{}")).not.toHaveProperty("workspaceImages");
    expect(f.state().upFiles).not.toContain(OVERLAY);
  });

  it("refuses a value that is not a whole number in range", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    for (const [flag, value] of [
      ["--workspace-image-keep", "-1"],
      ["--workspace-image-keep", "3.5"],
      ["--workspace-image-keep", ""],
      ["--workspace-image-keep", "1001"],
      ["--workspace-image-min-age", "1d"],
      ["--workspace-image-min-age", "87601"],
    ] as const) {
      const result = await serverCommand(["setup", "--offline", flag, value], f.runtime);
      expect(result._tag).toBe("error");
      expect(result._tag === "error" ? result.message : "").toContain(`${flag} must be`);
    }
    expect(f.files()[OVERLAY]).toBeUndefined();
  });

  it("refuses a generation whose overlay does not match its config", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--workspace-image-keep", "3"], f.runtime),
    ).toEqual({ _tag: "ok" });
    const overlay = path.join(f.active(), OVERLAY);
    fs.writeFileSync(overlay, fs.readFileSync(overlay, "utf8").replace('PLANS: "3"', 'PLANS: "0"'));
    const result = await serverCommand(["status"], f.runtime);
    expect(result._tag).toBe("error");
    expect(result._tag === "error" ? result.message : "").toContain(
      `${OVERLAY} does not match the saved workspace image settings`,
    );
  });
});
