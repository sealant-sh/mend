import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

type Item = OrchestrationV2ThreadStreamItem;
type ShellItem = OrchestrationV2ShellStreamItem;

const THREAD = ThreadId.make("session-1");

const setup = (mend: FakeMend) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: THREAD, projectId: "project-1", harness: "codex" });
};

const message = (id: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(`command-${id}`),
    threadId: THREAD,
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

const snapshot = (item: Item): item is Extract<Item, { kind: "snapshot" }> =>
  item.kind === "snapshot";

const shellSnapshot = (item: ShellItem): item is Extract<ShellItem, { kind: "snapshot" }> =>
  item.kind === "snapshot";

const runEvent =
  (accept: (run: OrchestrationV2Run) => boolean) =>
  (item: Item): item is Extract<Item, { kind: "event" }> =>
    item.kind === "event" && item.event.type === "run.updated" && accept(item.event.payload);

const providerStopped = (item: Item): item is Extract<Item, { kind: "event" }> =>
  item.kind === "event" &&
  item.event.type === "provider-session.updated" &&
  item.event.payload.status === "stopped";

const stoppedRun = (run: OrchestrationV2Run) =>
  run.status === "interrupted" || run.status === "cancelled";

const assertStoppedProjection = (projection: OrchestrationV2ThreadProjection) => {
  assert.strictEqual(projection.providerSessions[0]?.status, "stopped");
  assert.isNotEmpty(projection.runs);
  assert.deepStrictEqual(
    projection.runs.filter((run) => !stoppedRun(run)).map((run) => [run.id, run.status]),
    [],
    "a stopped session must not leave either a real or synthetic run active",
  );
  for (const run of projection.runs) assert.isNotNull(run.completedAt);
  assert.isEmpty(projection.turnItems.filter((item) => item.type === "error"));
};

const assertStoppedShell = (row: OrchestrationV2ThreadShell | undefined) => {
  assert.isDefined(row);
  if (row === undefined) return;
  assert.isNull(row.activeRunId);
  assert.isNull(row.activityRunStatus);
  assert.include(["interrupted", "cancelled"], row.status);
};

/** Bounded readiness check for the fake HTTP peer admitting a new turn. */
const nextTurn = (mend: FakeMend, previousId: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const turn = mend.workbench.turns
        .get(THREAD)
        ?.find((candidate) => candidate.id !== previousId);
      if (turn !== undefined) return turn;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error("The follow-up never reached Mend as a new turn."));
  });

// Ordinary use: someone presses Stop in Mend, or runs `mend stop`, while T3 is open.
// Preview 90 reproduced this in 3/3 Codex sessions. Mend's stopped row is authoritative even
// when the old turn rows still say running, so these fixtures deliberately leave them alone.
describe("a session stopped outside T3 Code", () => {
  it.live("settles the live run and sidebar, and a reload stays stopped", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      const turn = mend.workbench.addTurn(THREAD, "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SESSION-STOP-LIVE");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        yield* thread.next(snapshot);
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        yield* shell.next(shellSnapshot);

        mend.workbench.stopAgent(THREAD);
        yield* thread.next(providerStopped);
        assertStoppedProjection(
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD }),
        );
        yield* thread.next(runEvent((run) => run.id === turn.id && stoppedRun(run)));
        const sidebar = yield* shell.next(
          (item): item is Extract<ShellItem, { kind: "thread.updated" }> =>
            item.kind === "thread.updated" &&
            item.thread.id === THREAD &&
            item.thread.activeRunId === null,
        );
        assertStoppedShell(sidebar.thread);

        const reloaded = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        assertStoppedProjection((yield* reloaded.next(snapshot)).projection);
        const reloadedShell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        assertStoppedShell(
          (yield* reloadedShell.next(shellSnapshot)).snapshot.threads.find(
            (row) => row.id === THREAD,
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "settles both runs while the synthetic send is still starting, including a late turn answer",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        setup(mend);
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SESSION-STOP-STARTING");
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
          );
          yield* thread.next(snapshot);
          const answer = Promise.withResolvers<void>();
          yield* Effect.addFinalizer(() => Effect.sync(() => answer.resolve()));
          // Mend admits the real turn and emits its pointer before the HTTP response reaches the
          // gateway. The client now sees that real run beside its provisional t3-run: starting.
          mend.workbench.holds.push({
            method: "POST",
            path: /\/api\/sessions\/session-1\/(?:turns|messages)$/,
            until: answer.promise,
            reached: () => {},
          });
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            message("message-starting", "Start a long job"),
          );
          yield* thread.next(
            runEvent(
              (run) => run.userMessageId === "message-starting" && run.status === "starting",
            ),
          );
          yield* thread.next(
            runEvent((run) => !run.id.startsWith("t3-run:") && run.status === "running"),
          );
          const before = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.deepStrictEqual(before.runs.map((run) => run.status).toSorted(), [
            "running",
            "starting",
          ]);

          mend.workbench.stopAgent(THREAD);
          yield* thread.next(providerStopped);
          assertStoppedProjection(
            yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD }),
          );
          const remaining = new Set(before.runs.map((run) => run.id));
          while (remaining.size > 0) {
            const update = yield* thread.next(
              runEvent((run) => remaining.has(run.id) && stoppedRun(run)),
            );
            if (update.event.type === "run.updated") remaining.delete(update.event.payload.id);
          }
          answer.resolve();
          assert.isTrue(
            yield* thread.quiet(
              runEvent((run) => before.runs.some((old) => old.id === run.id) && !stoppedRun(run)),
            ),
            "the late admission answer must not reopen a stopped run",
          );
          const reloaded = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
          );
          assertStoppedProjection((yield* reloaded.next(snapshot)).projection);
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          assertStoppedShell(
            (yield* shell.next(shellSnapshot)).snapshot.threads.find((row) => row.id === THREAD),
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );

  it.live("rebuilds terminal runs after the gateway restarts with stale active Mend turns", () =>
    Effect.gen(function* () {
      const statePath = join(
        mkdtempSync(join(tmpdir(), "t3-gateway-session-stop-")),
        "state.sqlite",
      );
      const mend = yield* startFakeMend;
      setup(mend);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SESSION-STOP-BEFORE-RESTART");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        yield* thread.next(snapshot);
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("message-before-restart", "A long job"),
        );
        yield* thread.next(
          runEvent(
            (run) => run.userMessageId === "message-before-restart" && run.status === "running",
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      // Stop happened while the gateway was down: no live patch can hide a bad cold projection.
      mend.workbench.stopAgent(THREAD);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SESSION-STOP-AFTER-RESTART");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        const projection = (yield* thread.next(snapshot)).projection;
        assert.strictEqual(projection.runs[0]?.userMessageId, "message-before-restart");
        assertStoppedProjection(projection);
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        assertStoppedShell(
          (yield* shell.next(shellSnapshot)).snapshot.threads.find((row) => row.id === THREAD),
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    }),
  );

  it.live("relaunches for an ordinary follow-up and streams its answer without a reload", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      const previous = mend.workbench.addTurn(THREAD, "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SESSION-STOP-FOLLOW-UP");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        yield* thread.next(snapshot);
        mend.workbench.stopAgent(THREAD);
        yield* thread.next(providerStopped);

        const agent = mend.workbench.holdNextAgent();
        yield* Effect.addFinalizer(() => Effect.sync(() => agent.release()));
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          message("message-after-stop", "Please pick it up again"),
        );
        yield* thread.next(
          runEvent(
            (run) => run.userMessageId === "message-after-stop" && run.status === "preparing",
          ),
        );
        agent.release();
        const turn = yield* nextTurn(mend, previous.id);
        assert.strictEqual(turn.input, "Please pick it up again");
        // The fake peer has no protocol host; make its newly admitted turn run and answer as
        // the relaunched host does. The old persisted row deliberately remains running.
        mend.workbench.setTurn(turn, "running");
        mend.workbench.addItem(turn, { kind: "assistant-message", text: "I picked it up again." });
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "turn-item.updated" &&
            item.event.payload.type === "assistant_message" &&
            item.event.payload.text === "I picked it up again.",
        );
        mend.workbench.setTurn(turn, "completed");
        yield* thread.next(
          runEvent(
            (run) => run.userMessageId === "message-after-stop" && run.status === "completed",
          ),
        );
        assert.lengthOf(
          mend.workbench.calls.filter(
            (call) => call.method === "POST" && call.path.endsWith("/launch"),
          ),
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});

