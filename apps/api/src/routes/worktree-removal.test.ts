import { ProjectId, SessionRepositoryId, Sha, type SessionId } from "@mend/domain";
import { SessionRepository, worktreeRemovalRefusalOf } from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

/**
 * Removing a worktree whose sessions added repositories with `mend repo add`
 * (docs/adr/0011-repositories-in-a-session.md): their files live nested inside this worktree,
 * outside its change, and go with it. Removal refuses for them as it does for an unlanded change,
 * and `force=true` is the override.
 */

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

  beforeAll(async () => {
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

  afterAll(async () => {
    await api.dispose();
  });

  beforeEach(() => {
    held = [];
    removed = [];
  });

  const remove = (force = false) =>
    api.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}${force ? "?force=true" : ""}`,
    );

  it("refuses while a session here holds a repository nested inside the worktree, and offers the override", async () => {
    held = [repository("core"), repository("sealantd", { state: "failed" })];
    const response = await remove();
    expect(response.status).toBe(422);
    const body: unknown = await response.json();
    expect(body).toEqual({
      _tag: "StoreFailure",
      message:
        "This worktree holds 2 repositories added with mend repo add, saved only with it · /workspace/repos/core on mend/private-alice, /workspace/repos/sealantd on mend/private-alice · Mend cannot see whether they hold commits or edits that are not on origin, and removal deletes them. Push what you need from a session in this worktree before removal, or pass force=true to remove it anyway.",
    });
    const words =
      typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
    expect(worktreeRemovalRefusalOf(words).forceable).toBe(true);
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
      const response = await unlanded.request(
        "alice",
        "DELETE",
        `/api/worktrees/${privateAlice.worktree}`,
      );
      expect(response.status).toBe(422);
      const body: unknown = await response.json();
      const words =
        typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
      expect(words).toBe(
        "This worktree holds a change that was never landed · 1 file · +2 −1 · src/a.ts +2 −1. Land it or discard it before removal, or pass force=true to remove it anyway. This worktree holds 1 repository added with mend repo add, saved only with it · /workspace/repos/core on mend/private-alice · Mend cannot see whether it holds commits or edits that are not on origin, and removal deletes it. Push what you need from a session in this worktree before removal, or pass force=true to remove it anyway.",
      );
      // The client still reads the change's own facts out of the words.
      expect(worktreeRemovalRefusalOf(words).unlanded?.files).toBe(1);
    } finally {
      await unlanded.dispose();
    }
  });

  // Last: it deletes the world's row.
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

  beforeAll(async () => {
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

  afterAll(async () => {
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
