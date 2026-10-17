import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { AUTO_SETTLE_AFTER_DAYS, MAX_ORDER_KEY_LENGTH } from "../src/lifecycle.ts";
import { assert, describe, it, TestClock } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { advanceClock } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { GatewayTimers, withGatewayTimers } from "./support/timers.ts";

const DAY = 24 * 60 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const BEA = { id: "user-2", name: "Bea", email: "bea@example.com" };
let commands = 0;
const commandId = () => CommandId.make(`pins-command-${++commands}`);

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];

type ThreadCommand =
  | { readonly type: "thread.pin"; readonly orderKey?: string }
  | { readonly type: "thread.unpin" | "thread.settle" | "thread.unsnooze" }
  | { readonly type: "thread.pin.reorder" | "thread.active.reorder"; readonly orderKey: string }
  | { readonly type: "thread.auto-settle.set"; readonly enabled: boolean }
  | { readonly type: "thread.snooze"; readonly snoozedUntil: string };

const commandOf = (threadId: string, command: ThreadCommand): OrchestrationV2Command => {
  const ids = { commandId: commandId(), threadId: ThreadId.make(threadId) };
  switch (command.type) {
    case "thread.pin":
      return command.orderKey === undefined
        ? { type: command.type, ...ids }
        : { type: command.type, ...ids, orderKey: command.orderKey };
    case "thread.unpin":
    case "thread.settle":
      return { type: command.type, ...ids };
    case "thread.unsnooze":
      return { type: command.type, ...ids, reason: "user" };
    case "thread.pin.reorder":
    case "thread.active.reorder":
      return { type: command.type, ...ids, orderKey: command.orderKey };
    case "thread.auto-settle.set":
      return { type: command.type, ...ids, enabled: command.enabled };
    case "thread.snooze":
      return { type: command.type, ...ids, snoozedUntil: command.snoozedUntil };
  }
};

const dispatch = (rpc: Rpc, threadId: string, command: ThreadCommand) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](commandOf(threadId, command));

const refusal = (rpc: Rpc, threadId: string, command: ThreadCommand) =>
  Effect.exit(dispatch(rpc, threadId, command)).pipe(
    Effect.map((exit) =>
      Exit.isFailure(exit)
        ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag
        : "accepted",
    ),
  );

/** The shell as last streamed; `pause` is a live sleep under the TestClock. */
const watchShell = (rpc: Rpc, pause: Effect.Effect<void> = Effect.sleep("50 millis")) =>
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
          }
        }),
      ),
      Effect.ignore,
      Effect.forkScoped,
    );
    const until = (
      threadId: string,
      accept: (thread: OrchestrationV2ThreadShell) => boolean,
      what: string,
    ) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt++) {
          const thread = threads.get(threadId);
          if (thread !== undefined && accept(thread)) return thread;
          yield* pause;
        }
        return yield* Effect.die(new Error(`Timed out waiting for ${what}.`));
      });
    return { until, threads };
  });

const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

const placeOf = (thread: OrchestrationV2ThreadShell) => ({
  pinned: thread.pinnedAt != null,
  pinOrderKey: thread.pinOrderKey ?? null,
  activeOrderKey: thread.activeOrderKey ?? null,
});

const withSessions = (mend: FakeMend, ids: ReadonlyArray<string>) => {
  advanceClock(Date.now());
  mend.workbench.addProject("project-1", "mend");
  for (const id of ids) {
    mend.workbench.addSession({ id, projectId: "project-1" });
    mend.workbench.addTurn(id, `Work on ${id}`, "completed");
  }
};

const ageTurns = (mend: FakeMend, sessionId: string, at: string) => {
  const turns = mend.workbench.turns.get(sessionId) ?? [];
  mend.workbench.turns.set(
    sessionId,
    turns.map((turn) => ({ ...turn, createdAt: at, startedAt: at, endedAt: at })),
  );
  const first = mend.workbench.turns.get(sessionId)?.[0];
  if (first !== undefined) mend.workbench.addItem(first, { kind: "reasoning", text: "Read." });
};

const statePathOf = () => join(mkdtempSync(join(tmpdir(), "t3-gateway-pins-")), "state.sqlite");

const onlyReads = (mend: FakeMend) =>
  mend.workbench.calls.every((call) => call.method === "GET" || call.path === "/api/me");

