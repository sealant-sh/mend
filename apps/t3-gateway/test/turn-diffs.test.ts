import { assert, describe, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadStreamItem,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import type { MendCheckpoint, MendTurn } from "../src/mend-workbench.ts";
import { isSharedChain, SHARED_CHAIN_NOTICE, turnSlicesOf } from "../src/turn-checkpoints.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * Per-turn diffs (ADR 0012, phase 3): each ended turn's checkpoint, correlated by session and
 * time, with its files on t3code's card, and `getTurnDiff` / `getFullThreadDiff` from Mend's
 * `GET /api/worktrees/:id/diff`.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

type Item = OrchestrationV2ThreadStreamItem;
const THREAD = ThreadId.make("session-1");

const tagOf = (exit: Exit.Exit<unknown, unknown>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : undefined;
};

describe("per-turn diffs", () => {
  it.live("shows each ended turn's files, and serves its diff and the thread's", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        const start = mend.workbench.addCheckpoint("session-1", "session-start");
        const first = mend.workbench.addTurn("session-1", "Add a parser");
        mend.workbench.setTurn(first, "completed");
        const one = mend.workbench.addCheckpoint("session-1");
        mend.workbench.ranges.set(`${start}..${one}`, {
          diff: "diff --git a/parser.ts b/parser.ts\n",
          files: [{ path: "parser.ts", status: "added", additions: 12, deletions: 0 }],
        });

        const { rpc } = yield* pairAndConnect(mend, "TURNS");
        const thread = yield* feed(
          rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({ threadId: THREAD }),
        );
        // The card arrives once the gateway read the turn's files: a checkpoint of run 1.
        const captured = yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" && item.event.type === "checkpoint.captured",
        );
        assert.isTrue(
          captured.event.type === "checkpoint.captured" &&
            captured.event.payload.appRunOrdinal === 1 &&
            captured.event.payload.status === "ready" &&
            captured.event.payload.files[0]?.path === "parser.ts" &&
            captured.event.payload.files[0]?.kind === "added",
        );

        const full = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]({
          threadId: THREAD,
          toTurnCount: 1,
        });
        assert.strictEqual(full.diff, "diff --git a/parser.ts b/parser.ts\n");

        // A second turn: its diff runs from the first turn's checkpoint.
        const second = mend.workbench.addTurn("session-1", "Test it");
        mend.workbench.setTurn(second, "completed");
        const two = mend.workbench.addCheckpoint("session-1");
        mend.workbench.ranges.set(`${one}..${two}`, {
          diff: "diff --git a/parser.test.ts b/parser.test.ts\n",
          files: [{ path: "parser.test.ts", status: "added", additions: 30, deletions: 0 }],
        });
        mend.workbench.emit({
          type: "agent-conversation",
          sessionId: "session-1",
          projectId: "project-1",
        });
        yield* thread.next(
          (item): item is Extract<Item, { kind: "event" }> =>
            item.kind === "event" &&
            item.event.type === "checkpoint.captured" &&
            item.event.payload.appRunOrdinal === 2,
        );
        const turn = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
          threadId: THREAD,
          fromTurnCount: 1,
          toTurnCount: 2,
        });
        assert.strictEqual(turn.diff, "diff --git a/parser.test.ts b/parser.test.ts\n");

        // A turn Mend has no checkpoint for is the method's own error.
        const missing = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
            threadId: THREAD,
            fromTurnCount: 2,
            toTurnCount: 3,
          }),
        );
        assert.strictEqual(tagOf(missing), "OrchestrationGetTurnDiffError");
      }),
    ),
  );
});

const turn = (id: string, ordinal: number, start: string, end: string | null): MendTurn => ({
  id,
  sessionId: "s",
  ordinal,
  author: null,
  input: id,
  status: end === null ? "running" : "completed",
  error: null,
  createdAt: start,
  startedAt: start,
  endedAt: end,
});
const checkpoint = (
  ordinal: number,
  sessionId: string | null,
  trigger: string,
  createdAt: string,
): MendCheckpoint => ({
  id: `c${ordinal}`,
  sessionId,
  ordinal,
  ref: `refs/c/${ordinal}`,
  trigger,
  createdAt,
});
const T = (second: number) => `2026-10-10T09:00:${String(second).padStart(2, "0")}.000Z`;

describe("correlating checkpoints with turns", () => {
  it("takes a turn's last turn-boundary of its session, and starts it where the worktree stood", () => {
    const turns = [
      turn("t1", 0, T(10), T(20)),
      turn("t2", 1, T(30), T(40)),
      turn("t3", 2, T(50), null),
    ];
    const chain = [
      checkpoint(0, null, "session-start", T(1)),
      checkpoint(1, "s", "command-settle", T(15)),
      checkpoint(2, "s", "turn-boundary", T(21)),
      checkpoint(3, "other", "turn-boundary", T(25)),
      checkpoint(4, "s", "turn-boundary", T(41)),
    ];
    const slices = turnSlicesOf("s", turns, chain);
    assert.deepStrictEqual(
      Array.from(slices, ([id, slice]) => [id, slice.from?.id ?? "base", slice.to.id]),
      [
        ["t1", "c0", "c2"],
        // Another session's checkpoint between the turns is where t2 started.
        ["t2", "c3", "c4"],
      ],
    );
    assert.isTrue(isSharedChain("s", chain));
    assert.isFalse(
      isSharedChain(
        "s",
        chain.filter((c) => c.sessionId !== "other"),
      ),
    );
    assert.isAbove(SHARED_CHAIN_NOTICE.length, 0);
  });
});
