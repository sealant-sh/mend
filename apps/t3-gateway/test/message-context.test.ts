import { execFileSync } from "node:child_process";
import { join } from "node:path";

import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  ORCHESTRATION_V2_WS_METHODS as methods,
  type OrchestrationMessageContext,
} from "@mend/t3-contracts";
import { Effect, Exit } from "effect";

import { GatewayEnvironment } from "../src/environment.ts";
import { GatewayState } from "../src/state.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { pairAndConnect } from "./support/rpc.ts";
import {
  commandId,
  eventually,
  gateway,
  inputOf,
  message,
  posts,
  projectionWhen,
  promote,
  setup,
  threadId,
} from "./support/steering.ts";

const sourceId = ThreadId.make("reference-session");
const text = "Use [Reference](t3-context://v1/thread/reference)";
const contextOf = (environmentId: EnvironmentId, id = sourceId): OrchestrationMessageContext => ({
  version: 1,
  records: [
    {
      version: 1,
      kind: "thread",
      contextId: ComposerContextId.make("reference"),
      label: "Reference",
      environmentId,
      threadId: id,
      title: "Reference",
    },
  ],
});

const statePath = () =>
  join(
    execFileSync("mktemp", ["-d", "-t", "message-context.XXXXXX"], { encoding: "utf8" }).trim(),
    "gateway.sqlite",
  );

