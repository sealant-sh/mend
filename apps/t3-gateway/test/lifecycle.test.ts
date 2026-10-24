import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@mend/t3-contracts";
import {
  effectiveSnoozed,
  threadWokeAt,
  type ThreadSnoozeShell,
} from "@mend/t3-contracts/thread-settled";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { advanceClock } from "./support/fake-workbench.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Settle and snooze (ADR 0012, phase 3): the person's own view, kept by the gateway as Mend has
 * neither, the same way as the archive. The shell carries t3code's fields, and t3code's own client
 * rules (`threadSettled.ts`, vendored at the pin) decide when a snooze has woken.
 */

const THREAD = ThreadId.make("session-1");
const HOUR = 60 * 60 * 1_000;
let commands = 0;
const commandId = () => CommandId.make(`lifecycle-command-${++commands}`);

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];

const dispatch = (
  rpc: Rpc,
  command:
    | { readonly type: "thread.settle" | "thread.unsettle" | "thread.unsnooze" }
    | { readonly type: "thread.snooze"; readonly snoozedUntil: string },
) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](
    command.type === "thread.snooze"
      ? { ...command, commandId: commandId(), threadId: THREAD }
      : command.type === "thread.settle"
        ? { type: command.type, commandId: commandId(), threadId: THREAD }
        : { type: command.type, commandId: commandId(), threadId: THREAD, reason: "user" },
  );

const tagOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

/** The person's shell, kept current from `subscribeShell`. */
const watchShell = (rpc: Rpc) =>
  Effect.gen(function* () {
    const threads = new Map<string, OrchestrationV2ThreadShell>();
    yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          if (item.kind === "snapshot") {
            threads.clear();
            for (const thread of item.snapshot.threads) threads.set(thread.id, thread);
          } else if (item.kind === "thread.updated") {
            threads.set(item.thread.id, item.thread);
          } else if (item.kind === "thread.removed") {
            threads.delete(item.threadId);
          }
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const until = (accept: (thread: OrchestrationV2ThreadShell) => boolean, what: string) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          const thread = threads.get(THREAD);
          if (thread !== undefined && accept(thread)) return thread;
          yield* Effect.sleep("50 millis");
        }
        return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
      });
    return { until };
  });

const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

const TERMINAL = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/**
 * The shell row as t3code's client hands it to its snooze rules (`presentThreadShell` and
 * `shellRuntime` in t3:packages/client-runtime/src/state/models.ts at the pin), the fields they
 * read.
 */
const asClientSees = (thread: OrchestrationV2ThreadShell): ThreadSnoozeShell => {
  const updatedAt = DateTime.formatIso(thread.updatedAt);
  const request = thread.pendingRuntimeRequest;
  const kind = request?.kind;
  const runtimeStatus = thread.activityRunStatus ?? thread.status;
  const working =
    runtimeStatus === "preparing" || runtimeStatus === "starting" || runtimeStatus === "running";
  return {
    source: { pendingRuntimeRequest: request },
    latestUserMessageAt: iso(thread.latestUserMessageAt),
    latestRun:
      thread.latestRunId === null
        ? null
        : {
            status: thread.status === "idle" ? "completed" : thread.status,
            requestedAt: iso(thread.latestRunRequestedAt),
            startedAt: iso(thread.latestRunStartedAt),
            completedAt:
              thread.latestRunCompletedAt === undefined
                ? thread.status === "idle" || TERMINAL.has(thread.status)
                  ? updatedAt
                  : null
                : iso(thread.latestRunCompletedAt),
          },
    runtime: { status: runtimeStatus, updatedAt },
    hasPendingApprovals: kind !== undefined && kind !== "user_input" && kind !== "auth_refresh",
    hasPendingUserInput: kind === "user_input" && (request?.blocking !== false || !working),
    snoozedUntil: iso(thread.snoozedUntil),
    snoozedAt: iso(thread.snoozedAt),
  };
};

const snoozedNow = (thread: OrchestrationV2ThreadShell, now = Date.now()) =>
  effectiveSnoozed(asClientSees(thread), { now: new Date(now).toISOString() });

/** A project and its one session, on Mend's clock caught up with the gateway's. */
const withSession = (mend: FakeMend) => {
  advanceClock(Date.now());
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
};

