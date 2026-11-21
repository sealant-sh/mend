import { PgClient } from "@effect/sql-pg";
import {
  LaunchRequest,
  NewWorkbenchSession,
  NotFound,
  QueueSessionRequest,
} from "@mend/api-contracts";
import {
  InstanceRolesRepoLive,
  MendDBLive,
  OrganizationsRepoLive,
  ProjectsRepo,
  ProjectsRepoLive,
  QueuedSessionsRepo,
  QueuedSessionsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  OrganizationId,
  ProjectId,
  QueuedSessionId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import type { Session } from "@mend/domain/workbench";
import {
  Deferred,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Redacted,
  Schedule,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectAccessLive } from "./access.ts";
import { Adoptions, AdoptionsLive } from "./adoptions.ts";
import {
  CLONE_STOPPED_BY_RESTART,
  QueuedSessions,
  QueuedSessionsLive,
  START_STOPPED_BY_RESTART,
} from "./queued-sessions.ts";
import { type CreateSessionInput, SessionStart } from "./session-start.ts";

const postgres = postgresTestConfig();
const database = `mend_queued_sessions_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pg = PgClient.layer({
  url: Redacted.make(scratchUrl.toString()),
  transformResultNames: Str.snakeToCamel,
});
const repos = Layer.mergeAll(
  InstanceRolesRepoLive,
  OrganizationsRepoLive,
  ProjectsRepoLive,
  QueuedSessionsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pg))));
const reposRuntime = ManagedRuntime.make(repos);

const ORG = OrganizationId.make("org-northwind");
const ADA = { userId: "ada", credential: null };
const BOB = { userId: "bob", credential: null };

/** One start as `SessionStart` was asked for it: what reaches the engine. */
interface Started {
  readonly actorUserId: string;
  readonly projectId: ProjectId;
  readonly input: CreateSessionInput;
  readonly sessionId: SessionId;
  readonly launch: LaunchRequest | null;
}

/**
 * One API process: its adoptions, its queued sessions (swept as it builds), and a `SessionStart`
 * that records each start and writes the session row the engine would. Every launch it is handed
 * completes `launched`.
 */
const makeProcess = async (options: { readonly refuseCreate?: boolean } = {}) => {
  const started: Started[] = [];
  const launched = await reposRuntime.runPromise(Deferred.make<SessionId>());
  const sessionStart = Layer.effect(
    SessionStart,
    Effect.gen(function* () {
      const sessions = yield* SessionsRepo;
      const sql = yield* SqlClient.SqlClient;
      return {
        createInWorktreeAs: () => Effect.die("queued sessions never start in a worktree"),
        settleUnlaunched: () => Effect.void,
        createAs: (actor, projectId, input) =>
          Effect.gen(function* () {
            if (options.refuseCreate === true)
              return yield* Effect.fail(new NotFound({ id: projectId }));
            const id = SessionId.make(crypto.randomUUID());
            const worktreeId = WorktreeId.make(`wt-${id}`);
            yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
              VALUES (${worktreeId}, ${projectId}, ${id}, ${id}, ${`mend/${id}`}, 'abc')`.pipe(
              Effect.orDie,
            );
            const session: Session = yield* sessions.create({
              id,
              projectId,
              worktreeId,
              harness: input.harness,
              label: input.label,
              worktree: id,
              branch: `mend/${id}`,
              baseSha: Sha.make("abc"),
              baseRef: "main",
              contextSnapshotId: null,
              ownerUserId: actor.userId,
              origin: input.origin,
              autoLand: input.autoLand ?? null,
            });
            started.push({
              actorUserId: actor.userId,
              projectId,
              input,
              sessionId: id,
              launch: null,
            });
            return session;
          }),
        launchAs: (_userId, session, launch) =>
          Effect.gen(function* () {
            const at = started.findIndex((entry) => entry.sessionId === session.id);
            const entry = started[at];
            if (entry !== undefined) started[at] = { ...entry, launch };
            yield* Deferred.succeed(launched, session.id);
            return session;
          }),
        startAs: () => Effect.die("not used"),
      };
    }),
  );
  const layer = QueuedSessionsLive.pipe(
    Layer.provideMerge(Layer.fresh(AdoptionsLive)),
    Layer.provide(sessionStart),
    Layer.provide(ProjectAccessLive),
  );
  const runtime = ManagedRuntime.make(layer.pipe(Layer.provideMerge(repos)));
  await runtime.runPromise(Effect.void);
  return { runtime, started, launched };
};
type Process = Awaited<ReturnType<typeof makeProcess>>;

