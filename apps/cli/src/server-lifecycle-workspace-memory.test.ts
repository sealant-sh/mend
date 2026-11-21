import * as fs from "node:fs";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { lifecycleTestFixtures } from "./server-lifecycle-test-fixtures.ts";
import { serverCommand } from "./server-setup.ts";
import {
  parseWorkspaceMemory,
  parseWorkspaceMemoryField,
  renderWorkspaceMemoryOverlay,
  resolveWorkspaceMemory,
  workspaceMemoryLine,
} from "./server-workspace-memory.ts";

const { cleanups, fixture } = lifecycleTestFixtures();

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const OVERLAY = "compose.workspace-memory.yaml";
const DEFAULTS_LINE =
  "workspace memory · each session's workspace gets half of this machine's memory (2 to 16 GiB), its Docker service a quarter (1 to 8 GiB) · sealant's defaults, not set on this install";
const SET_LINE =
  "workspace memory · each session's workspace gets 4g, its Docker service no limit · set on this install";
const RESTART = "Sessions started after Mend restarts get these limits; running ones keep theirs.";

describe("a workspace memory limit", () => {
  it("reads sealant's grammar: auto, none, or a size of at least 64 MiB", () => {
    for (const value of [
      "auto",
      "none",
      "default",
      "4g",
      "4G",
      "4096m",
      "4GiB",
      "4gb",
      "64m",
      "1t",
      "65536k",
      "67108864",
    ])
      expect(parseWorkspaceMemory(value)).toBe(value);
    for (const value of [
      "",
      "Auto",
      "4",
      "63m",
      "67108863",
      "4.5g",
      "-4g",
      "4 g",
      "4gi",
      "4p",
      "4g ",
      "99999999999t",
    ])
      expect(parseWorkspaceMemory(value)).toBeNull();
  });

  it("keeps a saved value through silence, and drops it with default", () => {
    const saved = { workspace: "4g", dockerService: "none" };
    expect(
      resolveWorkspaceMemory(saved, {
        workspaceMemory: undefined,
        workspaceDockerMemory: undefined,
      }),
    ).toEqual(saved);
    expect(
      resolveWorkspaceMemory(saved, { workspaceMemory: "8g", workspaceDockerMemory: "default" }),
    ).toEqual({ workspace: "8g" });
    expect(
      resolveWorkspaceMemory(saved, {
        workspaceMemory: "default",
        workspaceDockerMemory: "default",
      }),
    ).toBeUndefined();
    expect(
      resolveWorkspaceMemory(undefined, {
        workspaceMemory: undefined,
        workspaceDockerMemory: "auto",
      }),
    ).toEqual({ dockerService: "auto" });
  });

  it("reads back only what a setup writes", () => {
    expect(parseWorkspaceMemoryField({ workspace: "4g" })).toEqual({ workspace: "4g" });
    for (const raw of [
      {},
      null,
      [],
      "4g",
      { workspace: "default" },
      { workspace: 4096 },
      { workspace: "32m" },
      { workspace: "4g", other: "4g" },
    ])
      expect(parseWorkspaceMemoryField(raw)).toBeNull();
  });

  it("renders an overlay only for the values the install sets", () => {
    expect(renderWorkspaceMemoryOverlay(undefined)).toBeUndefined();
    const overlay = renderWorkspaceMemoryOverlay({ dockerService: "2g" }) ?? "";
    expect(overlay).toContain(
      '  mend:\n    environment:\n      SEALANT_DOCKER_SERVICE_MEMORY_LIMIT: "2g"\n',
    );
    expect(overlay).not.toContain("SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT");
    expect(workspaceMemoryLine({ dockerService: "2g" })).toBe(
      "workspace memory · each session's workspace gets half of this machine's memory (2 to 16 GiB), its Docker service 2g · the workspace's limit is sealant's default",
    );
    expect(workspaceMemoryLine({ workspace: "none" })).toBe(
      "workspace memory · each session's workspace gets no limit, its Docker service a quarter of this machine's memory (1 to 8 GiB) · the Docker service's limit is sealant's default",
    );
  });
});

