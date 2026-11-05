import {
  AgentTurnId,
  OrganizationId,
  ProjectId,
  WorktreeId,
  CheckpointId as MendCheckpointId,
  SealantRunId,
  SessionProcessId,
  SessionId,
  Sha,
} from "@mend/domain";
import {
  RollbackOperation,
  AgentTurn,
  RollbackRequest,
  RollbackRecoveryId,
  HistoryOperationId,
  NativeSeedId,
  SessionHistoryView,
  TurnBoundaryId,
} from "@mend/domain/workbench";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import { Effect, Schema, Option } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import {
  rollbackWaiter,
  findRevertCheckpoint,
  deriveRevertTurnCountByUserMessageId,
} from "./support/upstream/rollback-client.mjs";
import { applyOrchestrationV2ProjectionEvent } from "./support/upstream/steering-client.mjs";

const noInspect = () => {};

describe("checkpoint.rollback through the pinned client RPC", () => {
  for (const scenario of [
    { harness: "codex", count: 1, restoreFiles: undefined },
    { harness: "claude", count: 0, restoreFiles: false },
  ] as const)
    it.live(
      `accepts ${scenario.harness} checkpoint ${scenario.count} without another user turn`,
      () =>
        Effect.gen(function* () {
          const mend = yield* startFakeMend;
          yield* Effect.gen(function* () {
            const wb = mend.workbench;
            wb.addProject("project-1", "Mend");
            wb.addSession({ id: "source", projectId: "project-1", harness: scenario.harness });
            const kept = wb.addTurn("source", "Keep this context", "completed");
            wb.addItem(kept, { kind: "assistant-message", text: "Retained answer" });
            wb.addTurn("source", "Withdraw this context", "completed");
            const observedAt = new Date();
            const history: SessionHistoryView = {
              position: { historyRevision: 0, worktreeEpoch: 0 },
              observations: [
                {
                  kind: "ready",
                  boundary: {
                    id: TurnBoundaryId.make("retained-boundary"),
                    sessionId: SessionId.make("source"),
                    revision: 0,
                    anchor:
                      scenario.count === 0
                        ? { kind: "threadStart" }
                        : { kind: "turn", turnId: AgentTurnId.make(kept.id) },
                    checkpointId: MendCheckpointId.make("retained-checkpoint"),
                    checkpointSha: Sha.make("b".repeat(40)),
                    nativeSeedId: NativeSeedId.make("retained-seed"),
                    selection: {
                      harness: scenario.harness,
                      model: null,
                      effort: null,
                      interactionMode: "default",
                    },
                    gitHead: Sha.make("a".repeat(40)),
                    reviewBase: { sha: Sha.make("a".repeat(40)), ref: "main" },
                    repositorySeed: null,
                    observedAt,
                    nativeObservedAt: observedAt,
                    record: { runId: SealantRunId.make("source-run"), seq: 20n },
                  },
                },
              ],
              fork: null,
            };
            wb.nativeHistories.set(
              "source",
              Schema.encodeSync(Schema.toCodecJson(SessionHistoryView))(history),
            );
            let receipt: RollbackOperation | null = null;
            wb.rollbackResponse = (id, payload) => {
              if (receipt !== null)
                return Schema.encodeSync(Schema.toCodecJson(RollbackOperation))(receipt);
              const request = Schema.decodeUnknownSync(RollbackRequest)({
                ...(payload !== null && typeof payload === "object" ? payload : {}),
                sessionId: id,
              });
              const operation: RollbackOperation = {
                id: HistoryOperationId.make("operation"),
                organizationId: OrganizationId.make("org"),
                actorId: "user-1",
                commandId: "rollback-command",
                intentDigest: "a".repeat(64),
                request,
                intent: {
                  kind: "rollback",
                  sessionId: SessionId.make(id),
                  projectId: ProjectId.make("project-1"),
                  worktreeId: WorktreeId.make("worktree"),
                  targetBoundaryId: request.at.boundaryId,
                  from: request.expected,
                  toRevision: 1,
                  restoreFiles: scenario.restoreFiles ?? true,
                  removedTurnIds: (wb.turns.get(id) ?? [])
                    .filter((t) => t.ordinal >= scenario.count)
                    .map((t) => AgentTurnId.make(t.id)),
                  candidateKey: "replacement",
                },
                progress: {
                  kind: "complete",
                  result: {
                    recoveryId: RollbackRecoveryId.make("recovery"),
                    targetBoundaryId: request.at.boundaryId,
                    position: { historyRevision: 1, worktreeEpoch: 1 },
                    files: scenario.restoreFiles === false ? "unchanged" : "restored",
                    native: "replaced",
                    publishedAt: new Date(),
                  },
                },
                version: 6,
                generation: 1,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
              for (const turn of wb.turns.get(id) ?? [])
                if (turn.ordinal >= scenario.count) turn.withdrawnHistoryRevision = 1;
              wb.nativeHistories.set(
                id,
                Schema.encodeSync(Schema.toCodecJson(SessionHistoryView))({
                  ...history,
                  position: { historyRevision: 1, worktreeEpoch: 1 },
                  providerSessionId: "replacement-native",
                  rollback: operation,
                  turns: (wb.turns.get(id) ?? []).map(
                    (turn) =>
                      new AgentTurn({
                        id: AgentTurnId.make(turn.id),
                        sessionId: SessionId.make(id),
                        processId: SessionProcessId.make("source-process"),
                        ordinal: turn.ordinal,
                        author: turn.author,
                        input: turn.input,
                        status: turn.status,
                        providerTurnId: turn.providerTurnId,
                        error: turn.error,
                        usage: null,
                        selection: turn.selection,
                        createdAt: new Date(turn.createdAt),
                        startedAt: turn.startedAt === null ? null : new Date(turn.startedAt),
                        endedAt: turn.endedAt === null ? null : new Date(turn.endedAt),
                        withdrawnHistoryRevision: turn.withdrawnHistoryRevision ?? null,
                      }),
                  ),
                }),
              );
              receipt = operation;
              return Schema.encodeSync(Schema.toCodecJson(RollbackOperation))(operation);
            };
            const { rpc } = yield* pairAndConnect(mend, "ROLLBACK");
            const stream = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: ThreadId.make("source"),
              }),
            );
            const initial = yield* stream.next(
              (item): item is Extract<OrchestrationV2ThreadStreamItem, { kind: "snapshot" }> =>
                item.kind === "snapshot",
            );
            let live: OrchestrationV2ThreadProjection = initial.projection;
            assert.strictEqual(
              live.providerSessions[0]?.capabilities.threads.canRollbackThread,
              true,
            );
            assert.strictEqual(
              live.providerSessions[0]?.capabilities.checkpointing.providerCanRollbackConversation,
              true,
            );
            let current = live;
            let inspect = noInspect;
            let requested = 0;
            const wait = rollbackWaiter({
              environmentThreadDetails: { stateAtom: () => null },
              appAtomRegistry: {
                get: () => ({ data: Option.some(current) }),
                subscribe: (_atom, listener) => {
                  inspect = listener;
                  return () => {};
                },
              },
              Option,
            });
            for (const invalid of [
              { scopeId: "scope:other", checkpointId: "boundary:retained-boundary" },
              { scopeId: "scope:source", checkpointId: "timestamp-diff-card" },
            ]) {
              const denied = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "checkpoint.rollback",
                commandId: CommandId.make("invalid"),
                threadId: ThreadId.make("source"),
                scopeId: CheckpointScopeId.make(invalid.scopeId),
                checkpointId: CheckpointId.make(invalid.checkpointId),
              }).pipe(Effect.result);
              assert.strictEqual(denied._tag, "Failure");
            }
            assert.lengthOf(
              wb.calls.filter((c) => c.method === "POST" && c.path.endsWith("/rollbacks")),
              0,
            );
            const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "checkpoint.rollback",
              commandId: CommandId.make("rollback-command"),
              threadId: ThreadId.make("source"),
              scopeId: CheckpointScopeId.make("scope:source"),
              checkpointId: CheckpointId.make("boundary:retained-boundary"),
              ...(scenario.restoreFiles === undefined
                ? {}
                : { restoreFiles: scenario.restoreFiles }),
            }).pipe(Effect.result);
            assert.strictEqual(result._tag, "Success", JSON.stringify(result));
            assert.lengthOf(wb.turns.get("source") ?? [], 2);
            let projected = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make("source"),
            });
            const witnessed = wait(
              null,
              scenario.count,
              "rollback-command",
              async () => {
                await Effect.runPromise(
                  stream.next((item): item is OrchestrationV2ThreadStreamItem => {
                    if (item.kind === "snapshot") live = item.projection;
                    if (item.kind === "event") {
                      if (item.event.type === "checkpoint.rollback-requested") {
                        requested++;
                        assert.strictEqual(
                          item.event.payload.checkpointId,
                          "boundary:retained-boundary",
                        );
                      }
                      live = applyOrchestrationV2ProjectionEvent(live, item.event);
                    }
                    current = live;
                    inspect();
                    return (
                      live.runs.some((run) => run.status === "rolled_back") &&
                      live.providerThreads[0]?.lastRunOrdinal ===
                        (scenario.count === 0 ? null : scenario.count) &&
                      !live.visibleTurnItems.some(
                        (row) =>
                          row.item.type === "user_message" &&
                          row.item.text === "Withdraw this context",
                      )
                    );
                  }),
                );
              },
              1000,
            );
            yield* Effect.promise(() => witnessed);
            projected = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make("source"),
            });
            assert.strictEqual(requested, 1);
            assert.deepEqual(live.runs, projected.runs);
            assert.deepEqual(live.providerThreads, projected.providerThreads);
            assert.strictEqual(
              findRevertCheckpoint(projected.checkpoints, scenario.count)?.id,
              "boundary:retained-boundary",
            );
            const undo = deriveRevertTurnCountByUserMessageId({
              timelineEntries: projected.visibleTurnItems.flatMap((row) =>
                row.item.type === "user_message"
                  ? [
                      {
                        kind: "message" as const,
                        projectedItem: { visibility: row.visibility },
                        message: {
                          id: row.item.messageId ?? row.item.id,
                          role: "user" as const,
                          runId: row.item.runId,
                          inputIntent: row.item.inputIntent,
                        },
                      },
                    ]
                  : [],
              ),
              checkpoints: [
                { runId: projected.runs[0]?.id ?? null, status: "ready", checkpointTurnCount: 1 },
              ],
              threadStartCheckpointReady: true,
            });
            assert.deepEqual([...undo.values()], scenario.count === 0 ? [] : [0]);
            assert.deepEqual(
              projected.runs.map((run) => run.status),
              scenario.count === 0 ? ["rolled_back", "rolled_back"] : ["completed", "rolled_back"],
            );
            assert.deepEqual(
              projected.attempts.map((attempt) => attempt.status),
              ["completed", "completed"],
            );
            assert.deepEqual(
              projected.providerTurns.map((turn) => turn.status),
              ["completed", "completed"],
            );
            assert.strictEqual(
              projected.providerThreads[0]?.lastRunOrdinal,
              scenario.count === 0 ? null : scenario.count,
            );
            assert.strictEqual(
              projected.providerThreads[0]?.nativeThreadRef?.nativeId,
              "replacement-native",
            );
            assert.strictEqual(projected.thread.rollbackRequestId, "rollback-command");
            assert.isFalse(
              projected.visibleTurnItems.some(
                (row) =>
                  row.item.type === "user_message" && row.item.text === "Withdraw this context",
              ),
            );

            const replay = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
              type: "checkpoint.rollback",
              commandId: CommandId.make("rollback-command"),
              threadId: ThreadId.make("source"),
              scopeId: CheckpointScopeId.make("scope:source"),
              checkpointId: CheckpointId.make("boundary:retained-boundary"),
              restoreFiles: scenario.restoreFiles ?? true,
            }).pipe(Effect.result);
            assert.strictEqual(replay._tag, "Success");
            const reread = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
              threadId: ThreadId.make("source"),
            });
            assert.deepEqual(reread.runs, projected.runs);
            assert.strictEqual(reread.thread.rollbackRequestId, "rollback-command");
            assert.lengthOf(
              wb.calls.filter(
                (call) => call.method === "POST" && /\/(launch|turns)$/.test(call.path),
              ),
              0,
            );
          }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
        }),
    );
});
