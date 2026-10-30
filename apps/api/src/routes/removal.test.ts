import { ProjectRemovalFenceId, SessionRepositoryId, Sha, WorktreeId } from "@mend/domain";
import {
  Project,
  Session,
  SessionProcess,
  SessionRepository,
  Worktree,
} from "@mend/domain/workbench";
import { type CaptureHold, WORKTREE_STAMP } from "@mend/sessions";
import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_SESSION_IN_SHARED_A,
  CAROL_SHELL_IN_SHARED_A,
  CAROL_WORKTREE_IN_SHARED_A,
  ids,
} from "../../test/support/tenancy-harness.ts";

/**
 * Removing a worktree or a project (docs/adr/0007-landing.md, "Worktree removal"; decisions Q1-Q4
 * of 2026-10-25), as a client of the HTTP API observes it: every blocker in one 409, only the
 * change's owner removes a worktree, force lifts only work that is not on origin, a project has no
 * force and nothing is ever stopped for the caller.
 */

const privateAlice = ids("private-alice");
const sharedA = ids("shared-a");
const NOW = new Date("2026-10-30T09:00:00.000Z");

const file = (path: string, additions: number, deletions: number) => ({
  path,
  additions,
  deletions,
});

interface Scene {
  /** Files past the base, per worktree; none unless named. */
  readonly changed?: ReadonlyMap<string, ReadonlyArray<ReturnType<typeof file>>>;
  readonly holds?: ReadonlyMap<string, ReadonlyArray<CaptureHold>>;
  readonly sessions?: ReadonlyArray<Session>;
  readonly processes?: ReadonlyArray<SessionProcess>;
  readonly projectsWithoutOrigin?: ReadonlyArray<string>;
  readonly resources?: ReadonlyArray<string>;
  readonly repositories?: ReadonlyArray<SessionRepository>;
  /** Waits before the first read of a worktree's change, for races. */
  readonly beforeRead?: Effect.Effect<void>;
}

let api: TenancyApi | undefined;
let removedWorktrees: Array<string> = [];
let removedStores: Array<string> = [];
let reads = 0;

const world = async (scene: Scene = {}) => {
  removedWorktrees = [];
  removedStores = [];
  reads = 0;
  api = await createTenancyApi(
    {},
    {
      ...(scene.sessions === undefined ? {} : { sessions: scene.sessions }),
      ...(scene.processes === undefined ? {} : { processes: scene.processes }),
      implement: {
        engine: {
          launchUnderWay: () => false,
          captureHolds: (worktreeId) => Effect.succeed(scene.holds?.get(worktreeId) ?? []),
          provisionSessionIn: () =>
            Effect.suspend(() => {
              const session = api?.world.sessions.get(privateAlice.session);
              return session === undefined ? Effect.die("no session") : Effect.succeed(session);
            }),
        },
        forwards: { listOpen: () => Effect.succeed([]) },
        reads: {
          changedFiles: (_projectId, worktreeId) =>
            Effect.gen(function* () {
              reads += 1;
              if (scene.beforeRead !== undefined) yield* scene.beforeRead;
              return { value: scene.changed?.get(worktreeId) ?? [], stamp: WORKTREE_STAMP };
            }),
        },
        landings: { listForChange: () => Effect.succeed([]) },
        sessionRepositories: {
          listForWorktree: (worktreeId) =>
            Effect.succeed(
              (scene.repositories ?? []).filter((row) => row.worktreeId === worktreeId),
            ),
          listForSession: () => Effect.succeed([]),
          listForProject: (projectId) =>
            Effect.succeed((scene.repositories ?? []).filter((row) => row.projectId === projectId)),
        },
        resources: {
          fenceProjectRemoval: (projectId) =>
            (scene.resources ?? []).length === 0
              ? Effect.succeed(ProjectRemovalFenceId.make(`rfen_${projectId}`))
              : Effect.die("resources are declared"),
          liftProjectRemovalFence: () => Effect.void,
        },
        hotWorkspaces: { listForProject: () => Effect.succeed([]) },
        projects: {
          byId: (id) =>
            Effect.suspend(() => {
              const project = api?.world.projects.get(id);
              if (project === undefined) return Effect.die(`no project ${id}`);
              return Effect.succeed(
                scene.projectsWithoutOrigin?.includes(id) === true
                  ? new Project({ ...project, originUrl: null })
                  : project,
              );
            }),
          remove: (id) =>
            Effect.sync(() => {
              removedStores.push(`row:${id}`);
            }),
        },
        store: {
          removeWorktreeForce: (_storePath, directory) =>
            Effect.sync(() => {
              removedWorktrees.push(directory);
              return { leftover: null };
            }),
          removeProjectStore: (storePath) =>
            Effect.sync(() => {
              removedStores.push(storePath);
              return { leftover: null };
            }),
        },
      },
    },
  );
  return api;
};

