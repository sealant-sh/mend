import { ProjectId, SessionRepositoryId, Sha, type SessionId } from "@mend/domain";
import { SessionRepository } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * Removing a worktree whose sessions added repositories with `mend repo add`
 * (docs/adr/0011-repositories-in-a-session.md): their files live nested inside this worktree,
 * outside its change, and go with it. Removal refuses for them as it does for an unlanded change,
 * and `force=true` is the override.
 */

/** What migration 0164 keeps of a repository nested in the worktree. */
const nestedOf = (row: { readonly path: string; readonly branch: string }) => ({
  path: row.path,
  branch: row.branch,
});
const privateAlice = ids("private-alice");
const NOW = new Date("2026-10-05T09:00:00.000Z");

const repository = (
  name: string,
  facts: Partial<Pick<SessionRepository, "capture" | "state">> = {},
): SessionRepository =>
  new SessionRepository({
    id: SessionRepositoryId.make(`repository-${name}`),
    sessionId: privateAlice.session,
    projectId: ProjectId.make(`project-${name}`),
    worktreeId: privateAlice.worktree,
    name,
    path: `/workspace/repos/${name}`,
    branch: "mend/private-alice",
    baseSha: Sha.make("0123456789abcdef"),
    baseRef: "main",
    state: facts.state ?? "ready",
    error: null,
    capture: facts.capture ?? "nested",
    source: "origin",
    addedByUserId: "alice",
    createdAt: NOW,
    updatedAt: NOW,
    readyAt: NOW,
  });

let held: Array<SessionRepository> = [];
let removed: Array<string> = [];

describe("DELETE /worktrees/:id with repositories added by its sessions", () => {
  let api: TenancyApi;

  beforeEach(async () => {
    held = [];
    removed = [];
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: { launchUnderWay: () => false, captureHolds: () => Effect.succeed([]) },
          forwards: { listOpen: () => Effect.succeed([]) },
          // The main change holds nothing past its base: only the repositories can refuse.
          reads: {
            changedFiles: () => Effect.succeed({ value: [], stamp: WORKTREE_STAMP }),
          },
          sessionRepositories: {
            listForWorktree: () => Effect.succeed([]),
            listForSession: (sessionId: SessionId) =>
              Effect.succeed(held.filter((row) => row.sessionId === sessionId)),
          },
          store: {
            removeWorktreeForce: (_storePath, name) =>
              Effect.sync(() => {
                removed.push(name);
                return { leftover: null };
              }),
          },
        },
      },
    );
  });

  afterEach(async () => {
    await api.dispose();
  });

  const remove = (force = false) =>
    api.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}${force ? "?force=true" : ""}`,
    );

  it("refuses while a session here holds a repository nested inside the worktree, and offers the override", async () => {
    held = [repository("core"), repository("sealantd", { state: "failed" })];
    api.world.nestedRepositories.set(privateAlice.worktree, held.map(nestedOf));
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      _tag: "RemovalRefused",
      scope: "worktree",
      forceWouldLift: true,
      blockers: [
        {
          _tag: "NestedRepositories",
          worktreeId: privateAlice.worktree,
          worktreeName: "private-alice",
          repositories: [
            { path: "/workspace/repos/core", branch: "mend/private-alice" },
            { path: "/workspace/repos/sealantd", branch: "mend/private-alice" },
          ],
        },
      ],
      message:
        "This worktree holds 2 repositories added with mend repo add, saved only with it · /workspace/repos/core on mend/private-alice, /workspace/repos/sealantd on mend/private-alice · Mend cannot see whether they hold commits or edits that are not on origin, and removal deletes them. Push what you need from a session in this worktree before removal, or pass force=true to remove it anyway.",
    });
    expect(removed).toEqual([]);
    expect(api.world.worktrees.has(privateAlice.worktree)).toBe(true);
  });

  it("names the repositories after the main change's own refusal", async () => {
    held = [repository("core")];
    const unlanded = await createTenancyApi(
      {},
      {
        implement: {
          engine: { launchUnderWay: () => false, captureHolds: () => Effect.succeed([]) },
          forwards: { listOpen: () => Effect.succeed([]) },
          reads: {
            changedFiles: () =>
              Effect.succeed({
                value: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
                stamp: WORKTREE_STAMP,
              }),
          },
          landings: { listForChange: () => Effect.succeed([]) },
          sessionRepositories: {
            listForWorktree: () => Effect.succeed([]),
            listForSession: (sessionId: SessionId) =>
              Effect.succeed(held.filter((row) => row.sessionId === sessionId)),
          },
        },
      },
    );
    try {
      unlanded.world.nestedRepositories.set(privateAlice.worktree, held.map(nestedOf));
      const response = await unlanded.request(
        "alice",
        "DELETE",
        `/api/worktrees/${privateAlice.worktree}`,
      );
      expect(response.status).toBe(409);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        _tag: "RemovalRefused",
        forceWouldLift: true,
        blockers: [
          {
            _tag: "Unlanded",
            owner: { userId: "alice", name: "Alice" },
            standing: {
              _tag: "never-landed",
              files: [{ path: "src/a.ts", additions: 2, deletions: 1 }],
            },
          },
          { _tag: "NestedRepositories" },
        ],
        message:
          "This worktree holds a change that was never landed · 1 file · +2 −1 · src/a.ts +2 −1. Land it or discard it before removal, or pass force=true to remove it anyway. This worktree holds 1 repository added with mend repo add, saved only with it · /workspace/repos/core on mend/private-alice · Mend cannot see whether it holds commits or edits that are not on origin, and removal deletes it. Push what you need from a session in this worktree before removal, or pass force=true to remove it anyway.",
      });
    } finally {
      await unlanded.dispose();
    }
  });

  it("removes the worktree with force=true", async () => {
    held = [repository("core")];
    const response = await remove(true);
    expect(response.status).toBe(200);
    expect(removed).toEqual(["private-alice"]);
    expect(api.world.worktrees.has(privateAlice.worktree)).toBe(false);
  });
});

describe("DELETE /worktrees/:id with repositories saved elsewhere", () => {
  let api: TenancyApi;

  beforeEach(async () => {
    api = await createTenancyApi(
      {},
      {
        implement: {
          engine: { launchUnderWay: () => false, captureHolds: () => Effect.succeed([]) },
          forwards: { listOpen: () => Effect.succeed([]) },
          reads: {
            changedFiles: () => Effect.succeed({ value: [], stamp: WORKTREE_STAMP }),
          },
          sessionRepositories: {
            listForWorktree: () => Effect.succeed([]),
            // Saved under its own captures: it does not go with this worktree.
            listForSession: () => Effect.succeed([repository("core", { capture: "own" })]),
          },
          store: {
            removeWorktreeForce: () => Effect.succeed({ leftover: null }),
          },
        },
      },
    );
  });

  afterEach(async () => {
    await api.dispose();
  });

  it("removes a worktree whose repositories are saved under their own captures", async () => {
    const response = await api.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(200);
  });
});
