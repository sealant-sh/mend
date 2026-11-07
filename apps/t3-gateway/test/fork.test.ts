import {
  AgentTurnId,
  CheckpointId,
  OrganizationId,
  ProjectId,
  SealantRunId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  ForkOperation,
  HistoryOperationId,
  NativeSeedId,
  SessionHistoryView,
  TurnBoundaryId,
} from "@mend/domain/workbench";
import {
  CommandId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import { Effect, Schema } from "effect";

import { threadLineageOf } from "../src/fork-history.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { applyOrchestrationV2ProjectionEvent } from "./support/upstream/steering-client.mjs";

const encodeView = Schema.encodeSync(Schema.toCodecJson(SessionHistoryView));
const encodeOperation = Schema.encodeSync(Schema.toCodecJson(ForkOperation));
const selection = {
  harness: "claude",
  model: null,
  effort: null,
  interactionMode: "plan",
} as const;
const evidence = (turnId: string) => {
  const now = new Date();
  const sourceSessionId = SessionId.make("source");
  const childSessionId = SessionId.make("child-session");
  const id = TurnBoundaryId.make("exact-selected-boundary");
  const boundary = {
    id,
    sessionId: sourceSessionId,
    revision: 0,
    anchor: { kind: "turn", turnId: AgentTurnId.make(turnId) },
    checkpointId: CheckpointId.make("selected-checkpoint"),
    checkpointSha: Sha.make("b".repeat(40)),
    nativeSeedId: NativeSeedId.make("retained-seed"),
    selection,
    gitHead: Sha.make("a".repeat(40)),
    reviewBase: { sha: Sha.make("a".repeat(40)), ref: "main" },
    repositorySeed: null,
    observedAt: now,
    nativeObservedAt: now,
    record: { runId: SealantRunId.make("source-run"), seq: 20n },
  } as const;
  const operation: ForkOperation = {
    id: HistoryOperationId.make("fork-op"),
    organizationId: OrganizationId.make("org-1"),
    actorId: "user-1",
    commandId: "fork-command",
    intentDigest: "a".repeat(64),
    request: {
      sourceSessionId,
      at: { kind: "turn", turnId: AgentTurnId.make(turnId) },
      title: null,
      clientTarget: "client-child",
      clientSource: "source",
    },
    intent: {
      kind: "fork",
      projectId: ProjectId.make("project-1"),
      title: "Fork of source",
      sourceBoundaryId: id,
      childSessionId,
      childWorktreeId: WorktreeId.make("child-worktree"),
    },
    progress: { kind: "awaitingNative" },
    createdAt: now,
    updatedAt: now,
  };
  const childView: SessionHistoryView = {
    observations: [],
    fork: {
      operation,
      provenance: {
        childSessionId,
        sourceSessionId,
        rootSessionId: sourceSessionId,
        sourceBoundaryId: id,
        sourceTurnId: AgentTurnId.make(turnId),
        sourceCheckpointId: boundary.checkpointId,
        sourceNativeSeedId: boundary.nativeSeedId,
        inheritedViewDigest: "b".repeat(64),
        requestedBy: "user-1",
        requestedAt: now,
      },
      history: [
        {
          sourceSessionId,
          sourceTurnId: AgentTurnId.make(turnId),
          ordinal: 0,
          author: "source-owner",
          input: "first input",
          status: "completed",
          selection,
          createdAt: now,
          endedAt: now,
          items: [
            {
              id: "source-answer",
              kind: "assistant-message",
              status: "completed",
              title: null,
              text: "selected answer",
            },
          ],
        },
      ],
    },
  };
  return {
    operation,
    childView,
    sourceView: {
      observations: [{ kind: "ready", boundary }],
      fork: null,
    } satisfies SessionHistoryView,
  };
};

describe("thread.fork through the client command and API", () => {
  it.live(
    "streams Fork capabilities when the first completed response's boundary is retained",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        yield* Effect.gen(function* () {
          const wb = mend.workbench;
          wb.addProject("project-1", "Mend");
          wb.addSession({ id: "source", projectId: "project-1", harness: "claude" });
          const selected = wb.addTurn("source", "first input", "completed");
          wb.addItem(selected, { kind: "assistant-message", text: "selected answer" });
          const { rpc } = yield* pairAndConnect(mend, "FORK-READINESS");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("source"),
            }),
          );
          type Item = OrchestrationV2ThreadStreamItem;
          const initial = yield* thread.next(
            (item): item is Extract<Item, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          assert.strictEqual(initial.projection.runs[0]?.status, "completed");
          assert.isFalse(
            initial.projection.providerSessions[0]?.capabilities.threads.canForkThread,
          );
          assert.isFalse(
            initial.projection.providerSessions[0]?.capabilities.threads.canForkFromTurn,
          );

          yield* Effect.promise(() => wb.waitForEventStream());
          wb.nativeHistories.set("source", encodeView(evidence(selected.id).sourceView));
          wb.emit({ type: "session", sessionId: "source", projectId: "project-1" });
          const ready = yield* thread.next(
            (item): item is Extract<Item, { kind: "event" }> =>
              item.kind === "event" &&
              item.event.type === "provider-session.updated" &&
              item.event.payload.capabilities.threads.canForkFromTurn,
          );
          const projection = applyOrchestrationV2ProjectionEvent(initial.projection, ready.event);
          assert.isTrue(projection.providerSessions[0]?.capabilities.threads.canForkThread);
          assert.isTrue(projection.providerSessions[0]?.capabilities.threads.canForkFromTurn);
          assert.strictEqual(projection.runs[0]?.status, "completed");
          assert.lengthOf(wb.turns.get("source") ?? [], 1);
          assert.lengthOf(
            wb.calls.filter(
              (call) => call.method === "POST" && /\/(launch|turns)$/.test(call.path),
            ),
            0,
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );

  it("keeps the source client thread and run identities in fork navigation", () => {
    const kept = evidence("native-turn");
    const lineage = threadLineageOf(ThreadId.make("client-child"), kept.childView, {
      source: ThreadId.make("client-source"),
      root: ThreadId.make("client-root"),
      sourceRun: RunId.make("client-run"),
    });
    assert.strictEqual(lineage.lineage.parentThreadId, "client-source");
    assert.strictEqual(
      lineage.forkedFrom?.type === "run" ? lineage.forkedFrom.runId : null,
      "client-run",
    );
  });

  it.live("keeps old responses visible but refuses an unprovable cutoff without a child", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const wb = mend.workbench;
        wb.addProject("project-1", "Mend");
        wb.addSession({ id: "old-source", projectId: "project-1", harness: "claude" });
        const selected = wb.addTurn("old-source", "old input", "completed");
        wb.addItem(selected, { kind: "assistant-message", text: "old answer" });
        const { rpc, access, client } = yield* pairAndConnect(mend, "OLD-FORK");
        const headers = {
          authorization: `Bearer ${access.access_token}`,
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        } as const;
        const source = yield* client.orchestration.threadBoundedSnapshot({
          headers,
          params: { threadId: ThreadId.make("old-source") },
          query: {},
        });
        assert.isFalse(source.projection.providerSessions[0]?.capabilities.threads.canForkFromTurn);
        assert.isTrue(
          source.projection.visibleTurnItems.some(
            (row) => "text" in row.item && row.item.text === "old answer",
          ),
        );
        const refused = yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
          type: "thread.fork",
          commandId: CommandId.make("unprovable-command"),
          sourceThreadId: ThreadId.make("old-source"),
          targetThreadId: ThreadId.make("no-child"),
          sourcePoint: { type: "run", runId: RunId.make(selected.id) },
          createdBy: "user",
          creationSource: "web",
        }).pipe(Effect.result);
        assert.isTrue(refused._tag === "Failure");
        assert.lengthOf([...wb.sessions.values()], 1);
        assert.lengthOf(
          wb.calls.filter((call) => call.method === "POST" && /\/(launch|turns)$/.test(call.path)),
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "opens one child with immutable Plan/default choices and inherited evidence, without launching or touching the later source turn",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        yield* Effect.gen(function* () {
          const wb = mend.workbench;
          wb.addProject("project-1", "Mend");
          wb.addSession({
            id: "source",
            projectId: "project-1",
            harness: "claude",
            permissionMode: "ask",
          });
          const selected = wb.addTurn("source", "first input", "completed");
          wb.addItem(selected, { kind: "assistant-message", text: "selected answer" });
          const later = wb.addTurn("source", "later input", "running");
          const kept = evidence(selected.id);
          wb.nativeHistories.set("source", encodeView(kept.sourceView));
          wb.forkResponse = () => {
            if (!wb.sessions.has("child-session"))
              wb.addSession({ id: "child-session", projectId: "project-1", harness: "claude" });
            wb.nativeHistories.set("child-session", encodeView(kept.childView));
            return encodeOperation(kept.operation);
          };
          const { rpc, access, client } = yield* pairAndConnect(mend, "FORK");
          const headers = {
            authorization: `Bearer ${access.access_token}`,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          } as const;
          const source = yield* client.orchestration.threadBoundedSnapshot({
            headers,
            params: { threadId: ThreadId.make("source") },
            query: {},
          });
          assert.isTrue(
            source.projection.providerSessions[0]?.capabilities.threads.canForkFromTurn,
          );
          const command = {
            type: "thread.fork",
            commandId: CommandId.make("fork-command"),
            sourceThreadId: ThreadId.make("source"),
            targetThreadId: ThreadId.make("client-child"),
            sourcePoint: { type: "run", runId: RunId.make(selected.id) },
            createdBy: "user",
            creationSource: "web",
          } as const;
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
          const child = yield* client.orchestration.threadBoundedSnapshot({
            headers,
            params: { threadId: ThreadId.make("client-child") },
            query: {},
          });
          assert.strictEqual(child.projection.thread.lineage.parentThreadId, "source");
          assert.strictEqual(child.projection.thread.lineage.relationshipToParent, "fork");
          assert.strictEqual(child.projection.thread.interactionMode, "plan");
          assert.deepStrictEqual(
            child.projection.visibleTurnItems
              .filter((row) => row.visibility === "inherited")
              .map((row) => [row.visibility, "text" in row.item ? row.item.text : null]),
            [
              ["inherited", "first input"],
              ["inherited", "selected answer"],
            ],
          );
          assert.isTrue(
            child.projection.visibleTurnItems.some(
              (row) =>
                row.item.type === "system_notice" && row.item.message.includes("first message"),
            ),
          );
          assert.strictEqual(
            child.projection.visibleTurnItems.find(
              (row) => row.visibility === "inherited" && row.item.type === "assistant_message",
            )?.sourceItemId,
            "source-answer",
          );
          assert.lengthOf(child.projection.runs, 0);
          assert.lengthOf(child.projection.attempts, 0);
          assert.lengthOf(child.projection.providerTurns, 0);
          assert.strictEqual(
            wb.turns.get("source")?.find((turn) => turn.id === later.id)?.status,
            "running",
          );
          assert.lengthOf(
            wb.calls.filter(
              (call) => call.method === "POST" && /\/(launch|turns)$/.test(call.path),
            ),
            0,
          );
          assert.lengthOf(
            [...wb.sessions.values()].filter((session) => session.id === "child-session"),
            1,
          );
          assert.deepStrictEqual(
            wb.calls.find((call) => call.method === "POST" && call.path.endsWith("/forks"))?.body,
            {
              commandId: "fork-command",
              at: { kind: "turn", turnId: selected.id },
              title: null,
              clientTarget: "client-child",
              clientSource: "source",
            },
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );
});