afterEach(async () => {
  await api?.dispose();
  api = undefined;
});

const live = (session: Session | undefined, status: Session["status"] = "running") => {
  if (session === undefined) throw new Error("missing session fixture");
  return new Session({ ...session, status });
};

const bodyOf = async (response: Response): Promise<unknown> => response.json();

/** A fresh world's own fixture, before the world it is used in exists. */
const fixture = async <A>(read: (world: TenancyApi["world"]) => A): Promise<A> => {
  const scratch = await createTenancyApi();
  try {
    return read(scratch.world);
  } finally {
    await scratch.dispose();
  }
};

describe("DELETE /worktrees/:id", () => {
  it("removes a worktree at its base, with only ended sessions, for its change's owner", async () => {
    const instance = await world();
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ removed: true, leftover: null });
    expect(removedWorktrees).toEqual(["private-alice"]);
    expect(instance.world.worktrees.has(privateAlice.worktree)).toBe(false);
  });

  it("refuses while a session is live, with or without force, and stops nothing", async () => {
    const session = await fixture((w) => w.sessions.get(privateAlice.session));
    const instance = await world({ sessions: [live(session)] });
    for (const query of ["", "?force=true"]) {
      const response = await instance.request(
        "alice",
        "DELETE",
        `/api/worktrees/${privateAlice.worktree}${query}`,
      );
      expect(response.status).toBe(409);
      expect(await bodyOf(response)).toMatchObject({
        _tag: "RemovalRefused",
        scope: "worktree",
        forceWouldLift: false,
        blockers: [
          {
            _tag: "SessionLive",
            sessionId: privateAlice.session,
            owner: { userId: "alice", name: "Alice" },
            activity: "live",
          },
        ],
      });
    }
    expect(removedWorktrees).toEqual([]);
    expect(instance.world.calls.filter((call) => call.startsWith("engine.stop"))).toEqual([]);
    expect(instance.removalMarks.size).toBe(0);
  });

  it("refuses while a capture is saving, and force does not lift it", async () => {
    const instance = await world({
      holds: new Map([
        [privateAlice.worktree, [{ sessionId: privateAlice.session, kind: "saving" }]],
      ]),
    });
    for (const query of ["", "?force=true"]) {
      const response = await instance.request(
        "alice",
        "DELETE",
        `/api/worktrees/${privateAlice.worktree}${query}`,
      );
      expect(response.status).toBe(409);
      expect(await bodyOf(response)).toMatchObject({
        forceWouldLift: false,
        blockers: [{ _tag: "Saving", holds: [{ kind: "saving", via: "own" }] }],
      });
    }
    expect(removedWorktrees).toEqual([]);
  });

  it("refuses a change that was never landed, offers force, and the owner's force removes it", async () => {
    const instance = await world({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 10, 2)]]]),
    });
    const refused = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toMatchObject({
      forceWouldLift: true,
      blockers: [
        {
          _tag: "Unlanded",
          owner: { userId: "alice", name: "Alice" },
          standing: { _tag: "never-landed", files: [file("src/a.ts", 10, 2)] },
        },
      ],
    });
    expect(removedWorktrees).toEqual([]);
    const forced = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}?force=true`,
    );
    expect(forced.status).toBe(200);
    expect(removedWorktrees).toEqual(["private-alice"]);
  });

  it("names work in a project with no origin as on no remote, and the owner's force still removes it (Q3)", async () => {
    const instance = await world({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
      projectsWithoutOrigin: [privateAlice.project],
    });
    const refused = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(await bodyOf(refused)).toMatchObject({
      forceWouldLift: true,
      blockers: [{ _tag: "Unlanded", standing: { _tag: "no-remote" } }],
    });
    const forced = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}?force=true`,
    );
    expect(forced.status).toBe(200);
  });

  it("lists every blocker at once, and under force only the ones force does not lift", async () => {
    const session = await fixture((w) => w.sessions.get(privateAlice.session));
    const instance = await world({
      sessions: [live(session)],
      holds: new Map([[privateAlice.worktree, [{ sessionId: null, kind: "executor" }]]]),
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
    });
    const tags = async (query: string) => {
      const response = await instance.request(
        "alice",
        "DELETE",
        `/api/worktrees/${privateAlice.worktree}${query}`,
      );
      const body = await bodyOf(response);
      return typeof body === "object" &&
        body !== null &&
        "blockers" in body &&
        Array.isArray(body.blockers)
        ? body.blockers.map((blocker: { readonly _tag: string }) => blocker._tag)
        : body;
    };
    expect(await tags("")).toEqual(["SessionLive", "Saving", "Unlanded"]);
    expect(await tags("?force=true")).toEqual(["SessionLive", "Saving"]);
  });

  it("refuses the project's organization owner a teammate's worktree, naming whose change it is (Q4, Q7)", async () => {
    const instance = await world();
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${CAROL_WORKTREE_IN_SHARED_A}?force=true`,
    );
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toEqual({
      _tag: "RemovalForbidden",
      owner: { userId: "carol", name: "Carol" },
      message: "not removed · only Carol, who started this worktree's change, removes it.",
    });
    expect(instance.world.worktrees.has(CAROL_WORKTREE_IN_SHARED_A)).toBe(true);
  });

  it("keeps the change's owner after its first session is gone: the owner removes it, nobody else", async () => {
    const instance = await world();
    const sharedWorktree = instance.world.worktrees.get(sharedA.worktree);
    if (sharedWorktree === undefined) throw new Error("missing worktree fixture");
    const orphan = WorktreeId.make("worktree-shared-a-orphan");
    instance.world.addWorktree(
      new Worktree({
        ...sharedWorktree,
        id: orphan,
        name: "orphan",
        directory: "orphan",
        changeOwnerUserId: "carol",
      }),
    );
    const byManager = await instance.request("alice", "DELETE", `/api/worktrees/${orphan}`);
    expect(byManager.status).toBe(403);
    const byOwner = await instance.request("carol", "DELETE", `/api/worktrees/${orphan}`);
    expect(byOwner.status).toBe(200);
    expect(removedWorktrees).toEqual(["orphan"]);
  });

  it("keeps today's rule for a worktree with no provable owner: whoever manages the project", async () => {
    const instance = await world();
    const sharedWorktree = instance.world.worktrees.get(sharedA.worktree);
    if (sharedWorktree === undefined) throw new Error("missing worktree fixture");
    const ownerless = WorktreeId.make("worktree-shared-a-ownerless");
    instance.world.addWorktree(
      new Worktree({ ...sharedWorktree, id: ownerless, name: "ownerless", directory: "ownerless" }),
    );
    const response = await instance.request("alice", "DELETE", `/api/worktrees/${ownerless}`);
    expect(response.status).toBe(200);
  });

  it("refuses while a session of another worktree holding this one as a repository is live", async () => {
    const carolSession = await fixture((w) => w.sessions.get(CAROL_SESSION_IN_SHARED_A));
    const holder = new SessionRepository({
      id: SessionRepositoryId.make("repository-holder"),
      sessionId: CAROL_SESSION_IN_SHARED_A,
      projectId: sharedA.project,
      worktreeId: sharedA.worktree,
      name: "shared-a",
      path: "/workspace/repos/shared-a",
      branch: "mend/shared-a",
      baseSha: Sha.make("0123456789abcdef"),
      baseRef: "main",
      state: "ready",
      error: null,
      capture: "own",
      source: "origin",
      addedByUserId: "carol",
      createdAt: NOW,
      updatedAt: NOW,
      readyAt: NOW,
    });
    const instance = await world({ sessions: [live(carolSession)], repositories: [holder] });
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${sharedA.worktree}`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      blockers: [
        {
          _tag: "SessionLive",
          sessionId: CAROL_SESSION_IN_SHARED_A,
          role: "holder",
          owner: { userId: "carol", name: "Carol" },
        },
      ],
    });
  });
});

