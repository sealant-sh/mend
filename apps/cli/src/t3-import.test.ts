import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultT3Home, type ImportCandidate, type T3ImportScanInput } from "./t3-import.ts";
import {
  claudeId,
  codexId,
  rollout,
  SCHEMA,
  t3Machine as machine,
  write,
} from "./test/t3-machine.ts";

/** One Claude provider thread whose conversation is `claudeId(n)`. */
const on = (n: number) => [{ id: `pt-${n}`, driver: "claudeAgent", nativeId: claudeId(n) }];

const outcomes = (candidates: ReadonlyArray<ImportCandidate>) =>
  candidates.map((candidate) => [
    candidate.thread.threadId,
    candidate._tag === "skipped" ? candidate.skip.reason : candidate._tag,
  ]);

const ready = (candidates: ReadonlyArray<ImportCandidate>, threadId: string) => {
  const candidate = candidates.find((each) => each.thread.threadId === threadId);
  if (candidate?._tag !== "ready") throw new Error(`${threadId} is not ready`);
  return candidate;
};

describe("T3 Code's data directory", () => {
  it("is ~/.t3 unless T3CODE_HOME names another, ~ expanded", () => {
    expect(defaultT3Home({}, "/Users/ana")).toBe("/Users/ana/.t3");
    expect(defaultT3Home({ T3CODE_HOME: "  " }, "/Users/ana")).toBe("/Users/ana/.t3");
    expect(defaultT3Home({ T3CODE_HOME: "~/Library/T3" }, "/Users/ana")).toBe(
      "/Users/ana/Library/T3",
    );
    expect(defaultT3Home({ T3CODE_HOME: "/srv/t3" }, "/home/ana")).toBe("/srv/t3");
  });
});

