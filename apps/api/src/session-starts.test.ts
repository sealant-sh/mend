import { PgClient } from "@effect/sql-pg";
import {
  BudgetExceeded,
  LaunchRequest,
  NewWorkbenchSession,
  NotFound,
  StartSessionRequest,
} from "@mend/api-contracts";
import {
  MendDBLive,
  SessionStartsRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  migrations,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import type { Session } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Redacted,
  String as Str,
} from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SessionStart } from "./session-start.ts";
import { SessionStarts, SessionStartsLive } from "./session-starts.ts";

const postgres = postgresTestConfig();
const database = `mend_session_starts_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pg = PgClient.layer({
  url: Redacted.make(scratchUrl.toString()),
  transformResultNames: Str.snakeToCamel,
});
const repos = Layer.mergeAll(SessionStartsRepoLive, SessionsRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pg))),
);
const reposRuntime = ManagedRuntime.make(repos);

const ORG = OrganizationId.make("org-northwind");
const PROJECT = ProjectId.make("p-northwind");
const ADA = { userId: "ada", credential: null };
const BOB = { userId: "bob", credential: null };

/** What the fake `SessionStart` was asked to do, in order. */
type Asked =
  | { readonly _tag: "made"; readonly sessionId: SessionId }
  | { readonly _tag: "launched"; readonly sessionId: SessionId; readonly prompt: string }
  | { readonly _tag: "settled"; readonly sessionId: SessionId; readonly message: string };

/**
 * One API process: `SessionStarts` over a `SessionStart` that writes the session row the engine
 * would and records each launch, and an engine whose `detach` forks past the caller.
 */
const makeProcess = async (
  options: {
    /** Making waits for this before it writes the session: a slow provision. */
    readonly madeAfter?: Deferred.Deferred<void>;
    readonly refuseMake?: boolean;
    readonly refuseLaunch?: boolean;
  } = {},
) => {
  const asked: Asked[] = [];
  /** The span each launch ran in: its name, its trace, and the span it was parented on. */
  const launchSpans: Array<{ name: string; traceId: string; parent: string | null }> = [];
  const sessionStart = Layer.effect(
    SessionStart,
    Effect.gen(function* () {
      const sessions = yield* SessionsRepo;
      const sql = yield* SqlClient.SqlClient;
      return {
        createAs: (actor, projectId, input) =>
          Effect.gen(function* () {
            if (options.madeAfter !== undefined) yield* Deferred.await(options.madeAfter);
            if (options.refuseMake === true) return yield* new NotFound({ id: projectId });
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
            asked.push({ _tag: "made", sessionId: id });
            return session;
          }),
        createInWorktreeAs: () => Effect.die("these starts make new worktrees"),
        launchAs: (_userId, session, launch, answer) =>
          Effect.gen(function* () {
            if (options.refuseLaunch === true)
              return yield* new BudgetExceeded({
                budget: "accountLaunchesInFlight",
                limit: 1,
                retryAfterSeconds: null,
                message: "Too many sessions are starting at once.",
              });
            yield* answer?.onAdmitted ?? Effect.void;
            const span = yield* Effect.currentSpan.pipe(Effect.orDie);
            launchSpans.push({
              name: span.name,
              traceId: span.traceId,
              parent: Option.getOrNull(Option.map(span.parent, (parent) => parent.spanId)),
            });
            asked.push({ _tag: "launched", sessionId: session.id, prompt: launch.prompt ?? "" });
            return session;
          }),
        settleUnlaunched: (session, message) =>
          Effect.sync(() => {
            asked.push({ _tag: "settled", sessionId: session.id, message });
          }),
        startAs: () => Effect.die("not used"),
      };
    }),
  );
  const engine = Layer.mock(SessionEngine, {
    detach: (effect) => Effect.forkDetach(effect),
    launchUnderWay: () => false,
  });
  const layer = SessionStartsLive.pipe(Layer.provide(sessionStart), Layer.provide(engine));
  const runtime = ManagedRuntime.make(layer.pipe(Layer.provideMerge(repos)));
  await runtime.runPromise(Effect.void);
  return { runtime, asked, launchSpans };
};

const onDatabase = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof repos>>) =>
  reposRuntime.runPromise(effect.pipe(Effect.orDie));

const startRequest = (key: string, prompt = "Fix the flaky test") =>
  new StartSessionRequest({
    key,
    target: {
      _tag: "Project",
      projectId: PROJECT,
      session: new NewWorkbenchSession({
        harness: "codex",
        mode: "protocol",
        label: null,
        name: null,
        base: null,
        autoLand: null,
      }),
    },
    launch: new LaunchRequest({ mode: "protocol", prompt }),
  });

/** Run `use` with the process's `SessionStarts`. */
const withStarts = <A, E>(use: (starts: SessionStarts["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* use(yield* SessionStarts);
  });

/** Waits until `check` holds, a few seconds at most. */
const eventually = async (check: () => boolean) => {
  for (let tries = 0; tries < 100 && !check(); tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

describe("SessionStarts (SLNT-1239)", () => {
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
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
            visibility, created_by_user_id)
          VALUES (${PROJECT}, 'northwind', '/store/northwind', 'main', ${ORG}, 'private', 'ada')`;
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

  it("makes the session and launches it on the first message in one request", async () => {
    const { runtime, asked } = await makeProcess();
    const key = crypto.randomUUID();
    const session = await runtime.runPromise(
      withStarts((starts) => starts.start(ADA, startRequest(key), null)),
    );
    expect(asked).toEqual([
      { _tag: "made", sessionId: session.id },
      { _tag: "launched", sessionId: session.id, prompt: "Fix the flaky test" },
    ]);
    const read = await runtime.runPromise(withStarts((starts) => starts.read(ADA, key)));
    expect(read).toMatchObject({ key, state: "made", sessionId: session.id, failure: null });
    await runtime.dispose();
  });

  it("makes and launches the session though the request that asked goes away (a closed tab)", async () => {
    const madeAfter = await reposRuntime.runPromise(Deferred.make<void>());
    const { runtime, asked } = await makeProcess({ madeAfter });
    const key = crypto.randomUUID();
    const request = runtime.runFork(
      withStarts((starts) => starts.start(ADA, startRequest(key), null)),
    );
    // Mend has the start and is still making the session when the client goes away.
    let state = "unknown";
    for (let tries = 0; tries < 100 && state !== "making"; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (await runtime.runPromise(withStarts((starts) => starts.read(ADA, key)))).state;
    }
    expect(state).toBe("making");
    await runtime.runPromise(Fiber.interrupt(request));
    await reposRuntime.runPromise(Deferred.succeed(madeAfter, undefined));
    await eventually(() => asked.some((each) => each._tag === "launched"));
    const made = asked.find((each) => each._tag === "made");
    expect(asked).toEqual([
      { _tag: "made", sessionId: made?.sessionId },
      { _tag: "launched", sessionId: made?.sessionId, prompt: "Fix the flaky test" },
    ]);
    // A page reloaded meanwhile finds it by its key.
    const read = await runtime.runPromise(withStarts((starts) => starts.read(ADA, key)));
    expect(read).toMatchObject({ state: "made", sessionId: made?.sessionId });
    await runtime.dispose();
  });

  it("launches in one span parented on the request, which joins the request's trace", async () => {
    const { runtime, launchSpans } = await makeProcess();
    const request = await runtime.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.makeSpan("request");
        yield* withStarts((starts) =>
          starts.start(ADA, startRequest(crypto.randomUUID()), null),
        ).pipe(Effect.withParentSpan(span));
        return span;
      }),
    );
    await eventually(() => launchSpans.length === 1);
    expect(launchSpans[0]?.name).toBe("mend.session.start");
    expect(launchSpans[0]?.traceId).toBe(request.traceId);
    await runtime.dispose();
  });

  it("starts no second session for the same key", async () => {
    const { runtime, asked } = await makeProcess();
    const key = crypto.randomUUID();
    const start = withStarts((starts) => starts.start(ADA, startRequest(key), null));
    const first = await runtime.runPromise(start);
    const again = await runtime.runPromise(start);
    expect(again.id).toBe(first.id);
    expect(asked.filter((each) => each._tag === "made")).toHaveLength(1);
    await runtime.dispose();
  });

  it("keeps why it made no session, for a page that reads the key", async () => {
    const { runtime, asked } = await makeProcess({ refuseMake: true });
    const key = crypto.randomUUID();
    const refused = await runtime.runPromise(
      withStarts((starts) => starts.start(ADA, startRequest(key), null)).pipe(Effect.flip),
    );
    expect(refused._tag).toBe("NotFound");
    expect(asked).toEqual([]);
    const read = await runtime.runPromise(withStarts((starts) => starts.read(ADA, key)));
    expect(read).toMatchObject({
      state: "failed",
      sessionId: null,
      failure: "The project isn't there any more.",
    });
    await runtime.dispose();
  });

  it("ends a session whose launch was refused, so it never reads Starting for good", async () => {
    const { runtime, asked } = await makeProcess({ refuseLaunch: true });
    const session = await runtime.runPromise(
      withStarts((starts) => starts.start(ADA, startRequest(crypto.randomUUID()), null)),
    );
    expect(asked).toEqual([
      { _tag: "made", sessionId: session.id },
      {
        _tag: "settled",
        sessionId: session.id,
        message: "Too many sessions are starting at once.",
      },
    ]);
    await runtime.dispose();
  });

  it("is one person's: another reads nothing by the same key", async () => {
    const { runtime } = await makeProcess();
    const key = crypto.randomUUID();
    await runtime.runPromise(withStarts((starts) => starts.start(ADA, startRequest(key), null)));
    const read = await runtime.runPromise(withStarts((starts) => starts.read(BOB, key)));
    expect(read).toMatchObject({ state: "unknown", sessionId: null, failure: null });
    await runtime.dispose();
  });
});
