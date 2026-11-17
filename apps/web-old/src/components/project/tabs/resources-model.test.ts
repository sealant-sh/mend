import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { ResourcesPageView, ResourceSettingView } from "#/lib/resources";

import {
  choiceLabel,
  resourcePanels,
  withoutName,
  worktreeDeclarations,
  type WorktreeRead,
} from "./resources-model";

const db = presetDefinition({
  name: ResourceName.make("db"),
  preset: "postgres",
  version: PresetVersion.make("17"),
});
const cache = presetDefinition({
  name: ResourceName.make("cache"),
  preset: "redis",
  version: PresetVersion.make("8"),
});
const digest = ResourceSpecDigest.make("a".repeat(64));
const wtA = WorktreeId.make("wt_a");
const wtB = WorktreeId.make("wt_b");

const entry = (overrides: Partial<ResourceSettingView>): ResourceSettingView => ({
  id: ResourceDefinitionId.make("db"),
  digest,
  spec: db,
  image: db.image,
  addedBy: "alice",
  level: "project",
  worktreeId: null,
  choice: null,
  canRemove: true,
  canChoose: false,
  canLoadOwn: false,
  instance: "running",
  statusLine: "@db · running · shared database · observed 3 s ago",
  ...overrides,
});

const projectPage: ResourcesPageView = {
  settings: [
    entry({}),
    entry({
      id: ResourceDefinitionId.make("cache-a"),
      spec: cache,
      image: cache.image,
      level: "worktree",
      worktreeId: wtA,
      statusLine: "@cache · running · its own instance · observed 2 s ago",
    }),
  ],
  file: {
    kind: "read",
    worktreeId: null,
    observed: "observed at capture 12",
    tables: [{ spec: db, digest, statusLine: "@db · postgres:17 · in .mend/mend.toml" }],
    refused: [],
    ignored: [],
  },
};

const worktreeRead = (id: WorktreeId, name: string, page: ResourcesPageView): WorktreeRead => ({
  id,
  name,
  page,
  failed: null,
});

describe("the Resources tab's panels", () => {
  it("lists every worktree under a project resource with how each uses it", () => {
    const reads = [
      worktreeRead(wtA, "t3/settings-tabs", {
        settings: [
          entry({ choice: "worktree", canChoose: true, statusLine: "@db · own database" }),
        ],
        file: { kind: "not-selected" },
      }),
      worktreeRead(wtB, "fix/stop-latency", {
        settings: [entry({ choice: "off", canChoose: true, statusLine: "@db · off" })],
        file: { kind: "not-selected" },
      }),
    ];
    const [panel] = resourcePanels(projectPage, reads);
    expect(panel?.name).toBe("db");
    expect(panel?.choosing).toBe(true);
    expect(panel?.kindLine).toBe("postgres 17 · project resource");
    expect(panel?.statusLine).toBe("running · shared database · observed 3 s ago");
    expect(panel?.rows.map((row) => [row.name, row.choice])).toEqual([
      ["t3/settings-tabs", "worktree"],
      ["fix/stop-latency", "off"],
    ]);
  });

  it("lists only the worktrees that run their own instance of a worktree resource", () => {
    const reads = [
      worktreeRead(wtA, "t3/settings-tabs", { settings: [], file: { kind: "not-selected" } }),
      worktreeRead(wtB, "fix/stop-latency", { settings: [], file: { kind: "not-selected" } }),
    ];
    const panel = resourcePanels(projectPage, reads).find((row) => row.name === "cache");
    expect(panel?.choosing).toBe(false);
    expect(panel?.kindLine).toBe("redis 8 · worktree resource");
    expect(panel?.statusLine).toBe("1 running · observed");
    expect(panel?.rows.map((row) => row.name)).toEqual(["t3/settings-tabs"]);
  });

  it("says a declared resource nobody started is not started, in the server's words", () => {
    const [panel] = resourcePanels({ ...projectPage, settings: [] }, []);
    expect(panel?.project).toBeUndefined();
    expect(panel?.statusLine).toBe("postgres:17 · in .mend/mend.toml");
    expect(panel?.tone).toBe("off");
  });

  it("names a resource only a worktree's mend.toml declares", () => {
    const search = presetDefinition({
      name: ResourceName.make("search"),
      preset: "redis",
      version: PresetVersion.make("8"),
    });
    const declared = worktreeDeclarations(projectPage, [
      worktreeRead(wtA, "t3/settings-tabs", {
        settings: [],
        file: {
          kind: "read",
          worktreeId: wtA,
          observed: "observed",
          tables: [
            { spec: db, digest, statusLine: "" },
            { spec: search, digest, statusLine: "" },
          ],
          refused: [],
          ignored: [],
        },
      }),
    ]);
    expect(declared.map((row) => [row.worktree, row.spec.name])).toEqual([
      ["t3/settings-tabs", "search"],
    ]);
  });

  it("speaks Postgres in databases and other resources in instances", () => {
    expect(choiceLabel(db, "project")).toBe("Shared");
    expect(choiceLabel(db, "worktree")).toBe("Own");
    expect(choiceLabel(cache, "project")).toBe("Project");
    expect(choiceLabel(cache, "off")).toBe("Off");
    expect(withoutName("@db · running", "db")).toBe("running");
  });
});
