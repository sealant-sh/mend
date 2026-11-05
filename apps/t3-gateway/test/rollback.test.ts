import {
  AgentTurnId,
  CheckpointId as MendCheckpointId,
  SealantRunId,
  SessionId,
  Sha,
} from "@mend/domain";
import { NativeSeedId, SessionHistoryView, TurnBoundaryId } from "@mend/domain/workbench";
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
        assert.lengthOf(
          wb.calls.filter((call) => call.method === "POST" && /\/(launch|turns)$/.test(call.path)),
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
