import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
} from "@mend/t3-contracts";
import { Effect } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("merge back through the pinned client command", () => {
  it.live(
    "saves selected fork context without starting a parent turn or changing files",
    () =>
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
          const selected = wb.addTurn(
            "child",
            "remember the fork result",
            "completed",
          );
          wb.addItem(selected, {
            kind: "assistant-message",
            text: "the marker is amber",
          });
          wb.mergeBackResponse = () => ({
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
          });
          const { rpc } = yield* pairAndConnect(mend, "MERGE-BACK");
          const result = yield* rpc[
            ORCHESTRATION_V2_WS_METHODS.dispatchCommand
          ]({
            type: "thread.merge_back",
            commandId: CommandId.make("merge-command"),
            sourceThreadId: ThreadId.make("child"),
            targetThreadId: ThreadId.make("parent"),
            sourcePoint: { type: "run", runId: RunId.make(selected.id) },
            createdBy: "user",
            creationSource: "web",
          }).pipe(Effect.result);
          assert.strictEqual(result._tag, "Success");
          assert.deepStrictEqual(
            wb.calls.find((call) => call.path.endsWith("/merge-backs"))?.body,
            {
              commandId: "merge-command",
              targetSessionId: "parent",
              at: { kind: "turn", turnId: selected.id },
            },
          );
          assert.lengthOf(
            wb.calls.filter(
              (call) =>
                call.method === "POST" &&
                /\/(launch|turns|messages)$/.test(call.path),
            ),
            0,
          );
          assert.lengthOf(wb.turns.get("parent") ?? [], 0);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );
});
