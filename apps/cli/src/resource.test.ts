import { ResourceDefinitionId, WorktreeId } from "@mend/domain";
import {
  resourceChoiceOf,
  resourcePositionals,
  presetDefinition,
  PresetVersion,
  ResourceName,
  resourceSpecDigest,
  type ResourceSettingEntry,
  type ResourcesPage,
} from "@mend/domain/workbench";
import { describe, expect, it, vi, afterEach } from "vitest";

import type { ApiCall } from "./pair.ts";
import { resourceCommand, renderResources } from "./resource.ts";
const project = { id: "p", name: "project" };
const output = () => {
  const lines: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
  return lines;
};
const server = (answer: unknown) => {
  const calls: Array<{ method: string; route: string; body: unknown }> = [];
  const api: ApiCall = async (method, route, body) => {
    calls.push({ method, route, body });
    return JSON.parse(
      JSON.stringify(
        route.endsWith("/worktrees") ? { worktrees: [{ id: "wt", name: "checkout" }] } : answer,
      ),
    );
  };
  return { api, calls };
};
afterEach(() => vi.restoreAllMocks());
describe("resource command levels", () => {
  it("parses bare levels without consuming names and keeps selector values out of positionals", () => {
    expect(
      resourcePositionals([
        "db",
        "--project",
        "--worktree-id",
        "wt",
        "--project-id",
        "p",
        "--restart",
      ]),
    ).toEqual(["db"]);
    expect(resourceChoiceOf("shared")).toBe("project");
    expect(resourceChoiceOf("own")).toBe("worktree");
  });
  it("starts by name with level, worktree and restart in the request", async () => {
    const out = output();
    const s = server({
      kind: "started",
      instance: "running",
      statusLine: "@db · running · project",
      message: null,
    });
    const projectOf = vi.fn(async () => project);
    await resourceCommand(s.api, projectOf, [
      "start",
      "db",
      "--project",
      "--worktree-id",
      "checkout",
      "--project-id",
      "p",
      "--restart",
    ]);
    expect(projectOf).toHaveBeenCalledWith("p");
    expect(s.calls.at(-1)).toMatchObject({
      method: "POST",
      body: { level: "project", worktreeId: "wt", restart: true },
    });
    expect(s.calls.at(-1)?.route).toContain("/resources/db/start?");
    expect(out.join("")).toContain("@db · running · project");
  });
  it("prints needs-restart and affected worktrees without restarting in a non-terminal", async () => {
    const out = output();
    const s = server({
      kind: "needs-restart",
      statusLine: "@db · project · definition differs from this worktree",
      hint: "mend resource start db --project --restart",
      worktrees: [{ id: "wt", name: "checkout" }],
    });
    await resourceCommand(s.api, async () => project, [
      "start",
      "db",
      "--project",
      "--worktree-id",
      "wt",
    ]);
    expect(s.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(out.join("")).toContain("checkout");
    expect(out.join("")).toContain("--restart");
  });
  it("refuses a non-terminal start with no level before making a request", async () => {
    output();
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const s = server(null);
    await expect(
      resourceCommand(s.api, async () => project, ["start", "db", "--worktree-id", "wt"]),
    ).rejects.toThrow("exit");
    expect(s.calls).toEqual([]);
    expect(process.stderr.write).toHaveBeenCalledWith(
      "mend: choose a level: mend resource start db --project or --worktree\n",
    );
  });
  it("switches using the resource name and accepts Postgres aliases", async () => {
    const out = output();
    const s = server({ statusLine: "@db · worktree", message: "switched" });
    await resourceCommand(s.api, async () => project, ["use", "db", "own", "--worktree-id", "wt"]);
    expect(s.calls.at(-1)).toMatchObject({ method: "PUT", body: { mode: "worktree" } });
    expect(s.calls.at(-1)?.route).toContain("/resources/db/selection?");
    expect(out.join("")).toContain("switched");
  });
  it("removes one named level", async () => {
    output();
    const s = server({ statusLine: "archived" });
    await resourceCommand(s.api, async () => project, [
      "remove",
      "db",
      "--project",
      "--worktree-id",
      "wt",
    ]);
    expect(s.calls.at(-1)).toEqual({
      method: "DELETE",
      route: "/projects/p/resources/db",
      body: { level: "project", worktreeId: "wt" },
    });
  });
  it("renders an unavailable file without claiming there are no definitions", () => {
    expect(
      renderResources(
        project,
        {
          settings: [],
          file: {
            kind: "unavailable",
            worktreeId: WorktreeId.make("wt"),
            message: "file unavailable",
          },
        },
        "checkout",
      ).join("\n"),
    ).toContain(".mend/mend.toml in checkout · file unavailable");
  });
  it("prints a definition once, with project and worktree statuses underneath", async () => {
    const spec = presetDefinition({
      name: ResourceName.make("cache"),
      preset: "redis",
      version: PresetVersion.make("8"),
    });
    const entry: ResourceSettingEntry = {
      id: ResourceDefinitionId.make("cache"),
      digest: resourceSpecDigest(spec),
      spec,
      image: spec.image,
      addedBy: "alice",
      level: "project",
      worktreeId: null,
      choice: "project",
      canRemove: true,
      canChoose: true,
      canLoadOwn: false,
      instance: "running",
      statusLine: "@cache · running · project · observed 3 s ago",
    };
    const own = {
      ...entry,
      level: "worktree" as const,
      worktreeId: WorktreeId.make("wt"),
      statusLine: "@cache · running · worktree · observed 3 s ago",
    };
    const page: ResourcesPage = {
      settings: [entry, own],
      file: {
        kind: "read",
        worktreeId: null,
        observed: "default branch",
        tables: [
          {
            spec,
            digest: entry.digest,
            statusLine: "@cache · redis:8 · in .mend/mend.toml · not started",
          },
        ],
        refused: [],
        ignored: [],
      },
    };
    const out = output();
    const s = server(page);
    await resourceCommand(s.api, async () => project, ["list", "--worktree-id", "wt"]);
    const text = out.join("");
    expect(text.match(/^@cache/gm)).toHaveLength(1);
    expect(text).toContain(`  ${entry.statusLine}`);
    expect(text).toContain(`  ${own.statusLine}`);
    expect(text).not.toContain("not started");
    expect(renderResources(project, { ...page, settings: [] }, "checkout").join("\n")).toContain(
      "not started",
    );
  });
});

describe("resource add writes through the API", () => {
  it("sends a parsed preset and chosen worktree and prints the server's answer", async () => {
    const out = output();
    const s = server({
      kind: "written",
      path: "mend.toml",
      table: "",
      worktree: "checkout",
      statusLine:
        "@db · added to mend.toml in checkout · start it: mend resource start db --project or --worktree",
    });
    await resourceCommand(s.api, async () => project, [
      "add",
      "db",
      "--preset",
      "postgres",
      "--version",
      "17",
      "--worktree-id",
      "checkout",
    ]);
    expect(s.calls.at(-1)).toEqual({
      method: "POST",
      route: "/projects/p/worktrees/resources",
      body: { worktreeId: "wt", definition: { name: "db", preset: "postgres", version: "17" } },
    });
    expect(out.join("")).toContain("added to mend.toml in checkout");
  });
  it("sends a whole image definition and prints a copyable multiline table", async () => {
    const out = output();
    const s = server({
      kind: "unreachable",
      reason: "offline",
      table: '[resource.mail]\nimage = "mailpit:v1"\nports = { smtp = 1025 }\n',
      statusLine: "@mail · offline · add this table to .mend/mend.toml yourself:",
    });
    await resourceCommand(s.api, async () => project, [
      "add",
      "mail",
      "--image",
      "mailpit:v1",
      "--port",
      "smtp=1025",
      "--worktree-id",
      "wt",
    ]);
    expect(s.calls.at(-1)?.body).toMatchObject({
      worktreeId: "wt",
      definition: {
        name: "mail",
        image: "mailpit:v1",
        ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
      },
    });
    expect(out.join("")).toContain('yourself:\n[resource.mail]\nimage = "mailpit:v1"\n');
  });
});

it("stops and removes a project instance without a worktree selector", async () => {
  output();
  const s = server({ instance: "stopped", statusLine: "@db · stopped", message: null });
  await resourceCommand(s.api, async () => project, ["stop", "db", "--project"]);
  expect(s.calls.at(-1)?.body).toEqual({ level: "project", worktreeId: null });
  await resourceCommand(s.api, async () => project, ["remove", "db", "--project"]);
  expect(s.calls.at(-1)?.body).toEqual({ level: "project", worktreeId: null });
});
