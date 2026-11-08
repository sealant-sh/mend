import { PgClient } from "@effect/sql-pg";
import {
  ChangePassesRepo,
  ChangePassesRepoLive,
  ChangeToursRepo,
  ChangeToursRepoLive,
  MendDBLive,
  migrations,
  ProjectsRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ChangeId } from "@mend/domain";
import { InferenceProvider, TourComposer } from "@mend/inference";
import { SealantClient } from "@mend/sealant";
import { WORKTREE_STAMP, WorktreeReads } from "@mend/sessions";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect } from "vitest";

import { runReviewPass } from "./review-pass-worker.ts";

const postgres = postgresTestConfig();
const database = `mend_tour_pass_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const dataLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
);
const repos = Layer.mergeAll(
  ChangePassesRepoLive,
  ChangeToursRepoLive,
  ProjectsRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
).pipe(Layer.provideMerge(dataLayer));
const CHANGE = ChangeId.make("tour-pass");
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof repos>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repos), Effect.scoped));

const withInference = (respond: InferenceProvider["Service"]["respond"]) =>
  TourComposer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        repos,
        Layer.succeed(InferenceProvider, { respond }),
        Layer.mock(WorktreeReads, {
          diffWorktree: () => Effect.succeed({ value: "+retry", stamp: WORKTREE_STAMP }),
        }),
        Layer.mock(SealantClient, {}),
      ),
    ),
  );

describe.skipIf(postgres.skip)("a tour through the worker and Postgres", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(`CREATE DATABASE ${database}`)).pipe(
        Effect.provide(adminLayer),
        Effect.scoped,
      ),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
        VALUES ('tour-project', 'tour', '/store/tour/repo.git', 'main',
          (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
        VALUES ('tour-worktree', 'tour-project', 'tour', 'tour', 'mend/tour', 'abc')`;
        yield* sql`INSERT INTO agent_sessions
        (id, project_id, worktree_id, harness, worktree, branch, base_sha, status, sealant_run_id)
        VALUES ('tour-session', 'tour-project', 'tour-worktree', 'claude', 'tour', 'mend/tour',
          'abc', 'completed', 'tour-run')`;
        yield* sql`INSERT INTO worktree_changes
        (id, project_id, worktree_id, session_id, branch, base_sha)
        VALUES (${CHANGE}, 'tour-project', 'tour-worktree', 'tour-session', 'mend/tour', 'abc')`;
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        sql.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`),
      ).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
  });

  it("stores the composed tour and completes its pass", async () => {
    const composer = withInference(() =>
      Effect.succeed({
        summary: "Adds a retry.",
        approach: null,
        stops: [{ title: "Retry", file: null, narration: "Read the retry.", evidence: [] }],
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* TourComposer;
        yield* runReviewPass(
          "tour",
          { changeId: CHANGE, requestedBy: "alice" },
          service.compose({ changeId: CHANGE }),
        );
        expect((yield* (yield* ChangePassesRepo).listForChange(CHANGE))[0]).toMatchObject({
          status: "completed",
          detail: null,
        });
        expect((yield* (yield* ChangeToursRepo).byChange(CHANGE))?.summary).toBe("Adds a retry.");
      }).pipe(Effect.provide(Layer.mergeAll(composer, repos)), Effect.scoped),
    );
  });

  it.effect("a stalled composer records a timeout instead of leaving Writing forever", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const composer = withInference(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A new diff with no cached tour asks inference to compose again.
        yield* sql`DELETE FROM change_tours WHERE change_id = ${CHANGE}`;
        const service = yield* TourComposer;
        const fiber = yield* runReviewPass(
          "tour",
          { changeId: CHANGE, requestedBy: "alice" },
          service.compose({ changeId: CHANGE }),
        ).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 minutes");
        // Advancing the clock fires the deadline; join also waits for the SQL finalizer.
        yield* Fiber.join(fiber);
        const [stored] =
          yield* sql`SELECT status, detail, finished_at FROM change_passes WHERE change_id = ${CHANGE} AND kind = 'tour'`;
        expect(stored).toMatchObject({
          status: "failed",
          detail: "The review pass timed out after 5 minutes. Ask for it again.",
          finished_at: new Date(5 * 60 * 1000),
        });
        expect(yield* (yield* ChangeToursRepo).byChange(CHANGE)).toBeNull();
      }).pipe(Effect.provide(Layer.mergeAll(composer, repos)));
    }),
  );

  it.effect.each(["invalid answer", "defect"] as const)(
    "a composer's %s records a plain failure and preserves the job failure",
    (failure) => {
      const composer = withInference(() =>
        failure === "defect" ? Effect.die("provider defect") : Effect.succeed({ summary: 42 }),
      );
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM change_tours WHERE change_id = ${CHANGE}`;
        const service = yield* TourComposer;
        const exit = yield* runReviewPass(
          "tour",
          { changeId: CHANGE, requestedBy: "alice" },
          service.compose({ changeId: CHANGE }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(
            failure === "defect" ? Cause.hasDies(exit.cause) : Cause.hasFails(exit.cause),
          ).toBe(true);
        }
        const [stored] =
          yield* sql`SELECT status, detail, finished_at FROM change_passes WHERE change_id = ${CHANGE} AND kind = 'tour'`;
        expect(stored?.["status"]).toBe("failed");
        expect(stored?.["finished_at"]).toEqual(new Date(0));
        if (failure === "defect") {
          expect(stored?.["detail"]).toBe("The review pass failed unexpectedly. Ask for it again.");
        } else {
          expect(stored?.["detail"]).toEqual(
            expect.stringContaining("the tour did not match its schema"),
          );
        }
        expect(yield* (yield* ChangeToursRepo).byChange(CHANGE)).toBeNull();
      }).pipe(Effect.provide(Layer.mergeAll(composer, repos)));
    },
  );
});