const statePathOf = () =>
  join(mkdtempSync(join(tmpdir(), "t3-gateway-lifecycle-")), "state.sqlite");

describe("settle", () => {
  it.live("settles and unsettles a thread, and keeps it settled across a restart", () => {
    const statePath = statePathOf();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SETTLE");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.settledOverride === null, "the thread");
        yield* dispatch(rpc, { type: "thread.settle" });
        const settled = yield* shell.until(
          (thread) => thread.settledOverride === "settled",
          "the settle",
        );
        assert.isNotNull(settled.settledAt);
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.strictEqual(projection.thread.settledOverride, "settled");
        // Settling again keeps when it was first settled.
        yield* dispatch(rpc, { type: "thread.settle" });
        const again = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.strictEqual(iso(again.thread.settledAt), iso(settled.settledAt));
        // Mend is not touched.
        assert.isTrue(
          mend.workbench.calls.every((call) => call.method === "GET" || call.path === "/api/me"),
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SETTLE-AFTER");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.settledOverride === "settled", "the kept settle");
        yield* dispatch(rpc, { type: "thread.unsettle" });
        const active = yield* shell.until(
          (thread) => thread.settledOverride === "active",
          "the unsettle",
        );
        assert.isNull(active.settledAt);
        assert.isNotNull(active.unsettledAt);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });

  it.live("settling a snoozed thread ends its snooze", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SETTLE-SNOOZED");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.latestRunId !== null, "the thread");
        yield* dispatch(rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        yield* shell.until((thread) => thread.snoozedUntil != null, "the snooze");
        yield* dispatch(rpc, { type: "thread.settle" });
        const settled = yield* shell.until(
          (thread) => thread.settledOverride === "settled",
          "the settle",
        );
        assert.isNull(settled.snoozedUntil ?? null);
        assert.isNull(settled.snoozedAt ?? null);
        assert.isFalse(snoozedNow(settled));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("refuses to settle a thread with a turn running or a question waiting", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      const turn = mend.workbench.addTurn("session-1", "Still going");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SETTLE-BUSY");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.status === "running", "the running turn");
        const running = yield* Effect.exit(dispatch(rpc, { type: "thread.settle" }));
        assert.strictEqual(tagOf(running), "OrchestrationV2DispatchCommandError");

        mend.workbench.addRequest(turn, { kind: "command-approval", title: "Run tests?" });
        yield* shell.until((thread) => thread.pendingRuntimeRequest !== null, "the approval");
        const asking = yield* Effect.exit(dispatch(rpc, { type: "thread.settle" }));
        assert.strictEqual(tagOf(asking), "OrchestrationV2DispatchCommandError");
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.isNull(projection.thread.settledOverride);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "a message sent to a settled and snoozed thread brings it back, in the state file too",
    () => {
      const statePath = statePathOf();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        withSession(mend);
        mend.workbench.addTurn("session-1", "Done already", "completed");
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SETTLE-SEND");
          const shell = yield* watchShell(rpc);
          yield* shell.until((thread) => thread.latestRunId !== null, "the thread");
          yield* dispatch(rpc, { type: "thread.settle" });
          yield* dispatch(rpc, {
            type: "thread.snooze",
            snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
          });
          yield* shell.until(
            (thread) => thread.settledOverride === "settled" && thread.snoozedUntil != null,
            "the settle and the snooze",
          );
          yield* rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
            type: "message.dispatch",
            commandId: commandId(),
            createdBy: "user",
            creationSource: "web",
            threadId: THREAD,
            messageId: MessageId.make("message-back"),
            text: "One more thing",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
          const back = yield* shell.until(
            (thread) => thread.settledOverride === null && thread.snoozedUntil == null,
            "the thread back in the inbox",
          );
          assert.isNotNull(back.unsettledAt);
          // Let go of in the state file too: it never comes back once the message leaves the
          // queue's history.
          const database = new DatabaseSync(statePath);
          const rows = database
            .prepare("SELECT settled_override, snoozed_until FROM thread_lifecycles")
            .all();
          database.close();
          assert.deepStrictEqual(
            rows.map((row) => [row.settled_override, row.snoozed_until]),
            [[null, null]],
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      });
    },
  );
});

describe("snooze", () => {
  it.live("snoozes until a time, wakes at that time, and keeps the snooze across a restart", () => {
    const statePath = statePathOf();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      const until = Date.now() + HOUR;

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.latestRunId !== null, "the thread");
        yield* dispatch(rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(until).toISOString(),
        });
        const snoozed = yield* shell.until((thread) => thread.snoozedUntil != null, "the snooze");
        assert.strictEqual(iso(snoozed.snoozedUntil), new Date(until).toISOString());
        assert.isTrue(snoozedNow(snoozed));
        // At the snooze's time t3code's client shows it awake, and woken then.
        assert.isFalse(snoozedNow(snoozed, until));
        assert.strictEqual(
          threadWokeAt(asClientSees(snoozed), { now: new Date(until + 1).toISOString() }),
          new Date(until).toISOString(),
        );
        // A snooze ends in the future.
        const past = yield* Effect.exit(
          dispatch(rpc, {
            type: "thread.snooze",
            snoozedUntil: new Date(Date.now() - 1_000).toISOString(),
          }),
        );
        assert.strictEqual(tagOf(past), "OrchestrationV2DispatchCommandError");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE-AFTER");
        const shell = yield* watchShell(rpc);
        const kept = yield* shell.until((thread) => thread.snoozedUntil != null, "the kept snooze");
        assert.strictEqual(iso(kept.snoozedUntil), new Date(until).toISOString());
        assert.isTrue(snoozedNow(kept));
        yield* dispatch(rpc, { type: "thread.unsnooze" });
        const awake = yield* shell.until((thread) => thread.snoozedUntil == null, "the unsnooze");
        assert.isFalse(snoozedNow(awake));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });

  it.live("wakes early when the agent asks for an approval, and refuses to hide one", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      const turn = mend.workbench.addTurn("session-1", "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE-APPROVAL");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.status === "running", "the running turn");
        // A running thread can be snoozed: a snooze hides it, and never touches the agent.
        yield* dispatch(rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        const snoozed = yield* shell.until((thread) => thread.snoozedUntil != null, "the snooze");
        assert.isTrue(snoozedNow(snoozed));

        mend.workbench.addRequest(turn, { kind: "command-approval", title: "Run tests?" });
        const asking = yield* shell.until(
          (thread) => thread.pendingRuntimeRequest !== null,
          "the approval",
        );
        assert.isFalse(snoozedNow(asking));
        assert.isNotNull(asking.snoozedUntil);

        const again = yield* Effect.exit(
          dispatch(rpc, {
            type: "thread.snooze",
            snoozedUntil: new Date(Date.now() + 2 * HOUR).toISOString(),
          }),
        );
        assert.strictEqual(tagOf(again), "OrchestrationV2DispatchCommandError");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("wakes early when the turn running under the snooze fails", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      const turn = mend.workbench.addTurn("session-1", "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE-FAILED");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.status === "running", "the running turn");
        yield* dispatch(rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        const snoozed = yield* shell.until((thread) => thread.snoozedUntil != null, "the snooze");
        assert.isTrue(snoozedNow(snoozed));

        mend.workbench.setTurn(turn, "failed", "The agent crashed.");
        const ended = yield* shell.until((thread) => thread.status === "failed", "the failure");
        assert.isFalse(snoozedNow(ended));
        assert.isNotNull(threadWokeAt(asClientSees(ended), { now: new Date().toISOString() }));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("stays snoozed when the turn running under the snooze completes", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      const turn = mend.workbench.addTurn("session-1", "A long job");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE-COMPLETED");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.status === "running", "the running turn");
        yield* dispatch(rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        yield* shell.until((thread) => thread.snoozedUntil != null, "the snooze");

        mend.workbench.setTurn(turn, "completed", null);
        const ended = yield* shell.until(
          (thread) => thread.status === "completed",
          "the completion",
        );
        assert.isTrue(snoozedNow(ended));
        assert.isNull(threadWokeAt(asClientSees(ended), { now: new Date().toISOString() }));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("snoozing again for the same time stamps the snooze again", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE-AGAIN");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.latestRunId !== null, "the thread");
        const snoozedUntil = new Date(Date.now() + HOUR).toISOString();
        yield* dispatch(rpc, { type: "thread.snooze", snoozedUntil });
        const first = yield* shell.until((thread) => thread.snoozedAt != null, "the snooze");
        const firstAt = iso(first.snoozedAt);
        // A snooze is never dated before Mend's latest time for the thread, which runs ahead here.
        yield* Effect.sleep(Math.max(0, Date.parse(firstAt ?? "") - Date.now()) + 20);
        yield* dispatch(rpc, { type: "thread.snooze", snoozedUntil });
        const again = yield* shell.until(
          (thread) => iso(thread.snoozedAt) !== firstAt,
          "the snooze stamped again",
        );
        assert.strictEqual(iso(again.snoozedUntil), snoozedUntil);
        assert.isTrue(Date.parse(iso(again.snoozedAt) ?? "") > Date.parse(firstAt ?? ""));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("a thread that had failed before the snooze stays snoozed", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      const turn = mend.workbench.addTurn("session-1", "A long job");
      mend.workbench.setTurn(turn, "failed", "The agent crashed.");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SNOOZE-SEEN");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.status === "failed", "the failed turn");
        yield* dispatch(rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        const snoozed = yield* shell.until((thread) => thread.snoozedUntil != null, "the snooze");
        assert.isTrue(snoozedNow(snoozed));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});

describe("bulk settle", () => {
  it.live("settles each of several threads at once, refusing only the ones still at work", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      mend.workbench.addSession({ id: "session-2", projectId: "project-1" });
      mend.workbench.addTurn("session-2", "Done too", "completed");
      mend.workbench.addSession({ id: "session-3", projectId: "project-1" });
      mend.workbench.addTurn("session-3", "Still going");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "SETTLE-BULK");
        const shell = yield* watchShell(rpc);
        yield* shell.until((thread) => thread.latestRunId !== null, "the threads");
        const ids = ["session-1", "session-2", "session-3"].map((id) => ThreadId.make(id));
        // t3code's "Settle (N)" sends one settle per selected thread, all at once
        // (`settleThreads` in t3:apps/web/src/components/Sidebar.tsx:3397 at the pin).
        const exits = yield* Effect.forEach(
          ids,
          (threadId) =>
            Effect.exit(
              rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
                type: "thread.settle",
                commandId: commandId(),
                threadId,
              }),
            ),
          { concurrency: "unbounded" },
        );
        assert.deepStrictEqual(exits.map(tagOf), [
          undefined,
          undefined,
          "OrchestrationV2DispatchCommandError",
        ]);
        const overrides = yield* Effect.forEach(ids, (threadId) =>
          rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId }).pipe(
            Effect.map((projection) => projection.thread.settledOverride),
          ),
        );
        assert.deepStrictEqual(overrides, ["settled", "settled", null]);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});

describe("per person", () => {
  it.live("one person's settle and snooze of a shared thread are theirs alone", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "ADA");
        const bea = yield* pairAndConnect(mend, "BEA", {
          id: "user-2",
          name: "Bea",
          email: "bea@example.com",
        });
        const adaShell = yield* watchShell(ada.rpc);
        const beaShell = yield* watchShell(bea.rpc);
        yield* adaShell.until((thread) => thread.latestRunId !== null, "Ada's thread");
        yield* beaShell.until((thread) => thread.latestRunId !== null, "Bea's thread");

        yield* dispatch(ada.rpc, { type: "thread.settle" });
        yield* dispatch(ada.rpc, {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        yield* adaShell.until(
          (thread) => thread.settledOverride === "settled" && thread.snoozedUntil != null,
          "Ada's settle and snooze",
        );
        const beas = yield* bea.rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.isNull(beas.thread.settledOverride);
        assert.isNull(beas.thread.snoozedUntil ?? null);

        // Bea snoozes it to another time; Ada's stays as she set it.
        const beaUntil = new Date(Date.now() + 3 * HOUR).toISOString();
        yield* dispatch(bea.rpc, { type: "thread.snooze", snoozedUntil: beaUntil });
        const beaSnoozed = yield* beaShell.until(
          (thread) => thread.snoozedUntil != null,
          "Bea's snooze",
        );
        assert.strictEqual(iso(beaSnoozed.snoozedUntil), beaUntil);
        assert.isNull(beaSnoozed.settledOverride);
        const adas = yield* ada.rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.notStrictEqual(iso(adas.thread.snoozedUntil), beaUntil);
        assert.strictEqual(adas.thread.settledOverride, "settled");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