describe("a worktree removal against a session start, a second removal and a crash", () => {
  it("refuses a session start while the removal reads, and admits it once the removal is refused", async () => {
    const reading = Effect.runSync(Deferred.make<void>());
    const proceed = Effect.runSync(Deferred.make<void>());
    const session = await fixture((w) => w.sessions.get(privateAlice.session));
    const instance = await world({
      sessions: [live(session, "idle")],
      beforeRead: Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(proceed)),
      ),
    });
    const removal = instance.request("alice", "DELETE", `/api/worktrees/${privateAlice.worktree}`);
    await Effect.runPromise(Deferred.await(reading));
    const during = await instance.request(
      "alice",
      "POST",
      `/api/worktrees/${privateAlice.worktree}/sessions`,
      { harness: "shell" },
    );
    expect(during.status).toBe(409);
    expect(await bodyOf(during)).toMatchObject({ _tag: "RemovalInProgress" });
    const second = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(await bodyOf(second)).toMatchObject({
      _tag: "RemovalRefused",
      blockers: [{ _tag: "RemovalUnderway" }],
    });
    await Effect.runPromise(Deferred.succeed(proceed, undefined));
    expect((await removal).status).toBe(409);
    const after = await instance.request(
      "alice",
      "POST",
      `/api/worktrees/${privateAlice.worktree}/sessions`,
      { harness: "shell" },
    );
    expect(after.status).toBe(200);
  });

  it("finishes a removal that passed its checks and stopped while deleting, without checking again", async () => {
    const instance = await world({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
    });
    instance.removalMarks.set(`worktree:${privateAlice.worktree}`, {
      phase: "deleting",
      since: new Date(0),
      id: "rmv_crashed",
    });
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(200);
    expect(reads).toBe(0);
    expect(removedWorktrees).toEqual(["private-alice"]);
  });

  it("takes over a check whose checker went quiet, and decides afresh", async () => {
    const instance = await world({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
    });
    instance.removalMarks.set(`worktree:${privateAlice.worktree}`, {
      phase: "checking",
      since: new Date(0),
      id: "rmv_quiet",
    });
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(await bodyOf(response)).toMatchObject({ blockers: [{ _tag: "Unlanded" }] });
    expect(instance.removalMarks.size).toBe(0);
  });
});

