import {
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
  type OrchestrationV2SearchThreadInput,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const THREAD = ThreadId.make("session-1");

const seed = (mend: FakeMend, turns: ReadonlyArray<readonly [input: string, answer: string]>) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
  for (const [input, answer] of turns) {
    const turn = mend.workbench.addTurn("session-1", input, "completed");
    mend.workbench.addItem(turn, { kind: "assistant-message", text: answer });
  }
};

const connect = (mend: FakeMend, code: string) =>
  Effect.gen(function* () {
    const { rpc } = yield* pairAndConnect(mend, code);
    const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
      threadId: THREAD,
    });
    const entries = projection.visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message" ? [item.messageId] : [],
    );
    const search = (input: Omit<OrchestrationV2SearchThreadInput, "threadId">) =>
      rpc[ORCHESTRATION_V2_WS_METHODS.searchThread]({ threadId: THREAD, ...input });
    const frames = (input: Omit<OrchestrationV2SearchThreadInput, "threadId">) =>
      rpc[ORCHESTRATION_V2_WS_METHODS.searchThreadStream]({ threadId: THREAD, ...input }).pipe(
        Stream.runCollect,
      );
    return { rpc, entries, search, frames };
  });

describe("find in a thread", () => {
  it.live("is advertised in the config, progressive included", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, []);
        const { rpc } = yield* pairAndConnect(mend, "FINDCONF");
        const config = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.isTrue(config.threadFind);
        assert.isTrue(config.threadFindProgressive);
      }),
    ),
  );

  it.live("counts the text a message renders, in thread order", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [
          ["Check **the build**", "check the build twice: check the build"],
          ["Read the docs", "[documentation](https://hidden.example/needle)"],
        ]);
        const { entries, search } = yield* connect(mend, "FINDTEXT");
        const [user, assistant] = entries;
        const matches = [];
        for (let index = 0; index < 3; index++) {
          const result = yield* search({ query: "CHECK THE BUILD", index });
          assert.strictEqual(result.totalMatches, 3);
          matches.push([result.match?.entryId, result.match?.occurrence]);
        }
        assert.deepStrictEqual(matches, [
          [user, 0],
          [assistant, 0],
          [assistant, 1],
        ]);
        assert.strictEqual((yield* search({ query: "hidden.example" })).totalMatches, 0);
        assert.strictEqual((yield* search({ query: "documentation" })).totalMatches, 1);
        assert.strictEqual((yield* search({ query: "check", index: 99 })).activeIndex, 2);
        const none = yield* search({ query: "absent" });
        assert.deepStrictEqual([none.totalMatches, none.match, none.navigation], [0, null, []]);
      }),
    ),
  );

  it.live("starts at the reading position, steps by offset and wraps", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [
          ["needle", "needle above, needle below"],
          ["nothing", "needle"],
        ]);
        const { entries, search } = yield* connect(mend, "FINDSTEP");
        const [first, reading, between, last] = entries;
        if (first === undefined || reading === undefined || between === undefined) {
          return assert.fail("the thread has four messages");
        }
        const from = (entryId: string, occurrence = 0) =>
          search({ query: "needle", start: { entryId, occurrence } });
        assert.strictEqual((yield* from(reading)).activeIndex, 1);
        const below = yield* from(reading, 1);
        assert.deepStrictEqual([below.activeIndex, below.match?.occurrence], [2, 1]);
        assert.strictEqual((yield* from(between)).match?.entryId, last);
        assert.strictEqual((yield* from(reading, 2)).activeIndex, 3);
        const next = yield* search({
          query: "needle",
          start: { entryId: reading, occurrence: 1 },
          offset: 1,
        });
        assert.deepStrictEqual([next.activeIndex, next.match?.entryId], [3, last]);
        const wrapped = yield* search({
          query: "needle",
          start: { entryId: reading, occurrence: 1 },
          offset: 2,
        });
        assert.deepStrictEqual([wrapped.activeIndex, wrapped.match?.entryId], [0, first]);
        const back = yield* search({ query: "needle", offset: -1 });
        assert.deepStrictEqual([back.activeIndex, back.match?.entryId], [3, last]);
      }),
    ),
  );

  it.live("streams the reading-position match first, then the full count", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [
          ["before progressive needle needle", "reading progressive needle needle"],
          ["after progressive needle", "nothing here"],
        ]);
        const { entries, frames } = yield* connect(mend, "FINDSTREAM");
        const [, reading] = entries;
        if (reading === undefined) return assert.fail("the thread has messages");
        const streamed = yield* frames({
          query: "needle",
          start: { entryId: reading, occurrence: 1 },
        });
        assert.strictEqual(streamed.length, 2);
        const [early, counted] = streamed;
        assert.strictEqual(early?.complete, false);
        assert.deepStrictEqual(early?.match, {
          entryId: reading,
          runId: early?.match?.runId ?? null,
          occurrence: 1,
        });
        assert.notStrictEqual(counted?.complete, false);
        assert.deepStrictEqual(counted?.match, early?.match);
        assert.deepStrictEqual([counted?.totalMatches, counted?.activeIndex], [5, 3]);
        const stepped = yield* frames({ query: "needle", offset: 1 });
        assert.deepStrictEqual(
          stepped.map((frame) => [frame.complete, frame.match?.occurrence]),
          [[undefined, 1]],
        );
        const absent = yield* frames({ query: "missing" });
        assert.deepStrictEqual(
          absent.map((frame) => [frame.complete, frame.totalMatches]),
          [[undefined, 0]],
        );
      }),
    ),
  );

  it.live("keeps the navigation to 17 entries around the selection", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(
          mend,
          Array.from({ length: 15 }, (_, i) => [
            "needle ".repeat(((2 * i) % 3) + 1),
            "needle ".repeat(((2 * i + 1) % 3) + 1),
          ]),
        );
        const { entries, search } = yield* connect(mend, "FINDNAV");
        const reading = entries[14];
        if (reading === undefined) return assert.fail("the thread has thirty messages");
        const current = yield* search({
          query: "needle",
          start: { entryId: reading, occurrence: 1 },
        });
        assert.deepStrictEqual([current.totalMatches, current.activeIndex], [60, 28]);
        assert.deepStrictEqual(
          current.navigation?.map((entry) => entry.entryId),
          entries.slice(6, 23),
        );
        assert.deepStrictEqual(
          current.navigation?.find((entry) => entry.entryId === reading),
          { entryId: reading, runId: current.match?.runId ?? null, startIndex: 27, count: 3 },
        );
        const first = yield* search({ query: "needle" });
        assert.strictEqual(first.navigation?.length, 17);
        assert.include(first.navigation?.map((entry) => entry.entryId) ?? [], entries[29]);
      }),
    ),
  );

  it.live("reads skill labels and file links as the client shows them", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["Use $test-t3-app now", "See `docs/notes.md:12`."]]);
        const { search } = yield* connect(mend, "FINDLABEL");
        const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
        assert.strictEqual((yield* search({ query: "T3 App Testing", skills })).totalMatches, 1);
        assert.strictEqual((yield* search({ query: "T3 App Testing" })).totalMatches, 0);
        assert.strictEqual((yield* search({ query: "notes.md · L12" })).totalMatches, 1);
      }),
    ),
  );

  it.live("fails typed for a thread the person does not have", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, []);
        const { rpc } = yield* pairAndConnect(mend, "FINDNONE");
        const exit = yield* Effect.exit(
          rpc[ORCHESTRATION_V2_WS_METHODS.searchThread]({
            threadId: ThreadId.make("no-such-thread"),
            query: "needle",
          }),
        );
        const failure = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        assert.strictEqual(failure?._tag, "OrchestrationV2SearchThreadError");
      }),
    ),
  );
});