describe("reading T3 Code's threads as import candidates", () => {
  it("makes a Claude thread ready with its checkout, files, model and mode", async () => {
    const world = machine();
    const app = world.repo("app", "git@github.com:ana/app.git");
    world.project("p-app", "app", app);
    const id = claudeId(1);
    const claude = path.join(world.home, ".claude");
    const key = app.replace(/[^a-zA-Z0-9]/g, "-");
    write(path.join(claude, "projects", key, `${id}.jsonl`), '{"type":"user"}\n');
    write(path.join(claude, "projects", key, id, "tool-results", "t1.txt"), "out");
    write(path.join(claude, "projects", key, id, "subagents", "agent-a.jsonl"), "{}\n");
    write(path.join(claude, "tasks", id, "1.json"), "{}");
    write(path.join(claude, "todos", `${id}-agent-${id}.json`), "[]");
    // Another conversation's files in the same project are not this one's.
    write(path.join(claude, "projects", key, `${claudeId(9)}.jsonl`), "{}\n");
    world.thread({
      id: "t-claude",
      project: "p-app",
      title: "Fix the build",
      branch: "fix/build",
      runtimeMode: "approval-required",
      model: { instance: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
      providers: [{ id: "pt-1", driver: "claudeAgent", nativeId: id }],
    });

    const [candidate] = await world.scan();

    expect(candidate).toEqual({
      _tag: "ready",
      thread: {
        threadId: "t-claude",
        title: "Fix the build",
        archived: false,
        project: { id: "p-app", title: "app", root: app },
      },
      checkout: { workingDirectory: app, root: app, originUrl: "git@github.com:ana/app.git" },
      branch: "fix/build",
      harness: "claude",
      harnessHome: claude,
      nativeId: id,
      transcript: `projects/${key}/${id}.jsonl`,
      files: [
        { relativePath: `projects/${key}/${id}.jsonl`, bytes: 16 },
        { relativePath: `projects/${key}/${id}/subagents/agent-a.jsonl`, bytes: 3 },
        { relativePath: `projects/${key}/${id}/tool-results/t1.txt`, bytes: 3 },
        { relativePath: `tasks/${id}/1.json`, bytes: 2 },
        { relativePath: `todos/${id}-agent-${id}.json`, bytes: 2 },
      ],
      model: "claude-opus-5-5",
      effort: "high",
      permissionMode: "ask",
      runtimeMode: "approval-required",
    });
  });

  it("skips each thread it cannot import with one reason", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    const local = world.repo("local-only", null);
    const plain = path.join(world.home, "notes");
    fs.mkdirSync(plain);
    world.project("p-app", "app", app);
    world.project("p-local", "local-only", local);
    world.project("p-notes", "notes", plain);
    const claude = path.join(world.home, ".claude", "projects", "k");
    for (const n of [1, 2, 3, 4]) write(path.join(claude, `${claudeId(n)}.jsonl`), "{}\n");
    world.thread({
      id: "no-ref",
      project: "p-app",
      providers: [{ id: "pt-0", driver: "claudeAgent", nativeId: null }],
    });
    world.thread({ id: "no-file", project: "p-app", providers: on(8) });
    world.thread({
      id: "gone",
      project: "p-app",
      worktreePath: "/Users/ana/.t3/worktrees/app/gone",
      providers: on(1),
    });
    world.thread({ id: "not-git", project: "p-notes", providers: on(2) });
    world.thread({ id: "no-origin", project: "p-local", providers: on(3) });
    world.thread({
      id: "other-harness",
      project: "p-app",
      providers: [{ id: "pt-x", driver: "opencode", nativeId: "x" }],
    });
    world.thread({
      id: "switched-unknown",
      project: "p-app",
      providers: [
        { id: "pt-a", driver: "claudeAgent", nativeId: claudeId(4) },
        { id: "pt-b", driver: "codex", nativeId: codexId(4) },
      ],
      active: null,
    });

    const candidates = await world.scan();

    expect(outcomes(candidates)).toEqual([
      ["no-ref", "no-native-conversation"],
      ["no-file", "conversation-not-on-machine"],
      ["gone", "gone"],
      ["other-harness", "unsupported-harness"],
      ["switched-unknown", "several-native-conversations"],
      ["no-origin", "no-origin"],
      ["not-git", "not-a-git-checkout"],
    ]);
  });

  it("keeps a gone checkout's conversation when its project's root still has an origin", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    world.project("p-app", "app", app);
    world.project("p-moved", "moved", path.join(world.home, "code", "moved"));
    const gone = path.join(world.t3Home, "worktrees", "app", "t3code-1a2b");
    const key = gone.replace(/[^a-zA-Z0-9]/g, "-");
    const claude = path.join(world.home, ".claude");
    for (const n of [1, 2])
      write(path.join(claude, "projects", key, `${claudeId(n)}.jsonl`), '{"type":"user"}\n');
    world.thread({
      id: "gone",
      project: "p-app",
      worktreePath: gone,
      branch: "t3code/1a2b",
      providers: on(1),
    });
    world.thread({ id: "root-gone", project: "p-moved", worktreePath: gone, providers: on(2) });

    const candidates = await world.scan();

    expect(outcomes(candidates)).toEqual([
      ["gone", "gone"],
      ["root-gone", "checkout-gone"],
    ]);
    expect(candidates[0]).toMatchObject({
      _tag: "gone",
      workingDirectory: gone,
      branch: "t3code/1a2b",
      projectCheckout: { root: app, originUrl: "https://example.com/ana/app.git" },
      harness: "claude",
      nativeId: claudeId(1),
      files: [{ relativePath: `projects/${key}/${claudeId(1)}.jsonl`, bytes: 16 }],
    });
  });

  it("leaves out subagents and deleted threads, and marks archived ones", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    world.project("p-app", "app", app);
    const claude = path.join(world.home, ".claude", "projects", "k");
    for (const n of [1, 2, 3, 4, 5]) write(path.join(claude, `${claudeId(n)}.jsonl`), "{}\n");
    world.thread({ id: "parent", project: "p-app", providers: on(1) });
    world.thread({
      id: "child",
      project: "p-app",
      parent: { id: "parent", relationship: "subagent" },
      providers: on(2),
    });
    world.thread({
      id: "fork",
      project: "p-app",
      parent: { id: "parent", relationship: "fork" },
      providers: on(3),
    });
    world.thread({ id: "deleted", project: "p-app", deleted: true, providers: on(4) });
    world.thread({ id: "archived", project: "p-app", archived: true, providers: on(5) });

    const candidates = await world.scan();

    // A fork is a conversation of its own, listed by T3 Code beside its parent.
    expect(candidates.map(({ thread }) => [thread.threadId, thread.archived])).toEqual([
      ["parent", false],
      ["fork", false],
      ["archived", true],
    ]);
  });

  it("names one checkout for threads that reach it by different paths", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    const viaLink = path.join(world.home, "app-link");
    fs.symlinkSync(app, viaLink);
    world.project("p-app", "app", app);
    const claude = path.join(world.home, ".claude", "projects", "k");
    for (const n of [1, 2]) write(path.join(claude, `${claudeId(n)}.jsonl`), "{}\n");
    world.thread({
      id: "at-root",
      project: "p-app",
      providers: [{ id: "pt-1", driver: "claudeAgent", nativeId: claudeId(1) }],
    });
    world.thread({
      id: "via-link",
      project: "p-app",
      worktreePath: viaLink,
      providers: [{ id: "pt-2", driver: "claudeAgent", nativeId: claudeId(2) }],
    });

    const candidates = await world.scan();

    const first = ready(candidates, "at-root");
    const second = ready(candidates, "via-link");
    expect(second.checkout.workingDirectory).toBe(viaLink);
    expect(second.checkout.root).toBe(first.checkout.root);
  });

  it("follows the active provider of a thread whose provider was switched", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    world.project("p-app", "app", app);
    const id = codexId(1);
    write(path.join(world.home, ".claude", "projects", "k", `${claudeId(1)}.jsonl`), "{}\n");
    write(
      path.join(
        world.home,
        ".codex",
        "sessions",
        "2026",
        "01",
        "02",
        `rollout-2026-01-02T10-00-00-${id}.jsonl`,
      ),
      rollout(id, null),
    );
    world.thread({
      id: "switched",
      project: "p-app",
      model: { instance: "codex", model: "gpt-6-astra", effort: "xhigh" },
      providers: [
        { id: "pt-claude", driver: "claudeAgent", nativeId: claudeId(1) },
        { id: "pt-codex", driver: "codex", nativeId: id },
      ],
      active: "pt-codex",
    });

    const candidate = ready(await world.scan(), "switched");

    expect([candidate.harness, candidate.nativeId, candidate.model, candidate.effort]).toEqual([
      "codex",
      id,
      "gpt-6-astra",
      "xhigh",
    ]);
  });

  it("carries a Codex rollout's ancestors, and skips it when one is missing", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    world.project("p-app", "app", app);
    const codex = path.join(world.home, ".codex");
    const [child, parent, orphan, lost] = [codexId(1), codexId(2), codexId(3), codexId(4)];
    const childPath = `sessions/2026/01/03/rollout-2026-01-03T09-00-00-${child}.jsonl`;
    const parentPath = `archived_sessions/rollout-2026-01-01T09-00-00-${parent}.jsonl`;
    write(path.join(codex, childPath), rollout(child, parent));
    write(path.join(codex, parentPath), rollout(parent, null));
    write(
      path.join(codex, `sessions/2026/01/04/rollout-2026-01-04T09-00-00-${orphan}.jsonl`),
      rollout(orphan, lost),
    );
    world.thread({
      id: "chained",
      project: "p-app",
      providers: [{ id: "pt-1", driver: "codex", nativeId: child }],
    });
    world.thread({
      id: "orphaned",
      project: "p-app",
      providers: [{ id: "pt-2", driver: "codex", nativeId: orphan }],
    });

    const candidates = await world.scan();

    const chained = ready(candidates, "chained");
    expect(chained.transcript).toBe(childPath);
    expect(chained.files.map((file) => file.relativePath)).toEqual([parentPath, childPath]);
    expect(candidates.find((each) => each.thread.threadId === "orphaned")).toMatchObject({
      _tag: "skipped",
      skip: { reason: "conversation-not-on-machine", nativeId: lost },
    });
  });

  it("finds a conversation in the home its provider instance was given", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    world.project("p-app", "app", app);
    const work = path.join(world.home, ".claude-work");
    write(
      path.join(world.t3Home, "userdata", "settings.json"),
      JSON.stringify({
        providerInstances: {
          claudeWork: { driver: "claudeAgent", config: { homePath: "~/.claude-work" } },
        },
      }),
    );
    write(path.join(work, "projects", "k", `${claudeId(1)}.jsonl`), "{}\n");
    // The same id in the default home is not the instance's conversation.
    write(path.join(world.home, ".claude", "projects", "k", `${claudeId(2)}.jsonl`), "{}\n");
    world.thread({
      id: "work",
      project: "p-app",
      providers: [
        { id: "pt-1", driver: "claudeAgent", nativeId: claudeId(1), instance: "claudeWork" },
      ],
    });
    world.thread({
      id: "default",
      project: "p-app",
      providers: [
        { id: "pt-2", driver: "claudeAgent", nativeId: claudeId(2), instance: "claudeWork" },
      ],
    });

    const candidates = await world.scan();

    expect(ready(candidates, "work").harnessHome).toBe(work);
    expect(outcomes(candidates)).toContainEqual(["default", "conversation-not-on-machine"]);
  });

  it("looks in the home the shell names and in the default one", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    world.project("p-app", "app", app);
    const shellHome = path.join(world.home, "agents", "codex");
    const [inShell, inDefault] = [codexId(1), codexId(2)];
    write(
      path.join(shellHome, `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${inShell}.jsonl`),
      rollout(inShell, null),
    );
    write(
      path.join(
        world.home,
        ".codex",
        `sessions/2026/01/01/rollout-2026-01-01T00-00-00-${inDefault}.jsonl`,
      ),
      rollout(inDefault, null),
    );
    world.thread({
      id: "from-terminal",
      project: "p-app",
      providers: [{ id: "pt-1", driver: "codex", nativeId: inShell }],
    });
    world.thread({
      id: "from-app",
      project: "p-app",
      providers: [{ id: "pt-2", driver: "codex", nativeId: inDefault }],
    });

    const candidates = await world.scan({ environment: { CODEX_HOME: "~/agents/codex" } });

    expect(ready(candidates, "from-terminal").harnessHome).toBe(shellHome);
    expect(ready(candidates, "from-app").harnessHome).toBe(path.join(world.home, ".codex"));
  });

  it("keeps only the project and threads a filter names", async () => {
    const world = machine();
    const app = world.repo("app", "https://example.com/ana/app.git");
    const web = world.repo("web", "https://example.com/ana/web.git");
    world.project("p-app", "app", app);
    world.project("p-web", "web", web);
    for (const id of ["a1", "a2", "w1"])
      world.thread({ id, project: id.startsWith("a") ? "p-app" : "p-web" });

    const ids = async (filter: T3ImportScanInput["filter"]) =>
      (await world.scan({ filter: filter ?? {} })).map(({ thread }) => thread.threadId);

    expect(await ids({ projects: ["web"] })).toEqual(["w1"]);
    expect(await ids({ projects: ["p-app"] })).toEqual(["a1", "a2"]);
    expect(await ids({ projects: ["~/code/app"] })).toEqual(["a1", "a2"]);
    expect(await ids({ projects: ["web", "p-app"] })).toEqual(["a1", "a2", "w1"]);
    expect(await ids({ threadIds: ["a2", "w1"] })).toEqual(["a2", "w1"]);
  });

  it("fails naming the database when there is none", async () => {
    const world = machine();

    const error = await world.scanError();

    expect(error).toMatchObject({ _tag: "T3StateMissing", databasePath: world.databasePath });
  });

  it("fails naming what is missing when the schema is not the one it knows", async () => {
    const world = machine();
    world
      .database(
        SCHEMA.replace(
          "payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT",
          "driver TEXT, provider_instance_id TEXT",
        ),
      )
      .close();

    const error = await world.scanError();

    expect(error).toMatchObject({
      _tag: "T3StateSchemaUnknown",
      missing: ["orchestration_v2_projection_provider_threads.payload_json"],
    });
  });
});