const onDatabase = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof repos>>) =>
  reposRuntime.runPromise(effect.pipe(Effect.orDie));

/** The project row an adoption writes once its clone is done. */
const recordProject = (id: ProjectId, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
        visibility, created_by_user_id)
      VALUES (${id}, ${name}, ${`/store/${id}`}, 'main', ${ORG}, 'private', 'ada')`.pipe(
      Effect.orDie,
    );
    return yield* (yield* ProjectsRepo).byId(id).pipe(Effect.orDie);
  });

/**
 * Ada's adoption of `name`, cloning until `finish` completes: true writes the project, false
 * fails the clone with Mend's sentence.
 */
const startAdoption = (process: Process, name: string) =>
  process.runtime.runPromise(
    Effect.gen(function* () {
      const finish = yield* Deferred.make<boolean>();
      const id = crypto.randomUUID();
      const projectId = ProjectId.make(`p-${id}`);
      yield* (yield* Adoptions)
        .run(
          {
            id,
            ownerUserId: "ada",
            name,
            source: `https://github.com/northwind/${name}`,
            projectId,
          },
          () =>
            Effect.gen(function* () {
              if (!(yield* Deferred.await(finish)))
                return yield* Effect.fail("Mend could not reach github.com.");
              return yield* recordProject(projectId, name);
            }),
          (failure) => ({ failure, gitSaid: null }),
        )
        .pipe(Effect.ignore, Effect.forkDetach);
      // Running once the server reads it, as the client that started it would.
      yield* (yield* Adoptions)
        .read("ada", id)
        .pipe(Effect.repeat({ until: (progress) => progress !== null }));
      return {
        id,
        projectId,
        end: (cloned: boolean) => process.runtime.runPromise(Deferred.succeed(finish, cloned)),
      };
    }),
  );

const request = (adoptionId: string, id = QueuedSessionId.make(crypto.randomUUID())) =>
  new QueueSessionRequest({
    id,
    adoptionId,
    session: new NewWorkbenchSession({
      harness: "claude",
      label: null,
      name: "lazy-order-history",
      base: null,
      autoLand: true,
    }),
    launch: new LaunchRequest({
      mode: "protocol",
      prompt: "Load the first 20 orders and fetch more as the list scrolls.",
      model: "opus",
      effort: "high",
    }),
  });

const call = <A, E>(
  process: Process,
  effect: (service: QueuedSessions["Service"]) => Effect.Effect<A, E>,
) => process.runtime.runPromise(Effect.flatMap(QueuedSessions, effect));

const failureOf = <A, E>(
  process: Process,
  effect: (service: QueuedSessions["Service"]) => Effect.Effect<A, E>,
) => process.runtime.runPromise(Effect.flip(Effect.flatMap(QueuedSessions, effect)));

/** Read until the session reaches `state`; the clone's end is handled on a fiber of its own. */
const readUntil = (process: Process, id: QueuedSessionId, state: string) =>
  call(process, (queued) =>
    queued.read(ADA, id).pipe(
      Effect.repeat({
        until: (view) => view.state === state,
        schedule: Schedule.spaced(Duration.millis(10)),
        times: 500,
      }),
    ),
  );