describe("the workspace memory limits on the Docker install", { timeout: 120_000 }, () => {
  it("are sealant's defaults on a new install, which writes nothing for them", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const files = f.files();
    expect(files[OVERLAY]).toBeUndefined();
    expect(JSON.parse(files["server.json"] ?? "{}")).not.toHaveProperty("workspaceMemory");
    expect(files["server.env"]).not.toContain("MEMORY_LIMIT");
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(DEFAULTS_LINE);
  });

  it("reach the mend container from the config, and survive a rerun and an upgrade", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const envBefore = f.files()["server.env"];
    f.lines.length = 0;
    expect(
      await serverCommand(
        ["setup", "--offline", "--workspace-memory", "4g", "--workspace-docker-memory", "none"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(`${SET_LINE}. ${RESTART}`);
    const files = f.files();
    expect(JSON.parse(files["server.json"] ?? "{}").workspaceMemory).toEqual({
      workspace: "4g",
      dockerService: "none",
    });
    expect(files[OVERLAY]).toContain(
      '  mend:\n    environment:\n      SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT: "4g"\n      SEALANT_DOCKER_SERVICE_MEMORY_LIMIT: "none"\n',
    );
    // server.env is untouched: a CLI from before the setting still reads the install.
    expect(files["server.env"]).toBe(envBefore);
    expect(f.state().upFiles).toContain(OVERLAY);

    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(SET_LINE);

    // A rerun that names neither keeps both, and says nothing about them.
    f.lines.length = 0;
    expect(await serverCommand(["setup", "--offline", "--yes"], f.runtime)).toEqual({
      _tag: "ok",
    });
    expect(f.lines.some((line) => line.startsWith("workspace memory"))).toBe(false);
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);

    expect(await f.upgrade()).toEqual({ _tag: "ok" });
    expect(f.files()[OVERLAY]).toBe(files[OVERLAY]);
    expect(JSON.parse(f.files()["server.json"] ?? "{}").workspaceMemory).toEqual({
      workspace: "4g",
      dockerService: "none",
    });
    expect(f.state().upFiles).toContain(OVERLAY);
  });

  it("go back to sealant's defaults one at a time with default", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(
        ["setup", "--offline", "--workspace-memory", "6GiB", "--workspace-docker-memory", "2g"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--workspace-memory", "default"], f.runtime),
    ).toEqual({ _tag: "ok" });
    expect(JSON.parse(f.files()["server.json"] ?? "{}").workspaceMemory).toEqual({
      dockerService: "2g",
    });
    expect(f.files()[OVERLAY]).not.toContain("SEALANT_DOCKER_WORKSPACE_MEMORY_LIMIT");
    f.lines.length = 0;
    expect(await serverCommand(["status"], f.runtime)).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(
      "workspace memory · each session's workspace gets half of this machine's memory (2 to 16 GiB), its Docker service 2g · the workspace's limit is sealant's default",
    );

    f.lines.length = 0;
    expect(
      await serverCommand(
        ["setup", "--offline", "--workspace-docker-memory", "default"],
        f.runtime,
      ),
    ).toEqual({ _tag: "ok" });
    expect(f.lines).toContain(`${DEFAULTS_LINE}. ${RESTART}`);
    expect(f.files()[OVERLAY]).toBeUndefined();
    expect(JSON.parse(f.files()["server.json"] ?? "{}")).not.toHaveProperty("workspaceMemory");
    expect(f.state().upFiles).not.toContain(OVERLAY);
  });

  it("refuses a value that is not auto, none or a size of at least 64m", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    for (const [flag, value] of [
      ["--workspace-memory", "32m"],
      ["--workspace-memory", "4 GB"],
      ["--workspace-memory", ""],
      ["--workspace-memory", "unlimited"],
      ["--workspace-docker-memory", "1.5g"],
      ["--workspace-docker-memory", "-1"],
    ] as const) {
      const result = await serverCommand(["setup", "--offline", flag, value], f.runtime);
      expect(result._tag).toBe("error");
      expect(result._tag === "error" ? result.message : "").toContain(
        `${flag} must be auto, none, a size of at least 64m`,
      );
    }
    expect(f.files()[OVERLAY]).toBeUndefined();
  });

  it("refuses a config whose saved limits are not what a setup writes", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    const config = path.join(f.active(), "server.json");
    const saved = JSON.parse(fs.readFileSync(config, "utf8"));
    fs.writeFileSync(
      config,
      `${JSON.stringify({ ...saved, workspaceMemory: { workspace: "lots" } }, null, 2)}\n`,
    );
    const result = await serverCommand(["status"], f.runtime);
    expect(result._tag).toBe("error");
    expect(result._tag === "error" ? result.message : "").toContain(
      "Server config is corrupt: workspaceMemory must hold workspace and dockerService",
    );
  });

  it("refuses a generation whose overlay does not match its config", async () => {
    const f = await fixture();
    expect(await f.setup()).toEqual({ _tag: "ok" });
    expect(
      await serverCommand(["setup", "--offline", "--workspace-memory", "4g"], f.runtime),
    ).toEqual({ _tag: "ok" });
    const overlay = path.join(f.active(), OVERLAY);
    fs.writeFileSync(overlay, fs.readFileSync(overlay, "utf8").replace('"4g"', '"none"'));
    const result = await serverCommand(["status"], f.runtime);
    expect(result._tag).toBe("error");
    expect(result._tag === "error" ? result.message : "").toContain(
      `${OVERLAY} does not match the saved workspace memory settings`,
    );
  });
});
