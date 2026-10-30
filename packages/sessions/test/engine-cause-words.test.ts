import * as fs from "node:fs";
import * as path from "node:path";

import { failedQuery } from "@mend/db/testing";
import { WorktreeId } from "@mend/domain";
import { SessionEngine } from "@mend/sessions";
import { it } from "@mend/test-ci/effect-vitest";
import type { CreateOptions } from "@sealant/sdk";
import { Cause, Effect, Exit, Logger, References } from "effect";
import { SqlError } from "effect/sql";
import { describe, expect } from "vitest";

import { makeMemoryCaptureStore } from "./capture-store-memory.ts";
import { restoreConfiguredHarnessHome } from "./engine-capture-launch-fixtures.ts";
import {
  configuredHarnessHomePath,
  headFlush,
  shipCapturedHarnessHome,
} from "./engine/capture-fixture.ts";
import { makeEngineClock } from "./engine/clock-fixture.ts";
import {
  agentMemoryLayerOf,
  sealantLaunchLayer,
  setup,
  withPreparedEngineEffect,
} from "./engine/fixture.ts";

const ANNAS_WORDS = "Anna is interviewing at Northwind on Friday, keep it quiet 5c2e";

const MEMORY = ".claude/projects/-workspace-repo/memory";

const refusedMemoryWrite = (
  userId: string,
  projectId: string,
  file: { readonly path: string; readonly contents: string },
) =>
  failedQuery({
    query:
      'insert into "agent_memory_files" ("user_id", "project_id", "path", "encoding", "contents", "digest", "bytes", "updated_at", "updated_by_session") values ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    params: [
      userId,
      projectId,
      file.path,
      "utf8",
      file.contents,
      "sha256:0",
      0,
      "2026-10-30",
      null,
    ],
    cause: Cause.fail(
      new SqlError.SqlError({
        reason: new SqlError.UnknownError({
          cause: new Error("could not extend file: No space left on device"),
          message: "PgConnection: Query failed",
        }),
      }),
    ),
  });

describe("a failed query's words on a session line (SLNT-385)", () => {
  it.effect(
    "a launch whose hand-over of another person's memory meets a refused write keeps that person's words off its session line",
    () =>
      Effect.gen(function* () {
        const created: Array<CreateOptions> = [];
        let refused:
          | { readonly userId: string; readonly contents: string; readonly error: Error }
          | undefined;
        const memory = makeMemoryCaptureStore();
        const relocation = { homePath: "", executorRoot: "" };
        let testRoot = "";
        const clock = yield* makeEngineClock(["sessions"]);
        const errors: Array<{ readonly message: string; readonly reference: unknown }> = [];
        const logged = Logger.layer([
          Logger.make((options) => {
            if (options.logLevel !== "Error") return;
            const annotations = options.fiber.getRef(References.CurrentLogAnnotations);
            errors.push({
              message: Array.isArray(options.message)
                ? options.message.map(String).join(" ")
                : String(options.message),
              reference: annotations.reference,
            });
          }),
        ]);
        const mariasLaunch = yield* withPreparedEngineEffect(
          (world, tmp) => setup(tmp, world),
          (world, tmp, project) =>
            Effect.gen(function* () {
              testRoot = tmp;
              const engine = yield* SessionEngine;
              const anna = yield* engine.provision({
                projectId: project.id,
                harness: "claude",
                label: null,
                name: "shared",
                ownerUserId: "user-fixture",
                start: { kind: "base", base: null },
              });
              yield* engine.launch(anna.id, ["claude"]);
              const first = created[0];
              if (first === undefined) return yield* Effect.die("Anna's launch made no executor");
              const annaHome = configuredHarnessHomePath(first, relocation.executorRoot);
              fs.mkdirSync(path.join(annaHome, MEMORY), { recursive: true });
              fs.writeFileSync(path.join(annaHome, MEMORY, "MEMORY.md"), "- [plans](plans.md)\n");
              fs.writeFileSync(path.join(annaHome, MEMORY, "plans.md"), `${ANNAS_WORDS}\n`);
              yield* shipCapturedHarnessHome(
                tmp,
                memory,
                anna.worktreeId,
                memory.leases.get(anna.worktreeId)?.epoch ?? 0,
                first,
                relocation.executorRoot,
              );
              yield* engine.stop(anna.id);
              yield* clock.untilChanged(
                () => world.sessions.get(anna.id)?.settledAt != null,
                "Anna's session settles",
              );

              const maria = yield* engine.provisionSessionIn(anna.worktreeId, {
                harness: "claude",
                label: null,
                ownerUserId: "user-maria",
              });
              const launched = yield* engine.launch(maria.id, ["claude"]).pipe(Effect.exit);
              const row = world.sessions.get(maria.id);
              return { launched, status: row?.status, summary: row?.summary ?? "" };
            }),
          {
            captured: memory,
            prepareWorld: clock.prepareWorld,
            agentMemoryLayer: agentMemoryLayerOf({
              readBack: (input) => {
                const file = input.session.find((each) => each.path.endsWith("/plans.md"));
                if (file === undefined) return Effect.die("the hand-over read back no plans.md");
                const error = refusedMemoryWrite(input.userId, input.projectId, file);
                refused = { userId: input.userId, contents: file.contents, error };
                return Effect.die(error);
              },
            }),
            sealantLayer: sealantLaunchLayer(
              created,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              {
                relocation,
                flush: headFlush(memory),
                beforeCreate: (options) =>
                  Effect.gen(function* () {
                    relocation.executorRoot = path.join(
                      testRoot,
                      `handover-executor-${created.length}`,
                    );
                    relocation.homePath = path.join(relocation.executorRoot, "home", "agent");
                    fs.mkdirSync(relocation.executorRoot, { recursive: true });
                    const source = options.source;
                    if (source?.kind !== "capture" || source.worktreeId === undefined) {
                      throw new Error("test executor requires a capture source");
                    }
                    yield* restoreConfiguredHarnessHome(
                      testRoot,
                      memory,
                      WorktreeId.make(source.worktreeId),
                      options,
                      relocation.executorRoot,
                    );
                  }),
              },
            ),
          },
        ).pipe(Effect.provide(logged));
        expect(refused?.userId).toBe("user-fixture");
        expect(refused?.contents).toContain(ANNAS_WORDS);
        const defects = Exit.isFailure(mariasLaunch.launched)
          ? mariasLaunch.launched.cause.reasons
              .filter(Cause.isDieReason)
              .map((reason) => reason.defect)
          : [];
        expect(defects).toContain(refused?.error);
        expect(mariasLaunch.status).toBe("failed");
        expect(mariasLaunch.summary).not.toContain(ANNAS_WORDS);
        const line = /^launch failed: database operation failed · reference ([0-9a-f]{16})$/.exec(
          mariasLaunch.summary,
        );
        expect(line, mariasLaunch.summary).not.toBeNull();
        expect(errors.map((entry) => entry.reference)).toContain(line?.[1]);
      }),
    30_000,
  );
});