describe("pins and order", () => {
  it.live("pins, orders and unpins threads, and keeps them across a restart", () => {
    const statePath = statePathOf();
    return Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSessions(mend, ["session-1", "session-2", "session-3"]);

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PIN");
        const shell = yield* watchShell(rpc);
        yield* shell.until("session-3", (thread) => thread.latestRunId !== null, "the threads");

        yield* dispatch(rpc, "session-1", { type: "thread.pin", orderKey: "n" });
        yield* dispatch(rpc, "session-2", { type: "thread.pin", orderKey: "t" });
        yield* dispatch(rpc, "session-2", { type: "thread.pin.reorder", orderKey: "g" });
        yield* dispatch(rpc, "session-3", { type: "thread.active.reorder", orderKey: "m" });
        const two = yield* shell.until(
          "session-2",
          (thread) => thread.pinOrderKey === "g",
          "the reordered pin",
        );
        assert.deepStrictEqual(placeOf(two), {
          pinned: true,
          pinOrderKey: "g",
          activeOrderKey: null,
        });
        const pinnedAt = iso(two.pinnedAt);
        yield* dispatch(rpc, "session-2", { type: "thread.pin", orderKey: "z" });
        const again = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("session-2"),
        });
        assert.strictEqual(iso(again.thread.pinnedAt), pinnedAt);
        assert.strictEqual(again.thread.pinOrderKey, "g");

        assert.strictEqual(
          yield* refusal(rpc, "session-3", { type: "thread.pin.reorder", orderKey: "b" }),
          "OrchestrationV2DispatchCommandError",
        );
        assert.strictEqual(
          yield* refusal(rpc, "session-1", { type: "thread.active.reorder", orderKey: "b" }),
          "OrchestrationV2DispatchCommandError",
        );
        assert.strictEqual(
          yield* refusal(rpc, "session-1", {
            type: "thread.pin.reorder",
            orderKey: "n".repeat(MAX_ORDER_KEY_LENGTH + 1),
          }),
          "OrchestrationV2DispatchCommandError",
        );
        assert.isTrue(onlyReads(mend));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PIN-AFTER");
        const shell = yield* watchShell(rpc);
        yield* shell.until("session-3", (thread) => thread.activeOrderKey === "m", "the order");
        assert.deepStrictEqual(
          ["session-1", "session-2", "session-3"].map((id) => {
            const thread = shell.threads.get(id);
            return thread === undefined ? null : placeOf(thread);
          }),
          [
            { pinned: true, pinOrderKey: "n", activeOrderKey: null },
            { pinned: true, pinOrderKey: "g", activeOrderKey: null },
            { pinned: false, pinOrderKey: null, activeOrderKey: "m" },
          ],
        );

        yield* dispatch(rpc, "session-1", { type: "thread.unpin" });
        const unpinned = yield* shell.until(
          "session-1",
          (thread) => thread.pinnedAt == null,
          "the unpin",
        );
        assert.deepStrictEqual(placeOf(unpinned), {
          pinned: false,
          pinOrderKey: null,
          activeOrderKey: null,
        });
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
    });
  });

  it.live("settling a pinned thread unpins it; pinning a settled, snoozed one brings it back", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSessions(mend, ["session-1"]);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PIN-SETTLE");
        const shell = yield* watchShell(rpc);
        yield* shell.until("session-1", (thread) => thread.latestRunId !== null, "the thread");

        yield* dispatch(rpc, "session-1", { type: "thread.pin", orderKey: "n" });
        yield* dispatch(rpc, "session-1", { type: "thread.settle" });
        const settled = yield* shell.until(
          "session-1",
          (thread) => thread.settledOverride === "settled",
          "the settle",
        );
        assert.deepStrictEqual(placeOf(settled), {
          pinned: false,
          pinOrderKey: null,
          activeOrderKey: null,
        });

        yield* dispatch(rpc, "session-1", {
          type: "thread.snooze",
          snoozedUntil: new Date(Date.now() + HOUR).toISOString(),
        });
        yield* shell.until("session-1", (thread) => thread.snoozedUntil != null, "the snooze");
        yield* dispatch(rpc, "session-1", { type: "thread.pin" });
        const back = yield* shell.until(
          "session-1",
          (thread) => thread.pinnedAt != null,
          "the pin",
        );
        assert.strictEqual(back.settledOverride, "active");
        assert.isNull(back.settledAt);
        assert.isNull(back.snoozedUntil ?? null);
        assert.isNull(back.pinOrderKey ?? null);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("one person's pins and order are theirs alone", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSessions(mend, ["session-1", "session-2"]);
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "ADA");
        const bea = yield* pairAndConnect(mend, "BEA", BEA);
        const adaShell = yield* watchShell(ada.rpc);
        const beaShell = yield* watchShell(bea.rpc);
        yield* adaShell.until("session-2", (thread) => thread.latestRunId !== null, "Ada's");
        yield* beaShell.until("session-2", (thread) => thread.latestRunId !== null, "Bea's");

        yield* dispatch(ada.rpc, "session-1", { type: "thread.pin", orderKey: "n" });
        yield* dispatch(ada.rpc, "session-2", { type: "thread.active.reorder", orderKey: "m" });
        yield* dispatch(bea.rpc, "session-2", { type: "thread.pin", orderKey: "d" });
        yield* adaShell.until("session-2", (thread) => thread.activeOrderKey === "m", "Ada's");
        yield* beaShell.until("session-2", (thread) => thread.pinOrderKey === "d", "Bea's");

        const places = (threads: ReadonlyMap<string, OrchestrationV2ThreadShell>) =>
          ["session-1", "session-2"].map((id) => {
            const thread = threads.get(id);
            return thread === undefined ? null : placeOf(thread);
          });
        assert.deepStrictEqual(places(adaShell.threads), [
          { pinned: true, pinOrderKey: "n", activeOrderKey: null },
          { pinned: false, pinOrderKey: null, activeOrderKey: "m" },
        ]);
        assert.deepStrictEqual(places(beaShell.threads), [
          { pinned: false, pinOrderKey: null, activeOrderKey: null },
          { pinned: true, pinOrderKey: "d", activeOrderKey: null },
        ]);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});

