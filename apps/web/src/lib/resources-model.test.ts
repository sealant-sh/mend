import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  presetDefinition,
  PresetVersion,
  ResourceName,
  ResourceSpecDigest,
} from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  choiceLabel,
  declaredFile,
  githubFileUrl,
  levelLine,
  panelWord,
  portFlags,
  resourceCount,
  resourcePanels,
  rowWords,
  withoutName,
  worktreeDeclarations,
  type WorktreeRead,
} from "./resources-model.ts";
import type { ResourcesPageView, ResourceSettingView } from "./resources.ts";

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
    const [panel] = resourcePanels({ ...projectPage, settings: [] }, [], "main");
    expect(panel?.project).toBeUndefined();
    expect(panel?.kindLine).toBe("postgres 17 · declared on main");
    expect(panel?.statusLine).toBe("postgres:17 · in .mend/mend.toml");
    expect(panel?.tone).toBe("idle");
    expect(panel === undefined ? null : panelWord(panel)).toBe("Not started");
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

describe("the words a panel shows", () => {
  const reads = [
    worktreeRead(wtA, "refund-idempotency-keys", {
      settings: [entry({ choice: "worktree", canChoose: true })],
      file: { kind: "not-selected" },
    }),
    worktreeRead(wtB, "try-vitest-4", {
      settings: [entry({ choice: "off", canChoose: true, instance: "none" })],
      file: { kind: "not-selected" },
    }),
  ];

  it("says what each worktree uses, and whether it runs", () => {
    const [panel] = resourcePanels(projectPage, reads);
    if (panel === undefined) throw new Error("no panel");
    expect(panelWord(panel)).toBe("Running");
    expect(panel.rows.map((row) => rowWords(row, panel))).toEqual([
      "Its own database · running",
      "No database",
    ]);
  });

  it("says a worktree's database is loading while a load goes into it", () => {
    const [panel] = resourcePanels(projectPage, [
      worktreeRead(wtA, "fix-checkout-retry", {
        settings: [entry({ choice: "project", canChoose: true })],
        file: { kind: "not-selected" },
      }),
    ]);
    if (panel === undefined) throw new Error("no panel");
    expect(panel.rows.map((row) => rowWords(row, panel, "shared"))).toEqual([
      "The shared database · loading",
    ]);
    expect(panel.rows.map((row) => rowWords(row, panel, "own"))).toEqual(["The shared database"]);
  });

  it("says the project's instance is not running when it failed", () => {
    const failed: ResourcesPageView = {
      ...projectPage,
      settings: [entry({ instance: "failed", statusLine: "@db · failed · exited with code 1" })],
    };
    const [panel] = resourcePanels(failed, [
      worktreeRead(wtA, "fix-checkout-retry", {
        settings: [entry({ choice: null, canChoose: true, instance: "failed" })],
        file: { kind: "not-selected" },
      }),
    ]);
    if (panel === undefined) throw new Error("no panel");
    expect(panelWord(panel)).toBe("Failed");
    expect(panel.tone).toBe("bad");
    expect(panel.rows.map((row) => rowWords(row, panel))).toEqual([
      "The shared database · not running",
    ]);
  });

  it("words the levels for Postgres and for any other image", () => {
    expect(levelLine({ name: "db", spec: db, choosing: true })).toBe(
      "Each worktree uses the shared database, a database of its own, or none.",
    );
    expect(levelLine({ name: "redis", spec: cache, choosing: true })).toBe(
      "Every worktree uses the project's @redis unless it picks its own or none.",
    );
  });

  it("counts resources by name, declared or running", () => {
    expect(resourceCount(projectPage)).toBe(2);
    expect(resourceCount({ settings: [], file: { kind: "not-selected" } })).toBe(0);
  });
});

describe("the declared file", () => {
  it("names the file the read came from, or none when it could not be read", () => {
    expect(
      declaredFile({
        kind: "unparsed",
        worktreeId: null,
        observed: ".mend/mend.toml · observed at capture 12",
        message: "not TOML",
      }),
    ).toBe(".mend/mend.toml");
    expect(
      declaredFile({
        kind: "absent",
        worktreeId: null,
        observed: "mend.toml · observed on the worktree",
      }),
    ).toBe("mend.toml");
    expect(declaredFile({ kind: "unavailable", worktreeId: null, message: "x" })).toBeNull();
  });

  it("links to the file on GitHub only for a GitHub origin", () => {
    expect(
      githubFileUrl("https://github.com/northwind/checkout-api.git", "main", ".mend/mend.toml"),
    ).toBe("https://github.com/northwind/checkout-api/blob/main/.mend/mend.toml");
    expect(
      githubFileUrl("git@github.com:northwind/checkout-api.git", "release/2", "mend.toml"),
    ).toBe("https://github.com/northwind/checkout-api/blob/release%2F2/mend.toml");
    expect(
      githubFileUrl("https://gitlab.com/northwind/checkout-api", "main", "mend.toml"),
    ).toBeNull();
    expect(githubFileUrl(null, "main", "mend.toml")).toBeNull();
  });
});

describe("ports typed into Add a resource", () => {
  it("passes named ports through and names bare ones", () => {
    expect(portFlags("smtp=1025 http=8025")).toEqual([
      "--port",
      "smtp=1025",
      "--port",
      "http=8025",
    ]);
    expect(portFlags("7700")).toEqual(["--port", "port=7700"]);
    expect(portFlags("7700, 7701/udp")).toEqual([
      "--port",
      "port7700=7700",
      "--port",
      "port7701=7701/udp",
    ]);
    expect(portFlags("  ")).toEqual([]);
  });
});
