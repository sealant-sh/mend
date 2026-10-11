import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { advanceClock } from "./support/fake-workbench.ts";
import { gatewayTestLayer, t3Client } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Read state (ADR 0012, phase 3): when the person last saw each thread, kept by the gateway as Mend
 * has none, the way the archive is. The shell carries `lastVisitedAt` and the descriptor
 * `threadVisitedTracking`, so t3code takes the gateway's read state as the person's on every
 * device; the unread marker is t3code's own client rule over it.
 */

const THREAD = ThreadId.make("session-1");
let commands = 0;
const commandId = () => CommandId.make(`visit-command-${++commands}`);

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];

const visit = (rpc: Rpc, visitedAt: string) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
    type: "thread.visit",
    commandId: commandId(),
    threadId: THREAD,
    visitedAt,
  });

const markUnread = (rpc: Rpc) =>
  rpc[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
    type: "thread.mark-unread",
    commandId: commandId(),
    threadId: THREAD,
  });

const iso = (value: DateTime.Utc | null | undefined): string | null =>
  value === null || value === undefined ? null : DateTime.formatIso(value);

/**
 * t3code's unread marker (`hasUnseenCompletion`, t3:apps/web/src/components/Sidebar.logic.ts:773
 * at the pin; it lives in the web app's sidebar, so it is restated here, not vendored): the latest
 * run completed after the last visit. A thread never visited shows nothing.
 */
const unread = (thread: OrchestrationV2ThreadShell): boolean => {
  const completedAt = iso(thread.latestRunCompletedAt);
  if (completedAt === null) return false;
  const visitedAt = iso(thread.lastVisitedAt);
  if (visitedAt === null) return false;
  return Date.parse(completedAt) > Date.parse(visitedAt);
};

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

const withSession = (mend: FakeMend) => {
  advanceClock(Date.now());
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
};

const statePathOf = () => join(mkdtempSync(join(tmpdir(), "t3-gateway-visits-")), "state.sqlite");

/** Every call the gateway made to Mend was a read: read state never reaches Mend. */
const onlyReads = (mend: FakeMend) =>
  mend.workbench.calls.every((call) => call.method === "GET" || call.path === "/api/me");

describe("read state", () => {
  it.live("is advertised, and a thread never seen carries a null watermark, not none", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      yield* Effect.gen(function* () {
        const client = yield* t3Client;
        const descriptor = yield* client.metadata.descriptor();
        assert.isTrue(descriptor.capabilities.threadVisitedTracking);
        const { rpc } = yield* pairAndConnect(mend, "VISIT-NONE");
        const shell = yield* watchShell(rpc);
        const thread = yield* shell.until((row) => row.latestRunId !== null, "the thread");
        // Present and null: t3code reads an absent field as "this server keeps no read state".
        assert.isTrue("lastVisitedAt" in thread);
        assert.isNull(thread.lastVisitedAt);
        assert.isFalse(unread(thread));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "a visit moves the watermark forward only; a later completion is unread; it survives a restart",
    () => {
      const statePath = statePathOf();
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        withSession(mend);
        const first = mend.workbench.addTurn("session-1", "First", "completed");
        const seenAt = yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "VISIT");
          const shell = yield* watchShell(rpc);
          const opened = yield* shell.until((row) => row.latestRunId !== null, "the thread");
          // What t3code sends on opening the thread: the shell's own `updatedAt`.
          const updatedAt = DateTime.formatIso(opened.updatedAt);
          yield* visit(rpc, updatedAt);
          const seen = yield* shell.until((row) => row.lastVisitedAt != null, "the visit");
          assert.strictEqual(iso(seen.lastVisitedAt), updatedAt);
          assert.isFalse(unread(seen));
          // Not activity: the thread's `updatedAt` stays where it was.
          assert.strictEqual(DateTime.formatIso(seen.updatedAt), updatedAt);
          // A visit delivered late never moves it back.
          yield* visit(rpc, first.createdAt);
          const kept = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
            threadId: THREAD,
          });
          assert.strictEqual(iso(kept.thread.lastVisitedAt), updatedAt);

          // The agent finishes another turn while the person is elsewhere.
          mend.workbench.addTurn("session-1", "Second", "completed");
          const done = yield* shell.until((row) => unread(row), "the unread completion");
          assert.strictEqual(iso(done.lastVisitedAt), updatedAt);
          assert.isTrue(onlyReads(mend));
          return updatedAt;
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));

        // Kept by the gateway's state file, so a restart (or another device) sees the same.
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "VISIT-AFTER");
          const shell = yield* watchShell(rpc);
          const after = yield* shell.until((row) => row.lastVisitedAt != null, "the kept visit");
          assert.strictEqual(iso(after.lastVisitedAt), seenAt);
          assert.isTrue(unread(after));
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
      });
    },
  );

  it.live("marks a thread unread just before its latest run completed, as t3code does", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      const turn = mend.workbench.addTurn("session-1", "Still going");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "UNREAD");
        const shell = yield* watchShell(rpc);
        yield* shell.until((row) => row.status === "running", "the running turn");
        // Nothing completed to mark: t3code's own server refuses it too.
        const none = yield* Effect.exit(markUnread(rpc));
        assert.strictEqual(tagOf(none), "OrchestrationV2DispatchCommandError");

        mend.workbench.setTurn(turn, "completed");
        const done = yield* shell.until((row) => row.latestRunCompletedAt != null, "the end");
        yield* visit(rpc, DateTime.formatIso(done.updatedAt));
        const read = yield* shell.until((row) => row.lastVisitedAt != null, "the visit");
        assert.isFalse(unread(read));

        yield* markUnread(rpc);
        const marked = yield* shell.until((row) => unread(row), "the mark");
        const completedAt = iso(marked.latestRunCompletedAt);
        assert.isNotNull(completedAt);
        assert.strictEqual(
          Date.parse(iso(marked.lastVisitedAt) ?? ""),
          Date.parse(completedAt ?? "") - 1,
        );
        // Opening it again reads it.
        yield* visit(rpc, DateTime.formatIso(marked.updatedAt));
        yield* shell.until((row) => !unread(row), "the second visit");
        assert.isTrue(onlyReads(mend));
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("one person's read state is theirs alone", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      withSession(mend);
      mend.workbench.addTurn("session-1", "Done already", "completed");
      yield* Effect.gen(function* () {
        const ada = yield* pairAndConnect(mend, "VISIT-ADA");
        const bea = yield* pairAndConnect(mend, "VISIT-BEA", {
          id: "user-2",
          name: "Bea",
          email: "bea@example.com",
        });
        const adaShell = yield* watchShell(ada.rpc);
        const opened = yield* adaShell.until((row) => row.latestRunId !== null, "Ada's thread");
        yield* visit(ada.rpc, DateTime.formatIso(opened.updatedAt));
        yield* adaShell.until((row) => row.lastVisitedAt != null, "Ada's visit");
        const beas = yield* bea.rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: THREAD,
        });
        assert.isNull(beas.thread.lastVisitedAt);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
