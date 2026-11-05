import {
  AgentTurnId,
  OrganizationId,
  ProjectId,
  WorktreeId,
  CheckpointId as MendCheckpointId,
  SealantRunId,
  SessionId,
  Sha,
} from "@mend/domain";
import {
  RollbackOperation,
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
} from "@mend/t3-contracts";
import { Effect, Schema } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("checkpoint.rollback through the pinned client RPC", () => {
  it.live("accepts an exact retained checkpoint without sending another user turn", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const wb = mend.workbench;
        wb.addProject("project-1", "Mend");
        wb.addSession({ id: "source", projectId: "project-1", harness: "codex" });
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
                anchor: { kind: "turn", turnId: AgentTurnId.make(kept.id) },
                checkpointId: MendCheckpointId.make("retained-checkpoint"),
                checkpointSha: Sha.make("b".repeat(40)),
                nativeSeedId: NativeSeedId.make("retained-seed"),
                selection: {
                  harness: "codex",
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
        wb.rollbackResponse = (id, payload) => {
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
              restoreFiles: true,
              removedTurnIds: [AgentTurnId.make(wb.turns.get(id)?.[1]?.id ?? "missing")],
              candidateKey: "replacement",
            },
            progress: {
              kind: "complete",
              result: {
                recoveryId: RollbackRecoveryId.make("recovery"),
                targetBoundaryId: request.at.boundaryId,
                position: { historyRevision: 1, worktreeEpoch: 1 },
                files: "restored",
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
            if (turn.ordinal > kept.ordinal) turn.withdrawnHistoryRevision = 1;
          wb.nativeHistories.set(
            id,
            Schema.encodeSync(Schema.toCodecJson(SessionHistoryView))({
              ...history,
              position: { historyRevision: 1, worktreeEpoch: 1 },
              providerSessionId: "replacement-native",
              rollback: operation,
            }),
          );
          return Schema.encodeSync(Schema.toCodecJson(RollbackOperation))(operation);
        };
        const { rpc } = yield* pairAndConnect(mend, "ROLLBACK");
        const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "checkpoint.rollback",
          commandId: CommandId.make("rollback-command"),
          threadId: ThreadId.make("source"),
          scopeId: CheckpointScopeId.make("scope:source"),
          checkpointId: CheckpointId.make("boundary:retained-boundary"),
        }).pipe(Effect.result);
        assert.strictEqual(result._tag, "Success", JSON.stringify(result));
        assert.lengthOf(wb.turns.get("source") ?? [], 2);
        const projected = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("source"),
        });
        assert.deepEqual(
          projected.runs.map((run) => run.status),
          ["completed", "rolled_back"],
        );
        assert.deepEqual(
          projected.attempts.map((attempt) => attempt.status),
          ["completed", "completed"],
        );
        assert.deepEqual(
          projected.providerTurns.map((turn) => turn.status),
          ["completed", "completed"],
        );
        assert.strictEqual(projected.providerThreads[0]?.lastRunOrdinal, 1);
        assert.strictEqual(
          projected.providerThreads[0]?.nativeThreadRef?.nativeId,
          "replacement-native",
        );
        assert.strictEqual(projected.thread.rollbackRequestId, "rollback-command");
        assert.isFalse(
          projected.visibleTurnItems.some(
            (row) => row.item.type === "user_message" && row.item.text === "Withdraw this context",
          ),
        );

        assert.lengthOf(
          wb.calls.filter((call) => call.method === "POST" && /\/(launch|turns)$/.test(call.path)),
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