describe("DELETE /projects/:id", () => {
  it("removes a project whose every worktree is at its base and idle", async () => {
    const instance = await world();
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${privateAlice.project}`,
    );
    expect(response.status).toBe(200);
    expect(removedStores).toEqual([
      instance.world.projects.get(privateAlice.project)?.storePath,
      `row:${privateAlice.project}`,
    ]);
  });

  it("refuses for a teammate's running process, names them, and stops nothing (Q1, Q2)", async () => {
    const instance = await world();
    const response = await instance.request("alice", "DELETE", `/api/projects/${sharedA.project}`);
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      _tag: "RemovalRefused",
      scope: "project",
      forceWouldLift: false,
      blockers: [
        {
          _tag: "SessionLive",
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
          sessionId: CAROL_SESSION_IN_SHARED_A,
          owner: { userId: "carol", name: "Carol" },
          activity: "process-running",
        },
      ],
      message:
        "not removed · Carol's session in carol has a process running · stop, land or remove those first, then remove the project again.",
    });
    expect(removedStores).toEqual([]);
    expect(
      instance.world.calls.filter(
        (call) => call.startsWith("engine.stop") || call.includes("stopService"),
      ),
    ).toEqual([]);
    expect(instance.removalMarks.size).toBe(0);
  });

  it("refuses for a teammate's change that is not on origin, naming the worktree and its owner (Q2)", async () => {
    const shell = await fixture((w) => w.processes.get(CAROL_SHELL_IN_SHARED_A));
    if (shell === undefined) throw new Error("missing shell fixture");
    const instance = await world({
      processes: [new SessionProcess({ ...shell, status: "stopped", exitCode: 0, exitedAt: NOW })],
      changed: new Map([[CAROL_WORKTREE_IN_SHARED_A, [file("notes.md", 3, 0)]]]),
    });
    const response = await instance.request("alice", "DELETE", `/api/projects/${sharedA.project}`);
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      blockers: [
        {
          _tag: "Unlanded",
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
          owner: { userId: "carol", name: "Carol" },
          standing: { _tag: "never-landed", files: [file("notes.md", 3, 0)] },
        },
      ],
    });
    expect(removedStores).toEqual([]);
  });

  it("refuses work on no remote in a project with no origin, and a force query changes nothing", async () => {
    const instance = await world({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
      projectsWithoutOrigin: [privateAlice.project],
    });
    for (const query of ["", "?force=true"]) {
      const response = await instance.request(
        "alice",
        "DELETE",
        `/api/projects/${privateAlice.project}${query}`,
      );
      expect(response.status).toBe(409);
      expect(await bodyOf(response)).toMatchObject({
        forceWouldLift: false,
        blockers: [
          {
            _tag: "Unlanded",
            worktreeName: "private-alice",
            owner: { userId: "alice", name: "Alice" },
            standing: { _tag: "no-remote" },
          },
        ],
      });
    }
    expect(removedStores).toEqual([]);
  });

  it("leaves a refused project open: a session starts in it right after", async () => {
    const instance = await world({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
    });
    const refused = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${privateAlice.project}`,
    );
    expect(refused.status).toBe(409);
    const started = await instance.request(
      "alice",
      "POST",
      `/api/worktrees/${privateAlice.worktree}/sessions`,
      { harness: "shell" },
    );
    expect(started.status).toBe(200);
  });

  it("refuses for a live session of another project holding one of its worktrees", async () => {
    const carolSession = await fixture((w) => w.sessions.get(CAROL_SESSION_IN_SHARED_A));
    const holder = new SessionRepository({
      id: SessionRepositoryId.make("repository-foreign"),
      sessionId: CAROL_SESSION_IN_SHARED_A,
      projectId: privateAlice.project,
      worktreeId: privateAlice.worktree,
      name: "private-alice",
      path: "/workspace/repos/private-alice",
      branch: "mend/private-alice",
      baseSha: Sha.make("0123456789abcdef"),
      baseRef: "main",
      state: "ready",
      error: null,
      capture: "own",
      source: "origin",
      addedByUserId: "carol",
      createdAt: NOW,
      updatedAt: NOW,
      readyAt: NOW,
    });
    const instance = await world({ sessions: [live(carolSession)], repositories: [holder] });
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${privateAlice.project}`,
    );
    expect(await bodyOf(response)).toMatchObject({
      blockers: [
        { _tag: "SessionLive", role: "holder" },
        { _tag: "HeldByOtherProject", path: "/workspace/repos/private-alice", activity: "live" },
      ],
    });
  });
});
