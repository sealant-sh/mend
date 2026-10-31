import { PreviewsRepo } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { PreviewId, SessionProcessId } from "@mend/domain";
import { PreviewStartRefusal, type PreviewStartRequest } from "@mend/domain/workbench";
import { PreviewStartRefused, ResourceRuntimeNone, SessionEngine } from "@mend/sessions";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPreviewDatabase,
  type PreviewDatabase,
  previewReposLayer,
} from "../test/support/preview-database.ts";
import { PreviewStartFailed, PreviewTargets, PreviewTargetsLive } from "./preview-targets.ts";

const postgres = postgresTestConfig();

let database: PreviewDatabase | null = null;
beforeAll(async () => {
  if (!postgres.skip) database = await createPreviewDatabase("preview_targets");
});
afterAll(async () => {
  await database?.drop();
});

const seeded = () => {
  if (database === null) throw new Error("the database was not created");
  return database;
};

const run = <A, E>(
  effect: Effect.Effect<A, E, PreviewTargets | PreviewsRepo | SqlClient.SqlClient>,
  start: (request: PreviewStartRequest) => Effect.Effect<SessionProcessId, PreviewStartRefused>,
) => {
  const repos = previewReposLayer(seeded().url);
  // `Layer.mock` needs every plain-function member; the gateway calls only the start.
  const engine = Layer.mock(SessionEngine, {
    ensurePreviewRunning: start,
    launchUnderWay: () => false,
  });
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        PreviewTargetsLive.pipe(
          Layer.provideMerge(Layer.mergeAll(repos, engine, ResourceRuntimeNone)),
        ),
      ),
      Effect.scoped,
    ),
  );
};

const noStart = () => Effect.die("no start expected");

describe.skipIf(postgres.skip)("the gateway's targets, from Postgres and the engine", () => {
  it("reads kept previews' resolutions, one or many, and a removed preview as none", async () => {
    const { web, docs } = seeded().previews;
    await run(
      Effect.gen(function* () {
        const targets = yield* PreviewTargets;
        const repo = yield* PreviewsRepo;
        expect(
          yield* targets.snapshot(web.id),
          "a kept preview's resolution, as the repo reads it",
        ).toEqual((yield* repo.gatewaySnapshot(web.id))?.resolution);
        expect((yield* targets.snapshot(web.id))?._tag, "its Service runs").toBe("Bound");
        const both = yield* targets.snapshots([web.id, docs.id, PreviewId.make("pv-unknown")]);
        expect([...both.keys()].toSorted(), "an unknown id is absent").toEqual(
          [web.id, docs.id].toSorted(),
        );
        expect(yield* targets.snapshot(PreviewId.make("pv-unknown")), "an unknown id").toBeNull();

        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM worktrees WHERE id = 'wt-1'`;
        expect(
          (yield* repo.gatewaySnapshot(web.id))?.preview.state,
          "the repo still reads the preview, as removed",
        ).toBe("removed");
        expect(yield* targets.snapshot(web.id), "a removed preview reads as none").toBeNull();
        expect(
          (yield* targets.snapshots([web.id, docs.id])).size,
          "removed previews are absent from many",
        ).toBe(0);
      }),
      noStart,
    );
  });

  it("asks the engine to start with the request as given, and answers its attempt", async () => {
    const asked: Array<PreviewStartRequest> = [];
    const request: PreviewStartRequest = {
      previewId: PreviewId.make("pv-start"),
      revision: 2,
      sourceAttemptId: SessionProcessId.make("att-source"),
      deadline: 1_000,
    };
    const attempt = await run(
      Effect.flatMap(PreviewTargets, (targets) => targets.ensureRunning(request, Effect.void)),
      (received) =>
        Effect.sync(() => {
          asked.push(received);
          return SessionProcessId.make("att-started");
        }),
    );
    expect(attempt, "the engine's attempt").toBe("att-started");
    expect(asked, "the engine saw the request unchanged").toEqual([request]);
  });

  it.each(PreviewStartRefusal.literals)(
    "answers the engine's %s refusal as a failed start of the same reason",
    async (reason) => {
      const exit = await run(
        Effect.exit(
          Effect.flatMap(PreviewTargets, (targets) =>
            targets.ensureRunning(
              {
                previewId: PreviewId.make("pv-refused"),
                revision: 0,
                sourceAttemptId: SessionProcessId.make("att-source"),
                deadline: 1_000,
              },
              Effect.void,
            ),
          ),
        ),
        () => Effect.fail(new PreviewStartRefused({ reason, detail: "for the log only" })),
      );
      expect(exit, "the gateway's failure, without the engine's detail").toEqual(
        Exit.fail(new PreviewStartFailed({ reason })),
      );
    },
  );
});
