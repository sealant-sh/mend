import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ArchivedShellStreamItem,
  type OrchestrationV2ShellStreamItem,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Archive (ADR 0012, phase 3): the person's own view, kept by the gateway, as Mend has none. An
 * archived thread leaves the active shell for the archived one, and what was queued for it is
 * held, never sent while it is archived, and never lost.
 */

const THREAD = ThreadId.make("session-1");
let commands = 0;
const commandId = () => CommandId.make(`archive-command-${++commands}`);
const archive = (type: "thread.archive" | "thread.unarchive") =>
  ({ type, commandId: commandId(), threadId: THREAD }) as const;

const eventually = (condition: () => boolean, what: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (condition()) return;
      yield* Effect.sleep("50 millis");
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
  });

const queueBehind = (messageId: string, text: string) =>
  ({
    type: "message.dispatch",
    commandId: commandId(),
    createdBy: "user",
    creationSource: "web",
    threadId: THREAD,
    messageId: MessageId.make(messageId),
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  }) as const;

type Shell = OrchestrationV2ShellStreamItem;
type Archived = OrchestrationV2ArchivedShellStreamItem;

const tagOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

describe("archive", () => {
  it.live(
    "moves a thread between the active and archived shells, and keeps it across a restart",
    () => {
      const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-archive-")), "state.sqlite");
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");

        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "ARCHIVE");
          const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
          const archivedShell = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]({}),
          );
          yield* shell.next(
            (item): item is Extract<Shell, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          yield* archivedShell.next(
            (item): item is Extract<Archived, { kind: "snapshot" }> => item.kind === "snapshot",
          );
          // A message waits behind the open turn.
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: commandId(),
            createdBy: "user",
            creationSource: "web",
            threadId: THREAD,
            messageId: MessageId.make("message-waiting"),
            text: "Then this",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });

          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.archive"));
          yield* shell.next(
            (item): item is Extract<Shell, { kind: "thread.removed" }> =>
              item.kind === "thread.removed" && item.threadId === "session-1",
          );
          const moved = yield* archivedShell.next(
            (item): item is Extract<Archived, { kind: "thread.updated" }> =>
              item.kind === "thread.updated" && item.thread.id === "session-1",
          );
          assert.isNotNull(moved.thread.archivedAt);
          const snapshot = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
          assert.deepStrictEqual(
            snapshot.threads.map((thread) => thread.id),
            ["session-1"],
          );
          assert.strictEqual(
            tagOf(
              yield* Effect.exit(
                rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.archive")),
              ),
            ),
            "OrchestrationV2DispatchCommandError",
          );

          // What was queued is held: nothing reaches Mend when the turn ends.
          mend.workbench.setTurn(open, "completed");
          yield* Effect.sleep("300 millis");
          assert.strictEqual(
            mend.workbench.calls.filter(
              (call) => call.method === "POST" && call.path.endsWith("/turns"),
            ).length,
            0,
          );
          // Mend is not touched: the session stands.
          assert.isTrue(mend.workbench.sessions.has("session-1"));
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AFTER-RESTART");
          const kept = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
          assert.deepStrictEqual(
            kept.threads.map((thread) => thread.id),
            ["session-1"],
          );
          const active = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
            (stream) => feed(stream),
            Effect.flatMap((items) =>
              items.next(
                (item): item is Extract<Shell, { kind: "snapshot" }> => item.kind === "snapshot",
              ),
            ),
          );
          assert.deepStrictEqual(active.snapshot.threads, []);

          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.unarchive"));
          const back = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.isNull(back.thread.archivedAt);
          const empty = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
          assert.deepStrictEqual(empty.threads, []);
          // The message is still there, held, until the person resumes the queue.
          const waiting = back.runs.find((run) => run.userMessageId === "message-waiting");
          assert.strictEqual(waiting?.status, "queued");
          assert.isTrue(waiting?.queueHeld);
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queue.resume",
            commandId: commandId(),
            threadId: THREAD,
          });
          yield* eventually(
            () =>
              mend.workbench.calls.filter(
                (call) => call.method === "POST" && call.path.endsWith("/turns"),
              ).length === 1,
            "the resumed message",
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      });
    },
  );

  it.live("an archive of a long queue loses no message, across a restart too", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-archive-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      mend.workbench.addTurn("session-1", "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "LONG-QUEUE");
        // More than the 20 settled messages a queue keeps as history.
        for (let message = 0; message < 25; message++) {
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            queueBehind(`message-${message}`, `Prompt ${message}`),
          );
        }
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.archive"));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "LONG-QUEUE-AFTER");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.unarchive"));
        const back = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        const waiting = back.runs.filter((run) => run.status === "queued");
        assert.strictEqual(waiting.length, 25);
        assert.isTrue(waiting.every((run) => run.queueHeld));
        assert.strictEqual(
          mend.workbench.calls.filter(
            (call) => call.method === "POST" && call.path.endsWith("/turns"),
          ).length,
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });

  it.live("refuses to resume an archived thread's queue, and sends nothing (613-R2-1)", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      const open = mend.workbench.addTurn("session-1", "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "ARCHIVE-RESUME");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          queueBehind("message-archived", "Not while archived"),
        );
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.archive"));
        // A stale client resumes it: before, the prompt went out while the thread was archived.
        const resumed = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "queue.resume",
            commandId: commandId(),
            threadId: THREAD,
          }),
        );
        assert.strictEqual(tagOf(resumed), "OrchestrationV2DispatchCommandError");
        mend.workbench.setTurn(open, "completed");
        yield* Effect.sleep("400 millis");
        assert.strictEqual(
          mend.workbench.calls.filter(
            (call) => call.method === "POST" && call.path.endsWith("/turns"),
          ).length,
          0,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "sends nothing for a thread the state file keeps archived, even with its queue not held",
    () => {
      const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-archive-")), "state.sqlite");
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const open = mend.workbench.addTurn("session-1", "A long job");
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "ARCHIVE-DURABLE");
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
            queueBehind("message-archived", "Not while archived"),
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.archive"));
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
        // The hold gone from the state file, the archive kept: the archive alone stops the queue.
        const database = new DatabaseSync(statePath);
        database.exec("DELETE FROM queue_holds");
        database.close();
        mend.workbench.setTurn(open, "completed");
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "ARCHIVE-DURABLE-AFTER");
          const kept = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
          assert.strictEqual(kept.threads.length, 1);
          yield* Effect.sleep("400 millis");
          assert.strictEqual(
            mend.workbench.calls.filter(
              (call) => call.method === "POST" && call.path.endsWith("/turns"),
            ).length,
            0,
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      });
    },
  );

  it.live("refuses an archive whose hold the state file will not keep: nothing archived", () => {
    const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-archive-")), "state.sqlite");
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      mend.workbench.addTurn("session-1", "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "ARCHIVE-UNKEPT");
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
          queueBehind("message-archived", "Not while archived"),
        );
        const database = new DatabaseSync(statePath);
        database.exec(
          "CREATE TRIGGER refuse_hold BEFORE INSERT ON queue_holds BEGIN SELECT RAISE(ABORT, 'disk failure'); END",
        );
        const refusedArchive = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](archive("thread.archive")),
        );
        assert.strictEqual(tagOf(refusedArchive), "OrchestrationV2DispatchCommandError");
        assert.strictEqual(database.prepare("SELECT * FROM archived_threads").all().length, 0);
        database.close();
        const snapshot = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]({});
        assert.deepStrictEqual(snapshot.threads, []);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });
});
