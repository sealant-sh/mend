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

import { makeReplayLog, makeSequencer } from "../src/replay.ts";
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

describe("replay sizes as they go out (595-R2-N1)", () => {
  it.live("answers a snapshot for a change past 1 MiB in UTF-8, short as it is in characters", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      setup(mend);
      const turn = mend.workbench.addTurn("session-1", "Explain it");
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "UTF8-BYTES");
        const before = yield* Effect.scoped(
          Effect.gen(function* () {
            const thread = yield* feed(
              rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
            );
            return (yield* thread.next(isThreadSnapshot)).snapshotSequence;
          }),
        );
        // 400,000 characters, 1.2 MB in UTF-8: past the 1 MiB a thread's replay keeps.
        const text = "漢".repeat(400_000);
        assert.isAbove(Buffer.byteLength(text), 1024 * 1024);
        mend.workbench.addItem(turn, { kind: "assistant-message", text });
        yield* Effect.sleep("500 millis");
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
        assert.strictEqual(resumed.kind, "snapshot");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});

describe("the replay log", () => {
  it("answers what came after a sequence it covers, and nothing it does not", () => {
    const log = makeReplayLog<string>({ capacity: 2, maxBytes: 1_000 }, 10);
    log.push(11, "a", 1);
    log.push(12, "b", 1);
    assert.deepStrictEqual(log.since(10, 12), ["a", "b"]);
    assert.deepStrictEqual(log.since(12, 12), []);
    assert.isNull(log.since(13, 12));
    assert.isNull(log.since(9, 12));
    // Full: the oldest goes, and so does the floor.
    log.push(13, "c", 1);
    assert.isNull(log.since(10, 13));
    assert.deepStrictEqual(log.since(11, 13), ["b", "c"]);
  });

  it("holds no more than its byte budget: what it lets go is answered with a snapshot", () => {
    const log = makeReplayLog<string>({ capacity: 128, maxBytes: 100 }, 0);
    log.push(1, "small", 10);
    log.push(2, "large", 80);
    assert.deepStrictEqual(log.since(0, 2), ["small", "large"]);
    log.push(3, "more", 20);
    assert.isNull(log.since(0, 3));
    assert.deepStrictEqual(log.since(1, 3), ["large", "more"]);
    // One change past the budget on its own is not kept either.
    log.push(4, "huge", 500);
    assert.isNull(log.since(3, 4));
    assert.deepStrictEqual(log.since(4, 4), []);
  });
});

describe("a hub's sequences", () => {
  it("stamps from its blocks, jumps to the next one, and owns only what it reserved", () => {
    const sequencer = makeSequencer({ start: 100, end: 104 });
    assert.strictEqual(sequencer.current(), 100);
    assert.isTrue(sequencer.owns(100));
    assert.strictEqual(sequencer.next(), 101);
    assert.isNull(sequencer.wants());
    assert.strictEqual(sequencer.next(), 102);
    assert.strictEqual(sequencer.wants(), 104);
    // Another hub took 104 to 107 in between.
    sequencer.add({ start: 108, end: 112 });
    assert.isNull(sequencer.wants());
    assert.strictEqual(sequencer.next(), 103);
    assert.strictEqual(sequencer.next(), 108);
    assert.isFalse(sequencer.owns(105));
    assert.isTrue(sequencer.owns(103));
    assert.isTrue(sequencer.owns(108));
    assert.isFalse(sequencer.overran());
  });

  it("owns nothing once it ran past every reservation, and says so once", () => {
    const sequencer = makeSequencer({ start: 0, end: 2 });
    sequencer.next();
    assert.strictEqual(sequencer.next(), 2);
    assert.isFalse(sequencer.owns(1));
    assert.isNull(sequencer.wants());
    assert.isTrue(sequencer.overran());
    assert.isFalse(sequencer.overran());
  });

  it("owns nothing without a reservation", () => {
    const sequencer = makeSequencer(null);
    assert.strictEqual(sequencer.next(), 1);
    assert.isFalse(sequencer.owns(0));
    assert.isNull(sequencer.wants());
  });
});
