import { describe, expect, it } from "vitest";

import { MendRequestError } from "./server-request.ts";
import {
  parseWorktreesRmArgs,
  pickWorktree,
  refusalLines,
  removalRoute,
  type RemovableWorktree,
  removedLine,
  worktreesRmCommand,
  type WorktreesRmDeps,
} from "./worktree-remove.ts";

const WORDS =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

const SAVING =
  "not removed · saving · 1 session · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved.";

const ref = { worktreeId: "wt-1", worktreeName: "fix-login" };

/** A refusal as Mend sends it: 409, its words, and the blockers beside them. */
const refusedWith = (message: string, forceWouldLift: boolean, blockers: ReadonlyArray<unknown>) =>
  new MendRequestError("http", message, 409, {
    call: "DELETE /api/worktrees/wt-1",
    tag: "RemovalRefused",
    body: { _tag: "RemovalRefused", scope: "worktree", blockers, forceWouldLift, message },
  });

const unlanded = () =>
  refusedWith(WORDS, true, [
    {
      _tag: "Unlanded",
      ...ref,
      owner: null,
      standing: { _tag: "never-landed", files: [{ path: "a.ts", additions: 0, deletions: 0 }] },
    },
  ]);

const saving = () =>
  refusedWith(SAVING, false, [
    { _tag: "Saving", ...ref, holds: [{ sessionId: null, kind: "saving", via: "own" }] },
  ]);

const worktree = (overrides: Partial<RemovableWorktree> = {}): RemovableWorktree => ({
  id: "wt-1",
  name: "fix-login",
  projectName: "web",
  sessions: [{ id: "3f2a1c0d9e8b", status: "completed" }],
  ...overrides,
});

describe("parseWorktreesRmArgs", () => {
  it("takes the name, --force and --project in any order", () => {
    expect(parseWorktreesRmArgs(["fix-login"])).toEqual({
      args: { name: "fix-login", force: false, project: null },
    });
    expect(parseWorktreesRmArgs(["--force", "fix-login", "--project", "web"])).toEqual({
      args: { name: "fix-login", force: true, project: "web" },
    });
  });

  it("refuses no name, two names, a bare --project and an unknown option", () => {
    expect(parseWorktreesRmArgs([])).toEqual({
      error: "usage: mend worktrees rm <name> [--force] [--project <p>]",
    });
    expect(parseWorktreesRmArgs(["a", "b"])).toMatchObject({
      error: expect.stringContaining("one worktree at a time"),
    });
    expect(parseWorktreesRmArgs(["a", "--project"])).toEqual({ error: "--project needs a name" });
    expect(parseWorktreesRmArgs(["a", "--yes"])).toMatchObject({
      error: expect.stringContaining("unknown option --yes"),
    });
  });
});

describe("pickWorktree", () => {
  it("picks the one worktree of that name", () => {
    expect(pickWorktree([worktree()], "fix-login")).toEqual({ worktree: worktree() });
  });

  it("says when the name is unknown, ambiguous across projects, or from before worktrees", () => {
    expect(pickWorktree([worktree()], "nope")).toEqual({
      error: "no worktree named nope · mend worktrees lists them",
    });
    expect(
      pickWorktree([worktree(), worktree({ id: "wt-2", projectName: "api" })], "fix-login"),
    ).toEqual({
      error: "fix-login names a worktree in 2 projects: web, api · say which with --project",
    });
    expect(pickWorktree([worktree({ id: null })], "fix-login")).toMatchObject({
      error: expect.stringContaining("predates worktrees"),
    });
  });
});

describe("the request and its words", () => {
  it("carries force only when asked", () => {
    expect(removalRoute("wt-1", false)).toBe("/worktrees/wt-1");
    expect(removalRoute("wt-1", true)).toBe("/worktrees/wt-1?force=true");
  });

  it("prints the server's words verbatim and offers --force only when the refusal says force lifts it", () => {
    expect(refusalLines(unlanded(), { name: "fix-login", project: null })).toEqual([
      WORDS,
      "  mend worktrees rm fix-login --force removes it anyway",
    ]);
    expect(refusalLines(unlanded(), { name: "fix-login", project: "web" })).toEqual([
      WORDS,
      "  mend worktrees rm fix-login --project web --force removes it anyway",
    ]);
    expect(refusalLines(saving(), { name: "fix-login", project: null })).toEqual([SAVING]);
  });

  it("never offers --force from words alone, nor for a worktree someone else's change is in", () => {
    const wordsOnly = new MendRequestError("http", WORDS, 409, {
      call: "DELETE /api/worktrees/wt-1",
      tag: "RemovalRefused",
      body: { message: WORDS },
    });
    expect(refusalLines(wordsOnly, { name: "fix-login", project: null })).toEqual([WORDS]);
    const forbidden = new MendRequestError(
      "http",
      "not removed · only Ada, who started this worktree's change, removes it.",
      403,
      { call: "DELETE /api/worktrees/wt-1", tag: "RemovalForbidden" },
    );
    expect(refusalLines(forbidden, { name: "fix-login", project: null })).toEqual([
      "not removed · only Ada, who started this worktree's change, removes it.",
    ]);
  });

  it("says what went with the worktree, without a count the listing cannot vouch for", () => {
    expect(removedLine("fix-login")).toBe(
      "removed · fix-login · its sessions, change, checkpoints and review went with it",
    );
  });
});