describe.skipIf(postgres.skip)("sessions started while their project clones, in Postgres", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
    await onDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        ))
          yield* migration;
        for (const user of ["ada", "bob"])
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
            VALUES (${user}, ${user}, ${`${user}@example.invalid`}, now())`;
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ORG}, 'Northwind')`;
        yield* sql`INSERT INTO organization_members (organization_id, user_id, role)
          VALUES (${ORG}, 'ada', 'member'), (${ORG}, 'bob', 'member')`;
      }),
    );
  });

  afterAll(async () => {
    await reposRuntime.dispose();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
  });

  it("starts the session once, as the person asked for it, when the clone finishes", async () => {
    const process = await makeProcess();
    const adoption = await startAdoption(process, "mobile-app");
    const asked = request(adoption.id);

    const waiting = await call(process, (queued) => queued.queue(ADA, asked));
    expect(waiting).toMatchObject({
      state: "waiting",
      projectName: "mobile-app",
      clone: { state: "running" },
      sessionId: null,
    });
    // Sent twice (a retry after a dropped answer), it is still one session.
    await call(process, (queued) => queued.queue(ADA, asked));
    // Only Ada reads it.
    expect(await failureOf(process, (queued) => queued.read(BOB, asked.id))).toBeInstanceOf(
      NotFound,
    );
    expect(process.started).toEqual([]);

    await adoption.end(true);
    const sessionId = await process.runtime.runPromise(Deferred.await(process.launched));
    expect(await readUntil(process, asked.id, "started")).toMatchObject({
      state: "started",
      sessionId,
      clone: null,
    });
    expect(process.started).toEqual([
      {
        actorUserId: "ada",
        projectId: adoption.projectId,
        input: {
          harness: "claude",
          label: null,
          name: "lazy-order-history",
          base: null,
          origin: "mend",
          autoLand: true,
        },
        sessionId,
        launch: asked.launch,
      },
    ]);
    // Started, it is a session: not in the list of ones still to start, and not to cancel.
    expect(await call(process, (queued) => queued.list(ADA))).toEqual([]);
    expect(await failureOf(process, (queued) => queued.cancel(ADA, asked.id))).toMatchObject({
      _tag: "QueuedSessionMovedOn",
      state: "started",
    });
    await process.runtime.dispose();
  });

  it("says why when the clone fails, and starts once the project is cloned", async () => {
    const process = await makeProcess();
    const adoption = await startAdoption(process, "checkout-api");
    const asked = request(adoption.id);
    await call(process, (queued) => queued.queue(ADA, asked));

    await adoption.end(false);
    expect(await readUntil(process, asked.id, "failed")).toMatchObject({
      failure: { step: "clone", message: "Mend could not reach github.com." },
    });
    expect(await call(process, (queued) => queued.list(ADA))).toMatchObject([
      { id: asked.id, state: "failed" },
    ]);
    expect(process.started).toEqual([]);

    // The clone again, which works: the session waits on it, and starts when it finishes.
    const retry = await startAdoption(process, "checkout-api");
    expect(
      await call(process, (queued) => queued.start(ADA, asked.id, { adoptionId: retry.id })),
    ).toMatchObject({ state: "waiting", clone: { state: "running" }, failure: null });
    await retry.end(true);
    const sessionId = await process.runtime.runPromise(Deferred.await(process.launched));
    expect(await readUntil(process, asked.id, "started")).toMatchObject({ sessionId });
    expect(process.started).toMatchObject([
      { projectId: retry.projectId, launch: { prompt: asked.launch.prompt } },
    ]);
    await process.runtime.dispose();
  });

  it("starts a failed one in a project that is cloned now, and says why a start failed", async () => {
    const refusing = await makeProcess({ refuseCreate: true });
    const adoption = await startAdoption(refusing, "infra");
    const asked = request(adoption.id);
    await call(refusing, (queued) => queued.queue(ADA, asked));
    await adoption.end(true);
    expect(await readUntil(refusing, asked.id, "failed")).toMatchObject({
      failure: { step: "start", message: "The project infra is not there any more." },
    });
    await refusing.runtime.dispose();

    const process = await makeProcess();
    // Bob may not start Ada's, nor Ada in a project she cannot see.
    expect(
      await failureOf(process, (queued) =>
        queued.start(BOB, asked.id, { projectId: adoption.projectId }),
      ),
    ).toBeInstanceOf(NotFound);
    expect(
      await failureOf(process, (queued) =>
        queued.start(ADA, asked.id, { projectId: ProjectId.make("p-elsewhere") }),
      ),
    ).toBeInstanceOf(NotFound);
    await call(process, (queued) => queued.start(ADA, asked.id, { projectId: adoption.projectId }));
    const sessionId = await process.runtime.runPromise(Deferred.await(process.launched));
    expect(await readUntil(process, asked.id, "started")).toMatchObject({ sessionId });
    expect(process.started).toHaveLength(1);
    await process.runtime.dispose();
  });

  it("leaves nothing behind when the person cancels while it waits", async () => {
    const process = await makeProcess();
    const adoption = await startAdoption(process, "web");
    const asked = request(adoption.id);
    await call(process, (queued) => queued.queue(ADA, asked));
    expect(await failureOf(process, (queued) => queued.cancel(BOB, asked.id))).toBeInstanceOf(
      NotFound,
    );
    await call(process, (queued) => queued.cancel(ADA, asked.id));
    expect(await failureOf(process, (queued) => queued.read(ADA, asked.id))).toBeInstanceOf(
      NotFound,
    );

    // The clone finishing afterwards starts nothing.
    await adoption.end(true);
    await process.runtime.runPromise(
      Effect.flatMap(Adoptions, (adoptions) => adoptions.watch("ada", adoption.id)).pipe(
        Effect.flatMap((watched) => watched?.ended ?? Effect.void),
      ),
    );
    await process.runtime.runPromise(Effect.sleep(Duration.millis(50)));
    expect(process.started).toEqual([]);
    expect(
      await onDatabase(Effect.flatMap(QueuedSessionsRepo, (repo) => repo.byId(asked.id))),
    ).toBeNull();
    await process.runtime.dispose();
  });

  it("refuses an adoption that is not the caller's", async () => {
    const process = await makeProcess();
    const adoption = await startAdoption(process, "billing");
    expect(
      await failureOf(process, (queued) => queued.queue(BOB, request(adoption.id))),
    ).toBeInstanceOf(NotFound);
    expect(
      await failureOf(process, (queued) => queued.queue(ADA, request(crypto.randomUUID()))),
    ).toBeInstanceOf(NotFound);
    await adoption.end(false);
    await process.runtime.dispose();
  });

  it("after a restart, starts once what was cloned and says what the restart stopped", async () => {
    // What a server left behind when it stopped: its clones went with it.
    const before = await makeProcess();
    const finished = await startAdoption(before, "finished-before-restart");
    const cut = await startAdoption(before, "cut-by-restart");
    const cloned = request(finished.id);
    const lost = request(cut.id);
    await call(before, (queued) => queued.queue(ADA, cloned));
    await call(before, (queued) => queued.queue(ADA, lost));
    await before.runtime.dispose();
    const starting = QueuedSessionId.make(crypto.randomUUID());
    const old = QueuedSessionId.make(crypto.randomUUID());
    await onDatabase(
      Effect.gen(function* () {
        // The clone that finished wrote its project just before the restart.
        yield* recordProject(finished.projectId, "finished-before-restart");
        const repo = yield* QueuedSessionsRepo;
        for (const id of [starting, old])
          yield* repo.insert({
            id,
            ownerUserId: "ada",
            organizationId: ORG,
            adoptionId: crypto.randomUUID(),
            projectName: "finished-before-restart",
            projectId: finished.projectId,
            request: (yield* repo.byId(cloned.id))?.request ?? null,
          });
        yield* repo.change(starting, ["waiting"], {
          _tag: "Starting",
          projectId: finished.projectId,
        });
        const sql = yield* SqlClient.SqlClient;
        const sessionId = SessionId.make(crypto.randomUUID());
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${`wt-${sessionId}`}, ${finished.projectId}, 'old', 'old', 'mend/old', 'abc')`;
        yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, owner_user_id, harness,
            worktree, branch, base_sha, status)
          VALUES (${sessionId}, ${finished.projectId}, ${`wt-${sessionId}`}, 'ada', 'claude', 'old',
            'mend/old', 'abc', 'completed')`;
        yield* repo.change(old, ["waiting"], { _tag: "Started", sessionId });
        yield* sql`UPDATE queued_sessions SET updated_at = now() - interval '8 days'
          WHERE id = ${old}`;
        yield* sql`UPDATE queued_sessions SET updated_at = updated_at - interval '1 minute'
          WHERE id <> ${old}`;
      }),
    );

    const after = await makeProcess();
    const sessionId = await after.runtime.runPromise(Deferred.await(after.launched));
    expect(await readUntil(after, cloned.id, "started")).toMatchObject({ sessionId });
    expect(after.started).toMatchObject([{ projectId: finished.projectId }]);
    expect(await call(after, (queued) => queued.read(ADA, lost.id))).toMatchObject({
      state: "failed",
      failure: { step: "clone", message: CLONE_STOPPED_BY_RESTART },
    });
    expect(await call(after, (queued) => queued.read(ADA, starting))).toMatchObject({
      state: "failed",
      failure: { step: "start", message: START_STOPPED_BY_RESTART },
    });
    expect(await failureOf(after, (queued) => queued.read(ADA, old))).toBeInstanceOf(NotFound);
    await after.runtime.dispose();

    // Another restart starts nothing again.
    const again = await makeProcess();
    await again.runtime.runPromise(Effect.sleep(Duration.millis(50)));
    expect(again.started).toEqual([]);
    await again.runtime.dispose();
  });
});
