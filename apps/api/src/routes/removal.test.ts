import { SessionRepositoryId, Sha, WorktreeId } from "@mend/domain";
import {
  Project,
  Session,
  SessionProcess,
  SessionRepository,
  Worktree,
} from "@mend/domain/workbench";
import { type CaptureHold, WORKTREE_STAMP, WorktreeNotCapturedError } from "@mend/sessions";
import { GitError } from "@mend/store";
import { Deferred, Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { postgres, removalDatabase } from "../../test/support/removal-postgres.ts";
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
  /** Runs as a removal takes its mark: for races with what the route read before. */
  readonly beforeTake?: Effect.Effect<void>;
  /** A worktree whose change cannot be read, with git's words. */
  readonly unreadable?: ReadonlyMap<string, string>;
  /** A worktree whose captured change cannot be restored, with the read's words. */
  readonly notCaptured?: ReadonlyMap<string, string>;
  /** Worktrees with a Service setup that has not ended. */
  readonly setupRunning?: ReadonlyArray<string>;
  /** Waits inside the store's removal of a worktree's files, for interruptions and takeovers. */
  readonly aroundWorktreeRemoval?: (call: number) => Effect.Effect<void>;
  /** Removal marks from Postgres (`removalDatabase`), in place of the in-memory ones. */
  readonly fences?: Awaited<ReturnType<typeof removalDatabase>>["fences"];
  readonly requestSignal?: AbortSignal;
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
      ...(scene.beforeTake === undefined ? {} : { beforeTake: scene.beforeTake }),
      ...(scene.requestSignal === undefined ? {} : { requestSignal: scene.requestSignal }),
      // The production stack's boundary: it answers a start a removal's mark refused.
      errorDetail: { mode: "redacted" },
      implement: {
        ...(scene.fences === undefined ? {} : { removalFences: scene.fences }),
        setupRuns: {
          unendedInWorktree: (worktreeId) =>
            Effect.succeed(scene.setupRunning?.includes(worktreeId) === true),
        },
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
              if (reads === 1 && scene.beforeRead !== undefined) yield* scene.beforeRead;
              const notCaptured = scene.notCaptured?.get(worktreeId);
              if (notCaptured !== undefined) {
                return yield* new WorktreeNotCapturedError({ worktreeId, message: notCaptured });
              }
              const unreadable = scene.unreadable?.get(worktreeId);
              if (unreadable !== undefined) {
                return yield* new GitError({
                  args: ["diff"],
                  cwd: "/store",
                  exitCode: 128,
                  stderr: unreadable,
                });
              }
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
        resources: { declaredNames: () => Effect.succeed(scene.resources ?? []) },
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
            Effect.gen(function* () {
              removedWorktrees.push(directory);
              yield* scene.aroundWorktreeRemoval?.(removedWorktrees.length) ?? Effect.void;
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

describe("what a worktree removal reads under its mark", () => {
  it("decides who may remove it from the owner recorded once the mark is taken", async () => {
    let instance: TenancyApi | undefined;
    const ownerless = WorktreeId.make("worktree-shared-a-ownerless");
    // Carol's first session records her as the owner after the route read the worktree.
    const carolStarts = Effect.sync(() => {
      const row = instance?.world.worktrees.get(ownerless);
      if (row === undefined || row.changeOwnerUserId !== null) return;
      instance?.world.addWorktree(
        new Worktree({ ...row, changeOwnerUserId: "carol", changeOwnerProven: true }),
      );
    });
    instance = await world({ beforeTake: carolStarts });
    const sharedWorktree = instance.world.worktrees.get(sharedA.worktree);
    if (sharedWorktree === undefined) throw new Error("missing worktree fixture");
    instance.world.addWorktree(
      new Worktree({
        ...sharedWorktree,
        id: ownerless,
        name: "ownerless",
        directory: "ownerless",
        changeOwnerUserId: null,
        changeOwnerProven: false,
      }),
    );
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${ownerless}?force=true`,
    );
    expect(response.status).toBe(403);
    expect(await bodyOf(response)).toMatchObject({
      _tag: "RemovalForbidden",
      owner: { userId: "carol" },
    });
    expect(removedWorktrees).toEqual([]);
    expect(instance.removalMarks.size).toBe(0);
  });

  it("lets whoever manages the project remove a worktree whose owner the history cannot prove", async () => {
    const instance = await world();
    const sharedWorktree = instance.world.worktrees.get(sharedA.worktree);
    if (sharedWorktree === undefined) throw new Error("missing worktree fixture");
    const unproven = WorktreeId.make("worktree-shared-a-unproven");
    instance.world.addWorktree(
      new Worktree({
        ...sharedWorktree,
        id: unproven,
        name: "unproven",
        directory: "unproven",
        changeOwnerUserId: "carol",
        changeOwnerProven: false,
      }),
    );
    const response = await instance.request("alice", "DELETE", `/api/worktrees/${unproven}`);
    expect(response.status).toBe(200);
    expect(removedWorktrees).toEqual(["unproven"]);
  });

  it("answers a change it could not read with every other blocker, in one 409", async () => {
    const session = await fixture((w) => w.sessions.get(privateAlice.session));
    const instance = await world({
      sessions: [live(session)],
      unreadable: new Map([[privateAlice.worktree, "fatal: bad object HEAD"]]),
    });
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      _tag: "RemovalRefused",
      forceWouldLift: false,
      blockers: [
        { _tag: "SessionLive" },
        { _tag: "Unlanded", standing: { _tag: "unread", reason: "fatal: bad object HEAD" } },
      ],
    });
  });

  it("answers a captured change it could not restore with the read's words, in one 409", async () => {
    const instance = await world({
      notCaptured: new Map([
        [
          privateAlice.worktree,
          "the change's Git evidence is unavailable · its capture manifest is invalid",
        ],
      ]),
    });
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      blockers: [
        {
          _tag: "Unlanded",
          standing: {
            _tag: "unread",
            reason: "the change's Git evidence is unavailable · its capture manifest is invalid",
          },
        },
      ],
    });
  });

  it("refuses, with or without force, while a Service setup has not ended", async () => {
    const instance = await world({ setupRunning: [privateAlice.worktree] });
    for (const query of ["", "?force=true"]) {
      const response = await instance.request(
        "alice",
        "DELETE",
        `/api/worktrees/${privateAlice.worktree}${query}`,
      );
      expect(response.status).toBe(409);
      expect(await bodyOf(response)).toMatchObject({
        forceWouldLift: false,
        blockers: [{ _tag: "SetupRunning", worktreeId: privateAlice.worktree }],
      });
    }
    expect(removedWorktrees).toEqual([]);
  });

  it("keeps a nested repository a blocker after the last session in the worktree is gone", async () => {
    const instance = await world();
    instance.world.nestedRepositories.set(privateAlice.worktree, [
      { path: "repos/library", branch: "mend/library" },
    ]);
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      forceWouldLift: true,
      blockers: [
        {
          _tag: "NestedRepositories",
          repositories: [{ path: "repos/library", branch: "mend/library" }],
        },
      ],
    });
    expect(removedWorktrees).toEqual([]);
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
      blockers: [{ _tag: "RemovalUnderway" }, { _tag: "SessionLive", activity: "live" }],
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

  it("finishes a deletion even when the request goes away while it deletes", async () => {
    const atStore = Effect.runSync(Deferred.make<void>());
    const resume = Effect.runSync(Deferred.make<void>());
    const controller = new AbortController();
    const instance = await world({
      requestSignal: controller.signal,
      aroundWorktreeRemoval: () =>
        Deferred.succeed(atStore, undefined).pipe(Effect.andThen(Deferred.await(resume))),
    });
    const removal = instance
      .request("alice", "DELETE", `/api/worktrees/${privateAlice.worktree}`)
      .catch(() => null);
    await Effect.runPromise(Deferred.await(atStore));
    controller.abort();
    await Effect.runPromise(Deferred.succeed(resume, undefined));
    await removal;
    await Effect.runPromise(
      Effect.gen(function* () {
        while (instance.world.worktrees.has(privateAlice.worktree))
          yield* Effect.sleep("10 millis");
      }).pipe(Effect.timeout("5 seconds")),
    );
    expect(removedWorktrees).toEqual(["private-alice"]);
    expect(instance.world.calls.filter((call) => call === "worktrees.remove")).toHaveLength(1);
  });
});

describe.skipIf(postgres.skip)("a removal against Postgres's marks", () => {
  let database: Awaited<ReturnType<typeof removalDatabase>> | undefined;
  afterEach(async () => {
    await database?.drop();
    database = undefined;
  });

  /** A world, its rows in Postgres, and the marks Postgres keeps; `scene` as `world` takes it. */
  const marked = async (scene: Omit<Scene, "fences"> = {}) => {
    const rows = await fixture((w) => ({
      projects: new Map(w.projects),
      worktrees: new Map(w.worktrees),
      sessions: new Map(
        [...w.sessions].map(([id, session]) => [
          id,
          scene.sessions?.find((replaced) => replaced.id === id) ?? session,
        ]),
      ),
    }));
    database = await removalDatabase(rows);
    return world({ ...scene, fences: database.fences });
  };

  const setMark = (table: "worktrees" | "projects", id: string, phase: string, age: string) =>
    database?.sql(
      (sql) => sql`
        UPDATE ${sql(table)}
        SET removal_phase = ${phase}, removal_id = 'rmv_earlier',
            removal_since = now() - ${age}::interval
        WHERE id = ${id}`,
    );

  it("finishes a removal that passed its checks and stopped while deleting, without checking again", async () => {
    const instance = await marked({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
    });
    await setMark("worktrees", privateAlice.worktree, "deleting", "10 minutes");
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(200);
    expect(reads).toBe(0);
    expect(removedWorktrees).toEqual(["private-alice"]);
  }, 60_000);

  it("takes over a check whose checker went quiet, decides afresh, and gives the mark back", async () => {
    const instance = await marked({
      changed: new Map([[privateAlice.worktree, [file("src/a.ts", 1, 0)]]]),
    });
    await setMark("worktrees", privateAlice.worktree, "checking", "10 minutes");
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(await bodyOf(response)).toMatchObject({ blockers: [{ _tag: "Unlanded" }] });
    const left = await database?.sql(
      (sql) =>
        sql`SELECT removal_phase AS phase FROM worktrees WHERE id = ${privateAlice.worktree}`,
    );
    expect(left).toEqual([{ phase: null }]);
  }, 60_000);

  it("stops before its next step once another removal took its stopped deletion over", async () => {
    const atStore = Effect.runSync(Deferred.make<void>());
    const resume = Effect.runSync(Deferred.make<void>());
    const instance = await marked({
      aroundWorktreeRemoval: (call) =>
        call === 1
          ? Deferred.succeed(atStore, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void,
    });
    const first = instance.request("alice", "DELETE", `/api/worktrees/${privateAlice.worktree}`);
    await Effect.runPromise(Deferred.await(atStore));
    // The first deletion went quiet past the lease, as a paused process does.
    await database?.sql(
      (sql) => sql`
        UPDATE worktrees SET removal_since = now() - interval '10 minutes'
        WHERE id = ${privateAlice.worktree}`,
    );
    const second = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(second.status).toBe(200);
    await Effect.runPromise(Deferred.succeed(resume, undefined));
    const answered = await first;
    expect(answered.status).toBe(409);
    expect(await bodyOf(answered)).toMatchObject({ blockers: [{ _tag: "RemovalUnderway" }] });
    expect(instance.world.calls.filter((call) => call === "worktrees.remove")).toHaveLength(1);
  }, 60_000);

  it("refuses a worktree whose project's deletion stopped partway, saying how to finish it", async () => {
    const instance = await marked();
    await setMark("projects", privateAlice.project, "deleting", "10 minutes");
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      blockers: [{ _tag: "RemovalUnderway", stopped: { kind: "project", name: "private-alice" } }],
      message: expect.stringContaining("remove that project again to finish it"),
    });
    expect(removedWorktrees).toEqual([]);
  }, 60_000);

  it("refuses a project while one of its worktrees' deletions stopped partway", async () => {
    const instance = await marked();
    await setMark("worktrees", privateAlice.worktree, "deleting", "10 minutes");
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/projects/${privateAlice.project}`,
    );
    expect(await bodyOf(response)).toMatchObject({
      blockers: [{ _tag: "RemovalUnderway", stopped: { kind: "worktree", name: "private-alice" } }],
    });
    expect(removedStores).toEqual([]);
  }, 60_000);

  it("counts a launch admitted before the removal as a session starting", async () => {
    const session = await fixture((w) => w.sessions.get(privateAlice.session));
    const instance = await marked({ sessions: [live(session, "completed")] });
    await database?.sql(
      (sql) => sql`
        INSERT INTO session_admissions (id, session_id) VALUES ('adm-1', ${privateAlice.session})`,
    );
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}?force=true`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      blockers: [{ _tag: "SessionLive", sessionId: privateAlice.session, activity: "starting" }],
    });
    expect(removedWorktrees).toEqual([]);
  }, 60_000);

  it("counts a live session of a project that links the worktree, by name", async () => {
    const instance = await marked();
    await database?.sql(
      (sql) => sql`
        INSERT INTO project_links (id, project_id, linked_project_id, name, worktree_name)
        VALUES ('link-1', ${sharedA.project}, ${privateAlice.project}, 'alice', 'private-alice')`,
    );
    const response = await instance.request(
      "alice",
      "DELETE",
      `/api/worktrees/${privateAlice.worktree}?force=true`,
    );
    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toMatchObject({
      blockers: [
        {
          _tag: "SessionLive",
          sessionId: CAROL_SESSION_IN_SHARED_A,
          role: "linked",
          activity: "process-running",
        },
      ],
    });
  }, 60_000);
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
    const body = await bodyOf(response);
    expect(body).toMatchObject({
      blockers: [
        {
          _tag: "SessionLive",
          sessionId: CAROL_SESSION_IN_SHARED_A,
          worktreeName: "private-alice",
          role: "holder",
          activity: "live",
        },
      ],
    });
    expect(body).toHaveProperty("blockers", [expect.anything()]);
  });
});