describe("automatic settlement", () => {
  it.live(
    "settles a thread quiet for t3code's default days, dated when it went quiet, unless opted out or pinned",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        withSessions(mend, ["session-1", "session-2", "session-3"]);
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AUTO");
          const shell = yield* watchShell(rpc);
          yield* shell.until("session-3", (thread) => thread.latestRunId !== null, "the threads");
          yield* dispatch(rpc, "session-2", { type: "thread.auto-settle.set", enabled: false });
          yield* dispatch(rpc, "session-3", { type: "thread.pin", orderKey: "n" });
          const optedOut = yield* shell.until(
            "session-2",
            (thread) => thread.autoSettleDisabledAt != null,
            "the opt-out",
          );
          assert.isNull(optedOut.settledOverride);

          assert.isNotNull(AUTO_SETTLE_AFTER_DAYS);
          const quietSince = new Date(
            Date.now() - (AUTO_SETTLE_AFTER_DAYS ?? 0) * DAY - HOUR,
          ).toISOString();
          for (const id of ["session-1", "session-2", "session-3"]) {
            ageTurns(mend, id, quietSince);
          }
          const settled = yield* shell.until(
            "session-1",
            (thread) => thread.settledOverride === "settled",
            "the automatic settle",
          );
          assert.strictEqual(iso(settled.settledAt), quietSince);
          yield* shell.until(
            "session-3",
            (thread) => iso(thread.latestRunCompletedAt) === quietSince,
            "the pinned thread read again",
          );
          assert.isNull(shell.threads.get("session-2")?.settledOverride);
          assert.isNull(shell.threads.get("session-3")?.settledOverride);

          yield* dispatch(rpc, "session-2", { type: "thread.auto-settle.set", enabled: true });
          const back = yield* shell.until(
            "session-2",
            (thread) => thread.settledOverride === "settled",
            "the settle once opted back in",
          );
          assert.isNull(back.autoSettleDisabledAt ?? null);
          assert.isTrue(onlyReads(mend));
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );

  it.effect("a quiet thread settles on the sweep's timer, with no read of the person's", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const timers = yield* GatewayTimers;
      withSessions(mend, ["session-1"]);
      const now = yield* Clock.currentTimeMillis;
      const dueInHalfAMinute = 30_000;
      const quietSince = new Date(
        now - (AUTO_SETTLE_AFTER_DAYS ?? 0) * DAY + dueInHalfAMinute,
      ).toISOString();
      ageTurns(mend, "session-1", quietSince);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "AUTO-TIMER");
        const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
        const snapshot = yield* TestClock.withLive(
          shell.next(
            (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "snapshot" }> =>
              item.kind === "snapshot" && item.snapshot.threads.length === 1,
          ),
        );
        assert.isNull(snapshot.snapshot.threads[0]?.settledOverride);
        yield* timers.runOut("1 minute", "the automatic settlement sweep");
        const settled = yield* TestClock.withLive(
          shell.next(
            (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "thread.updated" }> =>
              item.kind === "thread.updated" && item.thread.settledOverride === "settled",
          ),
        );
        assert.strictEqual(iso(settled.thread.settledAt), quietSince);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }).pipe(withGatewayTimers),
  );

  it.effect(
    "a quiet thread stays out of Settled while a background agent runs, or while its work cannot be read",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        const timers = yield* GatewayTimers;
        withSessions(mend, ["session-1", "session-2", "session-3"]);
        const now = yield* Clock.currentTimeMillis;
        const quietSince = new Date(now - (AUTO_SETTLE_AFTER_DAYS ?? 0) * DAY - HOUR).toISOString();
        for (const id of ["session-1", "session-2", "session-3"]) ageTurns(mend, id, quietSince);
        const turn = mend.workbench.turns.get("session-1")?.[0];
        assert.isDefined(turn);
        if (turn === undefined) return;
        const agent = mend.workbench.addItem(turn, {
          kind: "task",
          status: "in-progress",
          title: "Background agent",
          data: { taskId: "agent-1", taskType: "local_agent", description: "Review the change" },
        });
        mend.workbench.itemsUnavailable.add("session-3");
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AUTO-WORK");
          const shell = yield* watchShell(rpc, TestClock.withLive(Effect.sleep("50 millis")));
          yield* shell.until(
            "session-2",
            (thread) => thread.settledOverride === "settled",
            "the thread with no work settled",
          );
          const unsettled = () =>
            ["session-1", "session-3"].map((id) => shell.threads.get(id)?.settledOverride ?? null);
          assert.deepStrictEqual(unsettled(), [null, null]);

          yield* timers.runOut("1 minute", "the sweep with the agent still running");
          yield* timers.parked("1 minute", "the sweep done");
          assert.deepStrictEqual(unsettled(), [null, null]);

          mend.workbench.updateItem(agent, { status: "completed" });
          mend.workbench.itemsUnavailable.delete("session-3");
          yield* timers.runOut("1 minute", "the sweep once the agent ended");
          for (const id of ["session-1", "session-3"]) {
            const settled = yield* shell.until(
              id,
              (thread) => thread.settledOverride === "settled",
              `${id} settled`,
            );
            assert.strictEqual(iso(settled.settledAt), quietSince);
          }
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }).pipe(withGatewayTimers),
  );

  it.live(
    "a snooze ended by hand or by a pin starts the quiet clock again, across a restart",
    () => {
      const statePath = statePathOf();
      const ids = ["session-1", "session-2", "session-3", "session-4"];
      const wokeAt = (rpc: Rpc, id: string) =>
        rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: ThreadId.make(id) }).pipe(
          Effect.map((projection) => iso(projection.thread.lastSnoozeWakeAt)),
        );
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        withSessions(mend, ids);
        const quietSince = new Date(
          Date.now() - (AUTO_SETTLE_AFTER_DAYS ?? 0) * DAY - HOUR,
        ).toISOString();

        const woken = yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "WAKE");
          const shell = yield* watchShell(rpc);
          yield* shell.until("session-4", (thread) => thread.latestRunId !== null, "the threads");
          const snoozedUntil = new Date(Date.now() + HOUR).toISOString();
          for (const id of ["session-1", "session-3"]) {
            yield* dispatch(rpc, id, { type: "thread.snooze", snoozedUntil });
          }
          for (const id of ["session-2", "session-4"]) {
            yield* dispatch(rpc, id, { type: "thread.pin", orderKey: id });
          }
          for (const id of ids) ageTurns(mend, id, quietSince);
          yield* shell.until(
            "session-4",
            (thread) => iso(thread.latestRunCompletedAt) === quietSince,
            "the aged threads read",
          );

          yield* dispatch(rpc, "session-1", { type: "thread.unsnooze" });
          yield* dispatch(rpc, "session-3", { type: "thread.pin" });
          yield* dispatch(rpc, "session-3", { type: "thread.unpin" });
          // The control: unpinned, it goes quiet in the same sweep the woken threads would.
          yield* dispatch(rpc, "session-2", { type: "thread.unpin" });
          yield* shell.until(
            "session-2",
            (thread) => thread.settledOverride === "settled",
            "the control settled",
          );
          assert.deepStrictEqual(
            ["session-1", "session-3"].map((id) => shell.threads.get(id)?.settledOverride ?? null),
            [null, null],
          );
          assert.isNull(yield* wokeAt(rpc, "session-2"));
          return [yield* wokeAt(rpc, "session-1"), yield* wokeAt(rpc, "session-3")];
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
        for (const at of woken)
          assert.isTrue(at !== null && Date.parse(at) > Date.parse(quietSince));

        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "WAKE-AFTER");
          const shell = yield* watchShell(rpc);
          yield* dispatch(rpc, "session-4", { type: "thread.unpin" });
          yield* shell.until(
            "session-4",
            (thread) => thread.settledOverride === "settled",
            "the control settled after the restart",
          );
          assert.deepStrictEqual(
            ["session-1", "session-3"].map((id) => shell.threads.get(id)?.settledOverride ?? null),
            [null, null],
          );
          assert.deepStrictEqual(
            [yield* wokeAt(rpc, "session-1"), yield* wokeAt(rpc, "session-3")],
            woken,
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      });
    },
  );
});
