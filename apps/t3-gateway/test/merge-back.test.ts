import { CommandId, ORCHESTRATION_V2_WS_METHODS, RunId, ThreadId } from "@mend/t3-contracts";
import { Effect } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("merge back through the pinned client command", () => {
  it.live("saves selected fork context without starting a parent turn or changing files", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const wb = mend.workbench;
        wb.addProject("project-1", "Mend");
        wb.addSession({
          id: "parent",
          projectId: "project-1",
          harness: "codex",
        });
        wb.addSession({
          id: "child",
          projectId: "project-1",
          harness: "codex",
        });
        const selected = wb.addTurn("child", "remember the fork result", "completed");
        wb.addItem(selected, {
          kind: "assistant-message",
          text: "the marker is amber",
        });
        const transfer = {
          id: "transfer-1",
          commandId: "merge-command",
          requestedBy: "user-1",
          sourceSessionId: "child",
          targetSessionId: "parent",
          at: { kind: "turn", turnId: selected.id },
          sourceTurnId: selected.id,
          sourceOrdinal: selected.ordinal,
          sourceRevision: 0,
          summary: "the marker is amber",
          createdAt: new Date().toISOString(),
          state: { kind: "pending" },
        };
        wb.mergeBackResponse = () => {
          wb.nativeHistories.set("parent", { observations: [], fork: null, mergeBack: [transfer] });
          return transfer;
        };
        const { rpc } = yield* pairAndConnect(mend, "MERGE-BACK");
        const result = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.merge_back",
          commandId: CommandId.make("merge-command"),
          sourceThreadId: ThreadId.make("child"),
          targetThreadId: ThreadId.make("parent"),
          sourcePoint: { type: "run", runId: RunId.make(selected.id) },
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.result);
        assert.strictEqual(result._tag, "Success");
        assert.deepStrictEqual(wb.calls.find((call) => call.path.endsWith("/merge-backs"))?.body, {
          commandId: "merge-command",
          targetSessionId: "parent",
          at: { kind: "turn", turnId: selected.id },
        });
        assert.lengthOf(
          wb.calls.filter(
            (call) => call.method === "POST" && /\/(launch|turns|messages)$/.test(call.path),
          ),
          0,
        );
        assert.lengthOf(wb.turns.get("parent") ?? [], 0);
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("parent"),
        });
        assert.strictEqual(projection.contextTransfers[0]?.status, "pending");
        assert.strictEqual(projection.contextTransfers[0]?.sourceThreadId, "child");
        assert.lengthOf(projection.contextHandoffs, 0);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
  it.live("reloads consumed context as a handoff without changing the visible message", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const wb = mend.workbench;
        wb.addProject("project-1", "Mend");
        wb.addSession({ id: "parent", projectId: "project-1", harness: "codex" });
        const turn = wb.addTurn("parent", "use the result", "completed");
        const at = new Date().toISOString();
        wb.nativeHistories.set("parent", {
          observations: [],
          fork: null,
          mergeBack: [
            {
              id: "saved-transfer",
              sourceSessionId: "deleted-child",
              targetSessionId: "parent",
              commandId: "saved-command",
              requestedBy: "user-1",
              at: { kind: "latestStable" },
              sourceTurnId: "child-turn",
              sourceOrdinal: 0,
              sourceRevision: 0,
              summary: "amber is the fork result",
              createdAt: at,
              state: { kind: "consumed", turnId: turn.id, consumedAt: at },
            },
          ],
        });
        const { rpc } = yield* pairAndConnect(mend, "MERGE-RELOAD");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("parent"),
        });
        assert.strictEqual(projection.contextTransfers[0]?.status, "consumed");
        assert.strictEqual(projection.contextHandoffs[0]?.summaryText, "amber is the fork result");
        assert.strictEqual(projection.contextHandoffs[0]?.targetRunId, turn.id);
        assert.strictEqual(projection.runs[0]?.contextHandoffId, projection.contextHandoffs[0]?.id);
        assert.strictEqual(
          projection.turnItems.find((item) => item.type === "handoff")?.type,
          "handoff",
        );
        assert.deepStrictEqual(
          projection.messages.map((message) => message.text),
          ["use the result"],
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
