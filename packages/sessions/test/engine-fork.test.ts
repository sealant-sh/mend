import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { sealNativeHistory } from "@mend/agent-protocol";
import { AgentTurnId, SealantRunId, SessionProcessId } from "@mend/domain";
import { AgentTurn, TurnBoundaryId } from "@mend/domain/workbench";
import { SessionEngine, startFromBase } from "@mend/sessions";
import { worktreePathOf } from "@mend/store";
import { Effect, Result } from "effect";
import { describe, expect, it } from "vitest";

import { makeWorld, recordedTurnsLayer, setup, withEngine } from "./engine/fixture.ts";
import { personPlatform } from "./engine/person-fixture.ts";
import { makeHistoryMemory } from "./session-history-memory.ts";

// Ordinary trigger: a person forks an older response after continuing the source, then retries
// when the first answer was lost. Historical selection and transport retries are routine use.
describe("fork session receipts and exact retained evidence", () => {
  it("creates one asker-owned child with the old tree and prefix, replayable after source deletion and restart", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-fork-restart-"));
    const world = makeWorld();
    const history = makeHistoryMemory();
    const turns: AgentTurn[] = [];
    let loginActive = true;
    const options = {
      fixture: { world, tmp },
      history,
      conversationLayer: recordedTurnsLayer(turns),
      harnessLayout: {
        platform: personPlatform([], {}, undefined, () => ({
          _tag: loginActive ? "active" : "missing",
        })),
      },
    };
    try {
      const receipt = await withEngine(
        (state, directory) =>
          Effect.gen(function* () {
            const project = yield* setup(directory, state);
            state.members.set("source-owner", "member");
            state.members.set("asker", "member");
            const engine = yield* SessionEngine;
            const source = yield* engine.provision({
              projectId: project.id,
              harness: "claude",
              label: "Source",
              name: "source",
              start: startFromBase(null),
              ownerUserId: "source-owner",
            });
            const old = yield* engine
              .forkSession({
                actor: "asker",
                commandId: "old-boundary",
                request: { sourceSessionId: source.id, at: { kind: "latestStable" }, title: null },
              })
              .pipe(Effect.result);
            expect(Result.isFailure(old) && old.failure.reason).toBe("boundary_unavailable");
            const forbidden = yield* engine
              .forkSession({
                actor: "outsider",
                commandId: "outsider",
                request: { sourceSessionId: source.id, at: { kind: "latestStable" }, title: null },
              })
              .pipe(Effect.result);
            expect(Result.isFailure(forbidden) && forbidden.failure.reason).toBe("forbidden");
            const sourcePath = worktreePathOf(project.storePath, source.worktree);
            fs.writeFileSync(path.join(sourcePath, "app.ts"), "selected response\n");
            const checkpoint = yield* engine.checkpointNow(source.id, "user-mark");
            const turn = new AgentTurn({
              id: AgentTurnId.make("selected"),
              sessionId: source.id,
              processId: SessionProcessId.make("source-process"),
              ordinal: 0,
              author: "source-owner",
              input: "first input",
              status: "completed",
              providerTurnId: "native-turn",
              error: null,
              usage: null,
              selection: { harness: "claude", model: null, effort: null, interactionMode: "plan" },
              createdAt: new Date(),
              startedAt: new Date(),
              endedAt: new Date(),
            });
            turns.push(
              turn,
              new AgentTurn({
                ...turn,
                id: AgentTurnId.make("later"),
                ordinal: 1,
                input: "later active input",
                status: "running",
                endedAt: null,
              }),
            );
            const sessionId = "11111111-1111-4111-8111-111111111111";
            const uuid = "22222222-2222-4222-8222-222222222222";
            const seed = yield* sealNativeHistory({
              observation: {
                providerVersion: "2.1.318",
                cutoff: { provider: "claude", sessionId, throughMessageId: uuid },
              },
              files: [
                {
                  relativePath: `.claude/projects/-workspace-repo/${sessionId}.jsonl`,
                  content: `${JSON.stringify({
                    type: "assistant",
                    sessionId,
                    version: "2.1.318",
                    uuid,
                    parentUuid: null,
                    toolUseResult: { task: { id: "1" } },
                    message: {
                      role: "assistant",
                      content: [
                        {
                          type: "tool_use",
                          name: "ExitPlanMode",
                          id: "plan",
                          input: { planFilePath: "/source/.claude/plans/selected.md" },
                        },
                        {
                          type: "tool_use",
                          name: "TodoWrite",
                          id: "todo",
                          input: {
                            todos: [
                              { content: "Selected todo", status: "pending", activeForm: "Doing" },
                            ],
                          },
                        },
                        {
                          type: "text",
                          text: `<persisted-output>Full output saved to: /source/.claude/projects/-workspace-repo/${sessionId}/tool-results/selected.txt\n</persisted-output>`,
                        },
                      ],
                    },
                  })}\n`,
                },
                { relativePath: ".claude/plans/selected.md", content: "Selected plan" },
                {
                  relativePath: `.claude/tasks/${sessionId}/1.json`,
                  content: '{"id":"1","subject":"Selected task"}',
                },
                {
                  relativePath: `.claude/projects/-workspace-repo/${sessionId}/tool-results/selected.txt`,
                  content: "Selected output",
                },
              ],
            });
            expect(seed.files).toHaveLength(4);
            history.seeds.set(seed.manifest.id, seed);
            history.observations.set("selected", {
              kind: "ready",
              boundary: {
                id: TurnBoundaryId.make("selected-boundary"),
                sessionId: source.id,
                revision: 0,
                anchor: { kind: "turn", turnId: turn.id },
                checkpointId: checkpoint.id,
                checkpointSha: checkpoint.sha,
                nativeSeedId: seed.manifest.id,
                selection: {
                  harness: "claude",
                  model: null,
                  effort: null,
                  interactionMode: "plan",
                },
                gitHead: source.baseSha,
                reviewBase: { sha: source.baseSha, ref: source.baseRef ?? source.baseSha },
                repositorySeed: null,
                observedAt: new Date(),
                nativeObservedAt: new Date(),
                record: { runId: SealantRunId.make("source-run"), seq: 17n },
              },
            });
            fs.writeFileSync(path.join(sourcePath, "app.ts"), "later source files\n");
            const request = {
              sourceSessionId: source.id,
              at: { kind: "turn", turnId: turn.id },
              title: null,
            } as const;
            loginActive = false;
            const noLogin = yield* engine
              .forkSession({ actor: "asker", commandId: "missing-login", request })
              .pipe(Effect.result);
            expect(Result.isFailure(noLogin) && noLogin.failure.reason).toBe("login_required");
            expect(history.operations.size).toBe(0);
            loginActive = true;
            history.seeds.delete(seed.manifest.id);
            const missingHistory = yield* engine
              .forkSession({ actor: "asker", commandId: "missing-history", request })
              .pipe(Effect.result);
            expect(Result.isFailure(missingHistory) && missingHistory.failure.reason).toBe(
              "boundary_unavailable",
            );
            expect(history.operations.size).toBe(0);
            history.seeds.set(seed.manifest.id, seed);
            const [a, b] = yield* Effect.all(
              [
                engine.forkSession({ actor: "asker", commandId: "fork-command", request }),
                engine.forkSession({ actor: "asker", commandId: "fork-command", request }),
              ],
              { concurrency: 2 },
            );
            expect(a.id).toBe(b.id);
            const ready = yield* engine.forkSession({
              actor: "asker",
              commandId: "fork-command",
              request,
            });
            expect(ready.progress.kind).toBe("awaitingNative");
            const child = state.sessions.get(ready.intent.childSessionId);
            expect(child?.ownerUserId).toBe("asker");
            expect(child?.model).toBeNull();
            expect(child?.sharedControlEnabledAt).toBeNull();
            expect(child?.worktreeId).not.toBe(source.worktreeId);
            expect(
              fs.readFileSync(
                path.join(
                  worktreePathOf(project.storePath, child?.worktree ?? "missing"),
                  "app.ts",
                ),
                "utf8",
              ),
            ).toBe("selected response\n");
            expect(fs.readFileSync(path.join(sourcePath, "app.ts"), "utf8")).toBe(
              "later source files\n",
            );
            expect(turns[1]?.status).toBe("running");
            expect(
              history.forks.get(ready.intent.childSessionId)?.history.map((item) => item.input),
            ).toEqual(["first input"]);
            expect(turns.filter((item) => item.sessionId === ready.intent.childSessionId)).toEqual(
              [],
            );
            const conflict = yield* engine
              .forkSession({
                actor: "asker",
                commandId: "fork-command",
                request: { ...request, title: "different" },
              })
              .pipe(Effect.result);
            expect(Result.isFailure(conflict) && conflict.failure.reason).toBe("command_conflict");
            // The durable state after a crash between child persistence and the receipt transition.
            // A second engine must recover that child, even after the source is deleted.
            const interrupted = { ...ready, progress: { kind: "preparing" } } as const;
            history.operations.set(ready.id, interrupted);
            const retained = history.forks.get(ready.intent.childSessionId);
            if (retained === undefined) throw new Error("retained fork missing");
            history.forks.set(ready.intent.childSessionId, { ...retained, operation: interrupted });
            state.sessions.delete(source.id);
            return ready;
          }),
        options,
      );
      await withEngine(
        () =>
          Effect.gen(function* () {
            const replay = yield* (yield* SessionEngine).forkSession({
              actor: "asker",
              commandId: receipt.commandId,
              request: receipt.request,
            });
            expect(replay.intent.childSessionId).toBe(receipt.intent.childSessionId);
            expect(replay.progress.kind).toBe("awaitingNative");
            expect(history.seeds.size).toBe(1);
            const kept = history.forks.get(receipt.intent.childSessionId);
            if (kept === undefined) throw new Error("retained child missing");
            const native = history.seeds.get(kept.provenance.sourceNativeSeedId);
            expect(
              native?.files.find((file) => file.relativePath === ".claude/plans/selected.md")
                ?.content,
            ).toBe("Selected plan");
            expect(native?.files.some((file) => file.content === "Selected output")).toBe(true);
          }),
        options,
      );
    } finally {
      fs.readdirSync(tmp);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
