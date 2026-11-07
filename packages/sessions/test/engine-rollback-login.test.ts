import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

import { CheckpointId } from "@mend/domain";
import { TurnBoundaryId } from "@mend/domain/workbench";
import { SessionEngine, startFromBase } from "@mend/sessions";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeWorld, setup, withEngine } from "./engine/fixture.ts";

it("refuses a fresh rollback before admission when the asker's provider login is unavailable", async () => {
  const tmp = execFileSync("mktemp", ["-d", "-t", "mend-rollback-login.XXXXXX"], {
    encoding: "utf8",
  }).trim();
  try {
    await withEngine(
      (world, directory) =>
        Effect.gen(function* () {
          const project = yield* setup(directory, world);
          const engine = yield* SessionEngine;
          const session = yield* engine.provision({
            projectId: project.id,
            harness: "codex",
            label: null,
            name: "login",
            start: startFromBase(null),
            ownerUserId: "user-fixture",
          });
          const result = yield* engine
            .rollbackSession({
              actor: "user-fixture",
              commandId: "fresh-rollback",
              request: {
                sessionId: session.id,
                at: {
                  checkpointId: CheckpointId.make("missing"),
                  boundaryId: TurnBoundaryId.make("missing"),
                },
                expected: { historyRevision: 0, worktreeEpoch: 0 },
              },
            })
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "RollbackRefusedError", code: "login_required" },
          });
        }),
      { fixture: { tmp, world: makeWorld() } },
    );
  } finally {
    console.info("Removing task-owned login fixture", tmp, fs.readdirSync(tmp));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