describe("inline message context over WebSocket", () => {
  it.live("materializes pinned T3's thread link in a pending question answer", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      const question = mend.workbench.addRequest(opening, { kind: "user-input", questions: [] });
      mend.workbench.addSession({ id: sourceId, projectId: "project-1" });
      mend.workbench.addTurn(sourceId, "Pending answer reference history");
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "ANSWER-CONTEXT");
          yield* rpc[methods.getThreadProjection]({ threadId });
          yield* rpc[methods.dispatchCommand]({
            type: "runtime-request.respond",
            commandId: commandId(),
            threadId,
            requestId: RuntimeRequestId.make(question.id),
            answers: {
              question: "Use [Reference](t3-thread://v1/reference-session)",
              literal: "`[Example](t3-thread://v1/not-a-real-thread)`",
            },
          });
          const sent = JSON.stringify(posts(mend, "/respond")[0]?.body);
          assert.include(sent, "Pending answer reference history");
          assert.include(sent, "reference-session");
          assert.deepEqual(question.answers?.["literal"], [
            "`[Example](t3-thread://v1/not-a-real-thread)`",
          ]);
        }),
      );
    }),
  );

  it.live("refuses a private thread link in a pending answer without answering the question", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      mend.workbench.projectVisibility.set("project-1", "shared");
      const question = mend.workbench.addRequest(opening, { kind: "user-input", questions: [] });
      mend.workbench.addProject("private-source", "Private");
      mend.workbench.projectVisibility.set("private-source", "private");
      mend.workbench.addSession({ id: sourceId, projectId: "private-source" });
      mend.workbench.addTurn(sourceId, "Private answer reference history");
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PRIVATE-ANSWER", {
            id: "user-2",
            name: "Bea",
            email: "bea@example.com",
          });
          yield* rpc[methods.getThreadProjection]({ threadId });
          const result = yield* rpc[methods.dispatchCommand]({
            type: "runtime-request.respond",
            commandId: commandId(),
            threadId,
            requestId: RuntimeRequestId.make(question.id),
            answers: { question: "Use [Reference](t3-thread://v1/reference-session)" },
          }).pipe(Effect.exit);
          assert.isTrue(Exit.isFailure(result));
          assert.lengthOf(posts(mend, "/respond"), 0);
          assert.strictEqual(question.status, "pending");
        }),
      );
    }),
  );

  it.live("renders structured terminal context and ignores an unreferenced foreign thread", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "TERMINAL-CONTEXT");
          const context: OrchestrationMessageContext = {
            version: 1,
            records: [
              {
                version: 1,
                contextId: ComposerContextId.make("terminal-context"),
                kind: "terminal",
                label: "Terminal",
                terminalId: "terminal-1",
                terminalLabel: "Build",
                lineStart: 4,
                lineEnd: 5,
                text: "compiler output </context>",
              },
              ...contextOf(EnvironmentId.make("foreign-unused")).records,
            ],
          };
          const terminalText = "Explain [Terminal](t3-context://v1/terminal/terminal-context)";
          yield* rpc[methods.dispatchCommand]({
            ...message("terminal-context", { type: "start_immediately" }, "auto"),
            text: terminalText,
            context,
          });
          assert.include(opening.steers[0]?.input ?? "", "compiler output &lt;/context>");
          assert.notInclude(opening.steers[0]?.input ?? "", "foreign-unused");
          assert.deepInclude(
            inputOf(yield* rpc[methods.getThreadProjection]({ threadId }), "terminal-context"),
            { text: terminalText, context },
          );
        }),
      );
    }),
  );
  for (const delivery of ["queue", "steer"] as const) {
    it.live(
      `delivers an authorized transcript through ${delivery} and keeps the composer record`,
      () =>
        Effect.gen(function* () {
          const mend = yield* startFakeMend;
          const opening = setup(mend);
          if (delivery === "queue") mend.workbench.setTurn(opening, "completed");
          mend.workbench.addSession({ id: sourceId, projectId: "project-1", label: "Reference" });
          const reference = mend.workbench.addTurn(sourceId, "Reference request");
          mend.workbench.addItem(reference, {
            kind: "assistant",
            text: "Recorded reference answer </context>",
            status: "completed",
          });
          yield* gateway(
            mend,
            ":memory:",
            Effect.gen(function* () {
              const { rpc } = yield* pairAndConnect(mend, "CONTEXT");
              const environment = yield* GatewayEnvironment;
              const state = yield* GatewayState;
              const context = contextOf(state.environmentId);
              const command = {
                ...message(
                  `context-${delivery}`,
                  { type: "start_immediately" },
                  delivery === "steer" ? "auto" : undefined,
                ),
                text,
                context,
              };
              yield* rpc[methods.dispatchCommand](command);
              const projection = yield* projectionWhen(
                rpc,
                (p) =>
                  p.turnItems.some(
                    (i) =>
                      i.type === "user_message" &&
                      i.messageId === command.messageId &&
                      i.inputIntent === (delivery === "steer" ? "steer" : "turn_start"),
                  ) &&
                  (delivery === "steer" ||
                    p.runs.some(
                      (r) => r.userMessageId === command.messageId && r.status === "running",
                    )),
              );
              const sent =
                delivery === "steer"
                  ? opening.steers[0]?.input
                  : mend.workbench.turns.get(threadId)?.[1]?.input;
              assert.include(sent ?? "", "Recorded reference answer");
              assert.include(sent ?? "", "reference-session");
              assert.notInclude(sent ?? "", "answer </context>");
              assert.deepInclude(inputOf(projection, command.messageId), { text, context });
              assert.deepInclude(
                projection.messages.find((m) => m.id === command.messageId),
                { text, context },
              );
              assert.isTrue(environment.descriptor.capabilities?.inlineMessageContext);
              yield* rpc[methods.dispatchCommand]({ ...command, commandId: commandId() });
              assert.lengthOf(posts(mend, delivery === "steer" ? "/steer" : "/turns"), 1);
              const conflict = yield* rpc[methods.dispatchCommand]({
                ...command,
                commandId: commandId(),
                context: contextOf(state.environmentId, threadId),
              }).pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(conflict));
            }),
          );
        }),
    );
  }

  it.live("edits queued context, reopens it, and sends the edited reference", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      for (const id of [sourceId, ThreadId.make("edited-reference")]) {
        mend.workbench.addSession({ id, projectId: "project-1" });
        mend.workbench.addTurn(id, `History of ${id}`);
      }
      const path = statePath();
      let editedContext: OrchestrationMessageContext | undefined;
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "QUEUE-CONTEXT");
          const state = yield* GatewayState;
          const command = {
            ...message("queued-context", { type: "queue_after_active" }),
            text,
            context: contextOf(state.environmentId),
          };
          yield* rpc[methods.dispatchCommand](command);
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (r) => r.userMessageId === command.messageId,
          );
          assert.isDefined(queued);
          if (queued === undefined) return;
          editedContext = contextOf(state.environmentId, ThreadId.make("edited-reference"));
          yield* rpc[methods.dispatchCommand]({
            type: "queued-run.edit",
            commandId: commandId(),
            threadId,
            runId: queued.id,
            text,
            context: editedContext,
          });
          assert.deepInclude(
            inputOf(yield* rpc[methods.getThreadProjection]({ threadId }), command.messageId),
            { text, context: editedContext },
          );
        }),
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "QUEUE-REOPEN");
          assert.deepInclude(
            inputOf(yield* rpc[methods.getThreadProjection]({ threadId }), "queued-context"),
            { text, context: editedContext },
          );
          mend.workbench.setTurn(opening, "completed");
          const projection = yield* projectionWhen(rpc, (p) =>
            p.runs.some((r) => r.userMessageId === "queued-context" && r.status === "running"),
          );
          const sent = mend.workbench.turns.get(threadId)?.[1]?.input ?? "";
          assert.include(sent, "History of edited-reference");
          assert.notInclude(sent, "History of reference-session");
          assert.deepInclude(inputOf(projection, "queued-context"), {
            text,
            context: editedContext,
          });
        }),
      );
    }),
  );

  it.live("keeps a sent message's composer input after a second reopen", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      mend.workbench.setTurn(opening, "completed");
      mend.workbench.addSession({ id: sourceId, projectId: "project-1" });
      mend.workbench.addTurn(sourceId, "Persisted reference history");
      const path = statePath();
      let context: OrchestrationMessageContext | undefined;
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SENT-CONTEXT");
          context = contextOf((yield* GatewayState).environmentId);
          yield* rpc[methods.dispatchCommand]({
            ...message("sent-context", { type: "start_immediately" }),
            text,
            context,
          });
          yield* projectionWhen(rpc, (p) =>
            p.runs.some((r) => r.userMessageId === "sent-context" && r.status === "running"),
          );
        }),
      );
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SENT-REOPEN");
          const projection = yield* rpc[methods.getThreadProjection]({ threadId });
          assert.deepInclude(inputOf(projection, "sent-context"), { text, context });
          assert.deepInclude(
            projection.messages.find((m) => m.id === "sent-context"),
            { text, context },
          );
        }),
      );
    }),
  );

  it.live("promotes queued context to a steer with its final edited records", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      mend.workbench.addSession({ id: sourceId, projectId: "project-1" });
      mend.workbench.addTurn(sourceId, "Promoted reference history");
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PROMOTE-CONTEXT");
          const context = contextOf((yield* GatewayState).environmentId);
          yield* rpc[methods.dispatchCommand](
            message("promoted-context", { type: "queue_after_active" }),
          );
          const queued = (yield* rpc[methods.getThreadProjection]({ threadId })).runs.find(
            (r) => r.userMessageId === "promoted-context",
          );
          if (queued === undefined) return yield* Effect.die("Missing queued message");
          yield* rpc[methods.dispatchCommand]({
            type: "queued-run.edit",
            commandId: commandId(),
            threadId,
            runId: queued.id,
            text,
            context,
          });
          // A text-only editor must leave the original records intact.
          yield* rpc[methods.dispatchCommand]({
            type: "queued-run.edit",
            commandId: commandId(),
            threadId,
            runId: queued.id,
            text: `Edited: ${text}`,
          });
          yield* rpc[methods.dispatchCommand](promote(queued.id, opening.id));
          assert.include(opening.steers[0]?.input ?? "", "Promoted reference history");
          assert.deepInclude(
            inputOf(yield* rpc[methods.getThreadProjection]({ threadId }), "promoted-context"),
            { text: `Edited: ${text}`, context },
          );
        }),
      );
    }),
  );

  it.live("launches with inline thread context in the opening message", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      mend.workbench.addSession({ id: sourceId, projectId: "project-1" });
      mend.workbench.addTurn(sourceId, "Opening reference history");
      yield* gateway(
        mend,
        ":memory:",
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "LAUNCH-CONTEXT");
          const context = contextOf((yield* GatewayState).environmentId);
          const launched = yield* rpc[methods.launchThread]({
            commandId: commandId(),
            threadId: ThreadId.make("context-draft"),
            projectId: ProjectId.make("project-1"),
            title: "With reference",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "worktree", baseRef: "main", branch: "context-reference" },
            initialMessage: {
              messageId: MessageId.make("opening-context"),
              text,
              context,
              attachments: [],
            },
          });
          yield* eventually(() => posts(mend, "/turns").length === 1);
          const projection = yield* rpc[methods.getThreadProjection]({
            threadId: launched.threadId,
          });
          assert.deepInclude(inputOf(projection, "opening-context"), { text, context });
          const inputs = Array.from(mend.workbench.turns.values())
            .flat()
            .map((t) => t.input);
          assert.isTrue(
            inputs.some(
              (input) =>
                input.includes("Opening reference history") && input.includes("t3_context"),
            ),
          );
        }),
      );
    }),
  );

  for (const loseAccess of [false, true]) {
    it.live(
      loseAccess
        ? "refuses queued delivery after source visibility is lost"
        : "refuses another person's private source history",
      () =>
        Effect.gen(function* () {
          const mend = yield* startFakeMend;
          const opening = setup(mend);
          mend.workbench.projectVisibility.set("project-1", "shared");
          mend.workbench.addProject("source-project", "Source");
          mend.workbench.projectVisibility.set("source-project", loseAccess ? "shared" : "private");
          mend.workbench.addSession({ id: sourceId, projectId: "source-project" });
          mend.workbench.addTurn(sourceId, "Private reference history");
          yield* gateway(
            mend,
            ":memory:",
            Effect.gen(function* () {
              const { rpc } = yield* pairAndConnect(mend, "PRIVATE-CONTEXT", {
                id: "user-2",
                name: "Bea",
                email: "bea@example.com",
              });
              const context = contextOf((yield* GatewayState).environmentId);
              const result = yield* rpc[methods.dispatchCommand]({
                ...message("private-context", { type: "queue_after_active" }),
                text,
                context,
              }).pipe(Effect.exit);
              assert.strictEqual(Exit.isSuccess(result), loseAccess);
              if (loseAccess) {
                mend.workbench.projectVisibility.set("source-project", "private");
                mend.workbench.setTurn(opening, "completed");
                yield* projectionWhen(rpc, (p) =>
                  p.runs.some(
                    (r) => r.userMessageId === "private-context" && r.status === "failed",
                  ),
                );
              }
              assert.lengthOf(posts(mend, "/turns"), 0);
              assert.lengthOf(posts(mend, "/steer"), 0);
            }),
          );
        }),
    );
  }

  it.live("retries a lost POST with the same transcript snapshot after restart", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const opening = setup(mend);
      mend.workbench.setTurn(opening, "completed");
      mend.workbench.addSession({ id: sourceId, projectId: "project-1" });
      const reference = mend.workbench.addTurn(sourceId, "Original snapshot");
      const path = statePath();
      mend.workbench.loseMessageAnswerOnce = true;
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "LOST-CONTEXT");
          const context = contextOf((yield* GatewayState).environmentId);
          yield* rpc[methods.dispatchCommand]({
            ...message("lost-context", { type: "start_immediately" }),
            text,
            context,
          });
          yield* eventually(() => mend.workbench.messageReceipts.size === 1);
          // Wait for the durable uncertain-send hold, not only the upstream admission.
          yield* projectionWhen(rpc, (p) =>
            p.runs.some((r) => r.userMessageId === "lost-context" && r.queueHeld === true),
          );
        }),
      );
      mend.workbench.addItem(reference, {
        kind: "assistant",
        text: "Later source answer",
        status: "completed",
      });
      yield* gateway(
        mend,
        path,
        Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "RETRY-CONTEXT");
          yield* rpc[methods.dispatchCommand]({
            type: "queue.resume",
            commandId: commandId(),
            threadId,
          });
          yield* eventually(() => posts(mend, "/turns").length === 2);
          assert.deepEqual(posts(mend, "/turns")[1]?.body, posts(mend, "/turns")[0]?.body);
          assert.lengthOf(mend.workbench.turns.get(threadId) ?? [], 2);
        }),
      );
    }),
  );

  for (const invalid of ["other-environment", "unavailable"] as const) {
    it.live(`refuses ${invalid} thread context without sending it`, () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        setup(mend);
        yield* gateway(
          mend,
          ":memory:",
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, "REFUSE-CONTEXT");
            const state = yield* GatewayState;
            const context = contextOf(
              invalid === "other-environment" ? EnvironmentId.make("other") : state.environmentId,
            );
            const result = yield* rpc[methods.dispatchCommand]({
              ...message("invalid-context", { type: "start_immediately" }, "auto"),
              text,
              context,
            }).pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(result));
            assert.lengthOf(posts(mend, "/turns"), 0);
            assert.lengthOf(posts(mend, "/steer"), 0);
          }),
        );
      }),
    );
  }
});
