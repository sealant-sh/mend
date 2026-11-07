import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  TurnItemId,
  type OrchestrationV2CommandOutputFrame,
} from "@mend/t3-contracts";
import { appendTerminalOutput, EMPTY_TERMINAL_OUTPUT } from "@mend/t3-contracts/terminal-output";
import { Cause, Effect, Exit, Option, Stream } from "effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const anyFrame = (frame: OrchestrationV2CommandOutputFrame): frame is typeof frame => true;

describe("expanded command output", () => {
  // Every running command opened in T3 hits this path. The previous gateway hid the
  // capability and refused the stream, leaving people waiting for the final tool card.
  it.live("opens with the recorded tail, streams changes and ends on the final frame", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const work = mend.workbench;
        work.addProject("project-1", "mend");
        work.addSession({ id: "session-1", projectId: "project-1" });
        const turn = work.addTurn("session-1", "Run tests");
        const command = work.addItem(turn, {
          kind: "command-execution",
          title: "pnpm test",
          status: "in-progress",
          text: "first\n",
        });
        const { rpc, client } = yield* pairAndConnect(mend, "OUTPUT");
        assert.isTrue((yield* client.metadata.descriptor()).capabilities.commandOutputStreaming);
        const target = {
          threadId: ThreadId.make("session-1"),
          itemId: TurnItemId.make(command.id),
        };
        const output = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput](target));
        assert.deepStrictEqual(yield* output.next(anyFrame), {
          kind: "replace",
          text: "first\n",
          truncated: false,
          running: true,
        });
        work.updateItem(command, { text: "first\nsecond\n" });
        assert.deepStrictEqual(yield* output.next(anyFrame), {
          kind: "append",
          text: "second\n",
          truncated: false,
          running: true,
        });
        work.updateItem(command, { text: "rewritten\n" });
        assert.deepStrictEqual(yield* output.next(anyFrame), {
          kind: "replace",
          text: "rewritten\n",
          truncated: false,
          running: true,
        });
        work.updateItem(command, { text: "rewritten\ndone\n", status: "completed" });
        assert.deepStrictEqual(yield* output.next(anyFrame), {
          kind: "replace",
          text: "rewritten\ndone\n",
          truncated: false,
          running: false,
        });
        const reopened = yield* Stream.runCollect(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput](target),
        ).pipe(Effect.timeout("5 seconds"));
        assert.deepStrictEqual(reopened, [
          {
            kind: "replace",
            text: "rewritten\ndone\n",
            truncated: false,
            running: false,
          },
        ]);
      }),
    ),
  );

  it.live("bounds terminal redraws and ends on Stop even if the tool stays in progress", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const work = mend.workbench;
        work.addProject("project-1", "mend");
        work.addSession({ id: "session-1", projectId: "project-1" });
        const turn = work.addTurn("session-1", "Run a command");
        const source = "old\n".repeat(30_000) + "\u001b[31m10%\r20%\u001b[0m";
        const command = work.addItem(turn, {
          kind: "command-execution",
          status: "in-progress",
          text: source,
        });
        const { rpc } = yield* pairAndConnect(mend, "STOP-OUTPUT");
        const target = {
          threadId: ThreadId.make("session-1"),
          itemId: TurnItemId.make(command.id),
        };
        const output = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput](target));
        const initial = yield* output.next(anyFrame);
        assert.isTrue(initial.truncated);
        assert.isBelow(initial.text.length, 66_000);
        assert.notInclude(initial.text, "10%");
        assert.include(initial.text, "20%");
        work.updateItem(command, { text: source + "\r30%" });
        const appended = yield* output.next(anyFrame);
        assert.strictEqual(appended.kind, "append");
        assert.strictEqual(appended.text, "\r30%");
        const viewed = appendTerminalOutput(
          appendTerminalOutput(EMPTY_TERMINAL_OUTPUT, initial.text),
          appended.text,
        );
        assert.include(viewed.text, "30%");
        assert.notInclude(viewed.text, "20%");
        work.setTurn(turn, "interrupted");
        const stopped = yield* output.next((frame): frame is typeof frame => !frame.running);
        assert.isTrue(stopped.truncated);
        assert.include(stopped.text, "30%");
        assert.notInclude(stopped.text, "20%");
        assert.isBelow(stopped.text.length, 66_000);
        const reopened = yield* Stream.runCollect(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput](target),
        ).pipe(Effect.timeout("5 seconds"));
        assert.lengthOf(reopened, 1);
        assert.isFalse(reopened[0]?.running);
      }),
    ),
  );

  it.live("refuses missing threads, missing items and non-command rows with a typed error", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const work = mend.workbench;
        work.addProject("project-1", "mend");
        work.addSession({ id: "session-1", projectId: "project-1" });
        const turn = work.addTurn("session-1", "Hello", "completed");
        const message = work.addItem(turn, { kind: "assistant-message", text: "Hello" });
        const { rpc } = yield* pairAndConnect(mend, "NO-COMMAND");
        for (const { threadId, itemId } of [
          { threadId: "missing", itemId: message.id },
          { threadId: "session-1", itemId: "missing" },
          { threadId: "session-1", itemId: message.id },
        ]) {
          const exit = yield* Effect.exit(
            Stream.runCollect(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]({
                threadId: ThreadId.make(threadId),
                itemId: TurnItemId.make(itemId),
              }),
            ),
          );
          assert.isTrue(Exit.isFailure(exit));
          const error = Exit.isFailure(exit)
            ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
            : null;
          assert.propertyVal(error, "_tag", "OrchestrationV2CommandOutputError");
        }
      }),
    ),
  );

  it.live("refuses output from another person's private project", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const work = mend.workbench;
        work.addProject("project-private", "private");
        work.projectVisibility.set("project-private", "private");
        work.addSession({ id: "private-session", projectId: "project-private" });
        const turn = work.addTurn("private-session", "Run a command", "completed");
        const command = work.addItem(turn, { kind: "command-execution", text: "private output" });
        const { rpc } = yield* pairAndConnect(mend, "OTHER-OUTPUT", {
          id: "user-2",
          name: "Bea",
          email: "bea@example.com",
        });
        const exit = yield* Effect.exit(
          Stream.runCollect(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]({
              threadId: ThreadId.make("private-session"),
              itemId: TurnItemId.make(command.id),
            }),
          ),
        );
        assert.isTrue(Exit.isFailure(exit));
        const error = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : null;
        assert.propertyVal(error, "_tag", "OrchestrationV2CommandOutputError");
      }),
    ),
  );
});
