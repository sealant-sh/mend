import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { makeReplayLog } from "../src/replay.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Replay after a sequence (ADR 0012, phase 2): a client that resumes after a sequence the hub
 * still covers gets only what it missed; any other gets a snapshot, which t3code takes as a reset.
 */

type ShellItem = OrchestrationV2ShellStreamItem;
type Item = OrchestrationV2ThreadStreamItem;
const THREAD = ThreadId.make("session-1");

const setup = (mend: FakeMend) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1", label: "Before" });
};

/** The next item, whatever it is. */
const anyShellItem = (_item: ShellItem): _item is ShellItem => true;
const anyThreadItem = (_item: Item): _item is Item => true;
const isShellSnapshot = (item: ShellItem): item is Extract<ShellItem, { kind: "snapshot" }> =>
  item.kind === "snapshot";
const isThreadSnapshot = (item: Item): item is Extract<Item, { kind: "snapshot" }> =>
  item.kind === "snapshot";

describe("replay after a sequence", () => {
  it.live(
    "resumes the shell with only what changed, and answers a sequence it never stamped with a snapshot",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        setup(mend);
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SHELL");
          const before = yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* feed(rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
              return (yield* shell.next(isShellSnapshot)).snapshot.snapshotSequence;
            }),
          );
          // While the client is away, Mend renames the session.
          const session = mend.workbench.sessions.get("session-1");
          if (session !== undefined) session.label = "After";
          mend.workbench.emit({ type: "session", sessionId: "session-1", projectId: "project-1" });
          yield* Effect.sleep("300 millis");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* feed(
                rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
                  afterSequence: before,
                  requestCompletionMarker: true,
                }),
              );
              const first = yield* shell.next(anyShellItem);
              assert.strictEqual(first.kind, "thread.updated");
              assert.isTrue(first.kind === "thread.updated" && first.thread.title === "After");
              assert.isTrue(first.kind === "thread.updated" && first.sequence > before);
              yield* shell.next(
                (item): item is Extract<ShellItem, { kind: "synchronized" }> =>
                  item.kind === "synchronized",
              );
            }),
          );

          // A sequence this hub never stamped is a reset.
          const ahead = yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* feed(
                rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
                  afterSequence: before + 1_000_000_000,
                }),
              );
              return yield* shell.next(anyShellItem);
            }),
          );
          assert.strictEqual(ahead.kind, "snapshot");
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );

  it.live("resumes a thread with the events it missed while its client reconnected", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      const turn = mend.workbench.addTurn("session-1", "Explain the parser");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "THREAD");
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const thread = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
            );
            return (yield* thread.next(isThreadSnapshot)).snapshotSequence;
          }),
        );
        // The agent answers while the client is away.
        mend.workbench.addItem(turn, { kind: "assistant-message", text: "It reads tokens." });
        yield* Effect.sleep("300 millis");

        const resumed = yield* Effect.scoped(
          Effect.gen(function* () {
            const thread = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
                threadId: THREAD,
                afterSequence: before,
              }),
            );
            return yield* thread.next(anyThreadItem);
          }),
        );
        assert.strictEqual(resumed.kind, "event");
        assert.isTrue(resumed.kind === "event" && resumed.sequence > before);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "never reuses a sequence across a restart: an old one is answered with a snapshot",
    () => {
      const statePath = join(mkdtempSync(join(tmpdir(), "t3-gateway-replay-")), "state.sqlite");
      return Effect.gen(function* () {
        const mend = yield* startFakeMend;
        setup(mend);
        const shellOnce = (code: string, afterSequence?: number) =>
          Effect.gen(function* () {
            const { rpc } = yield* pairAndConnect(mend, code);
            const shell = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell](
                afterSequence === undefined ? {} : { afterSequence },
              ),
            );
            return yield* shell.next(anyShellItem);
          }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, statePath)));
        const first = yield* shellOnce("FIRST");
        assert.strictEqual(first.kind, "snapshot");
        const before = first.kind === "snapshot" ? first.snapshot.snapshotSequence : -1;
        const after = yield* shellOnce("SECOND", before);
        assert.strictEqual(after.kind, "snapshot");
        assert.isTrue(after.kind === "snapshot" && after.snapshot.snapshotSequence > before);
      });
    },
  );
});

describe("the replay log", () => {
  it("answers what came after a sequence it covers, and nothing it does not", () => {
    const log = makeReplayLog<string>(2, 10);
    log.push(11, "a");
    log.push(12, "b");
    assert.deepStrictEqual(log.since(10, 12), ["a", "b"]);
    assert.deepStrictEqual(log.since(12, 12), []);
    assert.isNull(log.since(13, 12));
    assert.isNull(log.since(9, 12));
    // Full: the oldest goes, and so does the floor.
    log.push(13, "c");
    assert.isNull(log.since(10, 13));
    assert.deepStrictEqual(log.since(11, 13), ["b", "c"]);
  });
});