// Seconds-long startup windows, before any provider turn has been admitted.
describe("Stop during workspace preparation or provider startup", () => {
  for (const phase of ["setup", "agent"] as const) {
    it.live(`streams cancellation during ${phase} and reloads without an active run or error`, () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, `STARTUP-STOP-${phase}`);
          const agent = mend.workbench.holdNextAgent();
          yield* Effect.addFinalizer(() => Effect.sync(() => agent.release()));
          if (phase === "setup") {
            mend.tty.scripts.set("pnpm install", { lines: ["fetching"], exitCode: "hang" });
            yield* rpc[WS_METHODS.serverUpdateSettings]({
              patch: {
                projectScriptOverrides: {
                  [ProjectId.make("project-1")]: [
                    {
                      id: "install",
                      name: "Install",
                      command: "pnpm install",
                      icon: "configure",
                      runOnWorktreeCreate: true,
                      async: false,
                    },
                  ],
                },
              },
            });
            agent.release();
          }
          const threadId = ThreadId.make(`draft-startup-${phase}`);
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.launchThread]({
            commandId: CommandId.make(`launch-${phase}`),
            threadId,
            projectId: ProjectId.make("project-1"),
            title: "Startup Stop",
            generateTitle: false,
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "worktree", baseRef: "main" },
            initialMessage: {
              messageId: MessageId.make(`opening-${phase}`),
              text: "Start this",
              attachments: [],
            },
          });
          const thread = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }),
          );
          yield* thread.next(snapshot);
          for (let attempt = 0; ; attempt++) {
            const ready =
              phase === "setup"
                ? mend.tty.scriptRuns.length === 1
                : mend.workbench.launches.length === 1;
            if (ready) break;
            assert.isBelow(attempt, 100, "startup reached the deferred boundary");
            yield* Effect.sleep("50 millis");
          }
          const sessionId = mend.workbench.launches[0]?.sessionId;
          assert.isDefined(sessionId);
          if (sessionId === undefined) return;
          mend.workbench.stopAgent(sessionId);
          yield* thread.next(runEvent((run) => stoppedRun(run)));
          // Startup's next observation must keep the cancellation, including late setup cleanup.
          yield* Effect.sleep("1200 millis");
          const reloaded = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId }),
          );
          assertStoppedProjection((yield* reloaded.next(snapshot)).projection);
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          assertStoppedShell(
            (yield* shell.next(shellSnapshot)).snapshot.threads.find((row) => row.id === threadId),
          );
          if (phase === "setup")
            assert.isFalse(mend.tty.shells.get(mend.tty.scriptRuns[0] ?? "")?.running);
          assert.isEmpty(mend.workbench.turns.get(sessionId) ?? []);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
    );
  }
});