const harness = (
  answer: (route: string) => Promise<unknown>,
  worktrees: ReadonlyArray<RemovableWorktree> = [worktree()],
) => {
  const said: string[] = [];
  const failed: string[] = [];
  const routes: string[] = [];
  const listed: Array<string | null> = [];
  const deps: WorktreesRmDeps = {
    request: async <T>(_method: string, route: string): Promise<T> => {
      routes.push(route);
      return (await answer(route)) as T;
    },
    listWorktrees: async (project) => {
      listed.push(project);
      return worktrees;
    },
    say: (line) => void said.push(line),
    fail: (message) => {
      failed.push(message);
      throw new Error(`exit: ${message}`);
    },
  };
  return { deps, said, failed, routes, listed };
};

describe("worktreesRmCommand", () => {
  it("removes without force and says what went", async () => {
    const h = harness(async () => ({ removed: true, leftover: null }));
    await worktreesRmCommand(h.deps, ["fix-login"]);
    expect(h.routes).toEqual(["/worktrees/wt-1"]);
    expect(h.listed).toEqual([null]);
    expect(h.said).toEqual([
      "removed · fix-login · its sessions, change, checkpoints and review went with it",
    ]);
    expect(h.failed).toEqual([]);
  });

  it("scopes the listing to --project and says what was left behind", async () => {
    const h = harness(async () => ({ removed: true, leftover: "/store/worktrees/fix-login/.git" }));
    await worktreesRmCommand(h.deps, ["--project", "web", "fix-login"]);
    expect(h.listed).toEqual(["web"]);
    expect(h.said).toEqual([
      "removed · fix-login · its sessions, change, checkpoints and review went with it",
      "left behind · /store/worktrees/fix-login/.git",
    ]);
  });

  it("a refusal force does not lift stays a refusal with --force, without the --force line", async () => {
    const h = harness(async () => {
      throw saving();
    });
    await expect(worktreesRmCommand(h.deps, ["fix-login", "--force"])).rejects.toThrow("exit:");
    expect(h.routes).toEqual(["/worktrees/wt-1?force=true"]);
    expect(h.failed).toEqual([SAVING]);
  });

  it("prints a transport failure and a report that says not removed as they are", async () => {
    const down = harness(async () => {
      throw new MendRequestError("unreachable", "cannot reach http://localhost:3105", null);
    });
    await expect(worktreesRmCommand(down.deps, ["fix-login"])).rejects.toThrow("exit:");
    expect(down.failed).toEqual(["cannot reach http://localhost:3105"]);

    const kept = harness(async () => ({ removed: false, leftover: "a workspace still saving" }));
    await expect(worktreesRmCommand(kept.deps, ["fix-login"])).rejects.toThrow("exit:");
    expect(kept.failed).toEqual(["not removed · fix-login · a workspace still saving"]);
    expect(kept.said).toEqual([]);
  });

  it("prints the refusal in the server's words with the --force line, and exits 1", async () => {
    const h = harness(async () => {
      throw unlanded();
    });
    await expect(worktreesRmCommand(h.deps, ["fix-login"])).rejects.toThrow("exit:");
    expect(h.routes).toEqual(["/worktrees/wt-1"]);
    expect(h.failed).toEqual([`${WORDS}\n  mend worktrees rm fix-login --force removes it anyway`]);
    expect(h.said).toEqual([]);
  });

  it("passes force=true only with --force", async () => {
    const h = harness(async (route) =>
      route.endsWith("?force=true")
        ? { removed: true, leftover: null }
        : Promise.reject(unlanded()),
    );
    await worktreesRmCommand(h.deps, ["fix-login", "--force"]);
    expect(h.routes).toEqual(["/worktrees/wt-1?force=true"]);
    expect(h.said).toEqual([
      "removed · fix-login · its sessions, change, checkpoints and review went with it",
    ]);
  });

  it("prints a live session's refusal from the server, without the --force line", async () => {
    const words = "not removed · a session 3f2a1c0d is live · stop it first.";
    const h = harness(async () => {
      throw refusedWith(words, false, [
        {
          _tag: "SessionLive",
          ...ref,
          sessionId: "3f2a1c0d9e8b",
          owner: null,
          role: "inhabitant",
          activity: "live",
        },
      ]);
    });
    await expect(worktreesRmCommand(h.deps, ["fix-login", "--force"])).rejects.toThrow("exit:");
    expect(h.routes).toEqual(["/worktrees/wt-1?force=true"]);
    expect(h.failed).toEqual([words]);
  });
});
