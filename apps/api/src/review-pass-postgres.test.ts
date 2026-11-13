import { PgClient } from "@effect/sql-pg";
import {
  ChangePassesRepo,
  ChangePassesRepoLive,
  ChangeToursRepo,
  ChangeToursRepoLive,
  InferenceCallsRepo,
  InferenceCallsRepoLive,
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
import type { Run as SdkRun } from "@sealant/sdk";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Redacted, Stream } from "effect";
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
  InferenceCallsRepoLive,
  ProjectsRepoLive,
  SessionsRepoLive,
  WorktreeChangesRepoLive,
).pipe(Layer.provideMerge(dataLayer));
const CHANGE = ChangeId.make("tour-pass");
const run = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof repos>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repos), Effect.scoped));

const withInference = (
  respond: InferenceProvider["Service"]["respond"],
  sealant: Layer.Layer<SealantClient> = Layer.mock(SealantClient, {}),
) =>
  TourComposer.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        repos,
        Layer.succeed(InferenceProvider, { respond }),
        Layer.mock(WorktreeReads, {
          diffWorktree: () => Effect.succeed({ value: "+retry", stamp: WORKTREE_STAMP }),
        }),
        sealant,
      ),
    ),
  );

const unused = async (): Promise<never> => {
  throw new Error("unexpected SDK operation");
};
const recordedRun: SdkRun = {
  id: "tour-run",
  result: { status: "completed", outcome: "completed", exitCode: 0 },
  changes: { files: [], diff: unused },
  artifacts: { list: unused, get: unused },
  wait: unused,
  record: {
    runId: "tour-run",
    replay: unused,
    commands: unused,
    transcript: unused,
    timeline: () => {
      throw new Error("use the SealantClient boundary");
    },
    stream: () => {
      throw new Error("use the SealantClient boundary");
    },
    scrollback: () => {
      throw new Error("use the SealantClient boundary");
    },
    loss: unused,
    summary: unused,
    fileTreeAt: unused,
    processTreeAt: unused,
  },
};

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

  it.effect(
    "sealant's monotonic timestamp reaches a completed tour through the real recording tool",
    () => {
      const composer = withInference(
        (request) =>
          Effect.gen(function* () {
            const recording = request.tools?.find((tool) => tool.name === "read_recording");
            if (recording === undefined) return yield* Effect.die("missing recording tool");
            expect(yield* recording.handle({})).toMatchObject([
              { sequence: "17", occurredAt: null, monotonicTimestamp: "27010301602537" },
            ]);
            return {
              summary: "Records file changes.",
              approach: "Read the record.",
              stops: [
                {
                  title: "Change",
                  file: null,
                  narration: "A file changed.",
                  evidence: [{ sequence: "17", excerpt: "file\u0000changed" }],
                },
              ],
            };
          }).pipe(Effect.orDie),
        Layer.mock(SealantClient, {
          getRun: () => Effect.succeed(recordedRun),
          recordTimeline: () =>
            Stream.make({
              sequence: 17n,
              occurredAt: "27010301602537",
              kind: "fileDiffAvailable",
              summary: "file diff available",
              data: { added: "0", modified: "1", deleted: "0", renamed: "0" },
            }),
        }),
      );
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM change_tours WHERE change_id = ${CHANGE}`;
        yield* runReviewPass(
          "tour",
          { changeId: CHANGE, requestedBy: "alice" },
          (yield* TourComposer).compose({ changeId: CHANGE }),
        );
        expect((yield* (yield* ChangePassesRepo).listForChange(CHANGE))[0]?.status).toBe(
          "completed",
        );
        expect((yield* (yield* ChangeToursRepo).byChange(CHANGE))?.stops[0]).toMatchObject({
          grounded: true,
          evidence: [{ sequence: 17n, excerpt: "file\\u0000changed" }],
        });
      }).pipe(Effect.provide(Layer.mergeAll(composer, repos)));
    },
  );

  it.effect("NULs in inference audit and tour text cannot abort JSONB persistence", () => {
    const answer = {
      summary: "Changes \u0000 files; literal \\u0000 stays literal.",
      approach: "Read \u0000 output.",
      stops: [
        { title: "File\u0000 change", file: null, narration: "Saw \u0000 bytes.", evidence: [] },
      ],
    };
    return Effect.gen(function* () {
      const calls = yield* InferenceCallsRepo;
      const composer = withInference(() =>
        calls
          .record({
            context: "change-tour",
            tool: null,
            input: { "record\u0000": ["before\u0000after", "literal \\u0000"] },
            output: answer,
          })
          .pipe(Effect.as(answer)),
      );
      return yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM change_tours WHERE change_id = ${CHANGE}`;
        yield* runReviewPass(
          "tour",
          { changeId: CHANGE, requestedBy: "alice" },
          (yield* TourComposer).compose({ changeId: CHANGE }),
        );
        expect((yield* (yield* ChangePassesRepo).listForChange(CHANGE))[0]?.status).toBe(
          "completed",
        );
        expect(yield* (yield* ChangeToursRepo).byChange(CHANGE)).toMatchObject({
          summary: "Changes \\u0000 files; literal \\u0000 stays literal.",
          approach: "Read \\u0000 output.",
          stops: [{ title: "File\\u0000 change", narration: "Saw \\u0000 bytes." }],
        });
        const [audit] =
          yield* sql`SELECT input, output FROM inference_calls WHERE context = 'change-tour'`;
        expect(audit).toMatchObject({
          input: { "record\\u0000": ["before\\u0000after", "literal \\u0000"] },
          output: { summary: "Changes \\u0000 files; literal \\u0000 stays literal." },
        });
      }).pipe(Effect.provide(Layer.mergeAll(composer, repos)));
    }).pipe(Effect.provide(repos));
  });

  it.effect.each([null, undefined])("audit keeps %s as JSON null", (value) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM inference_calls`;
      yield* (yield* InferenceCallsRepo).record({
        context: "change-tour",
        tool: null,
        input: value,
        output: value,
      });
      const [row] = yield* sql`SELECT input, output,
        input IS NULL AS input_sql_null, output IS NULL AS output_sql_null FROM inference_calls`;
      expect(row).toEqual({
        input: null,
        output: null,
        input_sql_null: false,
        output_sql_null: false,
      });
    }).pipe(Effect.provide(repos)),
  );

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

  it.effect("discards a tour deleted during composition and skips later jobs for it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const deleted = ChangeId.make("deleted-tour");
      yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
        VALUES ('deleted-tour-worktree', 'tour-project', 'deleted', 'deleted', 'mend/deleted', 'abc')`;
      yield* sql`INSERT INTO worktree_changes
        (id, project_id, worktree_id, session_id, branch, base_sha)
        VALUES (${deleted}, 'tour-project', 'deleted-tour-worktree', 'tour-session', 'mend/deleted', 'abc')`;
      let calls = 0;
      const composer = withInference(() =>
        Effect.gen(function* () {
          calls++;
          yield* sql`DELETE FROM worktree_changes WHERE id = ${deleted}`;
          return {
            summary: "Already deleted.",
            approach: null,
            stops: [{ title: "Gone", file: null, narration: "Gone.", evidence: [] }],
          };
        }).pipe(Effect.orDie),
      );
      yield* Effect.gen(function* () {
        const service = yield* TourComposer;
        for (let attempt = 0; attempt < 2; attempt++) {
          yield* runReviewPass(
            "tour",
            { changeId: deleted, requestedBy: "alice" },
            service.compose({ changeId: deleted }),
          );
        }
        expect(calls).toBe(1);
        expect(yield* (yield* ChangePassesRepo).listForChange(deleted)).toEqual([]);
        expect(yield* (yield* ChangeToursRepo).byChange(deleted)).toBeNull();
      }).pipe(Effect.provide(Layer.mergeAll(composer, repos)));
    }).pipe(Effect.provide(repos)),
  );
});
