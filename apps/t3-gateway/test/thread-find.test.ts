import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  AuthSessionId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type OrchestrationV2SearchThreadInput,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { AssetUrls } from "../src/assets.ts";
import { GRANTED_SCOPES } from "../src/auth.ts";
import { GatewayConfig } from "../src/config.ts";
import { GatewayEnvironment, makeGatewayEnvironment } from "../src/environment.ts";
import { FindParser, findParserLayer, PARSED_TEXT_LIMIT } from "../src/find-parser.ts";
import { Projections, ProjectionsLive, type PersonHub, type ThreadSnapshot } from "../src/hub.ts";
import { rpcScopeAuthorizationLayer } from "../src/rpc-scopes.ts";
import { gatewayRpcHandlersLayer } from "../src/rpc.ts";
import { findsInThread } from "../src/server-config.ts";
import { MendClientFetchLive } from "../src/server.ts";
import { GatewayStateLive, type BearerSession } from "../src/state.ts";
import { FIND_CACHE_LIMITS, makeThreadFinder } from "../src/thread-find.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { inlineFindParser, recordingFindParser } from "./support/find-parser.ts";
import { gatewayTestLayer, PERSON } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";
import { testBearerSession } from "./support/stubs.ts";

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
  it.live("is advertised to clients from v0.1.1 on, progressive included, and to no other", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, []);
        const advertised = [];
        for (const [code, version] of [
          ["FINDV011", "0.1.0"],
          ["FINDPIN", "0.0.45"],
          ["FINDNOVER", null],
          ["FINDJUNK", "nightly"],
        ] as const) {
          const { rpc } = yield* pairAndConnect(mend, code, PERSON, undefined, version);
          const config = yield* rpc[WS_METHODS.serverGetConfig]({});
          advertised.push([version, config.threadFind, config.threadFindProgressive]);
        }
        assert.deepStrictEqual(advertised, [
          ["0.1.0", true, true],
          ["0.0.45", false, false],
          [null, false, false],
          ["nightly", false, false],
        ]);
      }),
    ),
  );

  it("reads the client's version as a release that renders Codex follow-ups as v0.1.1 does", () => {
    const finding = ["0.1.0", "0.1.3", "0.2.0", "1.0.0", "0.1.0+build.7"];
    const older = [
      undefined,
      "",
      "0.0.45",
      "0.0.99",
      "0.1.0-nightly.1",
      "0.1",
      "v0.1.0",
      "0.1.0.1",
    ];
    assert.deepStrictEqual(finding.filter(findsInThread), finding);
    assert.deepStrictEqual(older.filter(findsInThread), []);
  });

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

const completeFlags = (streamed: ReadonlyArray<{ readonly complete?: boolean }>) =>
  streamed.map((frame) => frame.complete);

const snapshotOf = (mend: FakeMend, code: string) =>
  Effect.gen(function* () {
    const { rpc } = yield* pairAndConnect(mend, code);
    const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
      threadId: THREAD,
    });
    const snapshot: ThreadSnapshot = { snapshotSequence: 1, projection };
    return snapshot;
  });

const longMessage = (i: number) =>
  [
    `## Step ${i}: parse the **quoted** fields`,
    ...Array.from(
      { length: 6 },
      (_, line) =>
        `- Line ${line} reads \`row[${line}]\`, splits on [commas](https://example.com/${i}/${line}) and keeps _quoted_ text.`,
    ),
    "```ts",
    `const row${i} = parse(input, { quote: '"' });`,
    "```",
  ].join("\n");

const repeatedNeedles = (i: number) => `needle ${i} `.repeat(800);

const retainedHeap = (() => {
  setFlagsFromString("--expose_gc");
  const gc: unknown = runInNewContext("gc");
  return () => {
    if (typeof gc === "function") gc();
    return process.memoryUsage().heapUsed;
  };
})();

const besideATicker = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const gaps: Array<number> = [];
    const ticker = yield* Effect.gen(function* () {
      let last = performance.now();
      for (;;) {
        yield* Effect.sleep("2 millis");
        const now = performance.now();
        gaps.push(now - last);
        last = now;
      }
    }).pipe(Effect.forkChild);
    const started = performance.now();
    const result = yield* effect;
    const took = performance.now() - started;
    yield* Fiber.interrupt(ticker);
    return { result, took, longestGap: Math.max(0, ...gaps) };
  });

const withAnswer = (snapshot: ThreadSnapshot, text: string): ThreadSnapshot => ({
  ...snapshot,
  projection: {
    ...snapshot.projection,
    visibleTurnItems: snapshot.projection.visibleTurnItems.map((entry) =>
      entry.item.type === "assistant_message" ? { ...entry, item: { ...entry.item, text } } : entry,
    ),
  },
});

const withQuestion = (snapshot: ThreadSnapshot, text: string): ThreadSnapshot => ({
  ...snapshot,
  projection: {
    ...snapshot.projection,
    visibleTurnItems: snapshot.projection.visibleTurnItems.map((entry) =>
      entry.item.type === "user_message" ? { ...entry, item: { ...entry.item, text } } : entry,
    ),
  },
});

const SLOW_TO_PARSE = `${"[".repeat(PARSED_TEXT_LIMIT / 2)}${"]".repeat(PARSED_TEXT_LIMIT / 2)}`;

const needleLinks = (length: number) => {
  const link = "[needle](https://example.com/needle) ";
  const links = Math.floor(length / link.length);
  return { text: link.repeat(links), links };
};

describe("find in a thread, as a shared gateway runs it", () => {
  it.live("answers a query asked again of an unchanged thread with the count alone", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["needle here", "needle there, needle again"]]);
        const { rpc, frames } = yield* connect(mend, "FINDAGAIN");
        assert.deepStrictEqual(completeFlags(yield* frames({ query: "needle" })), [
          false,
          undefined,
        ]);
        const again = yield* frames({ query: "needle" });
        assert.deepStrictEqual(completeFlags(again), [undefined]);
        assert.strictEqual(again[0]?.totalMatches, 3);

        const turn = mend.workbench.addTurn("session-1", "one more needle", "completed");
        mend.workbench.addItem(turn, { kind: "assistant-message", text: "noted" });
        yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD }).pipe(
          Effect.filterOrFail(({ visibleTurnItems }) => visibleTurnItems.length > 2),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
        );
        const changed = yield* frames({ query: "needle" });
        assert.deepStrictEqual(completeFlags(changed), [false, undefined]);
        assert.strictEqual(changed.at(-1)?.totalMatches, 4);
      }),
    ),
  );

  it.live("lets other work run while it scans a long thread, and stops when interrupted", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(
          mend,
          Array.from({ length: 750 }, (_, i) => [longMessage(2 * i), longMessage(2 * i + 1)]),
        );
        const snapshot = yield* snapshotOf(mend, "FINDLONG");
        const parser = yield* FindParser;
        const search = { threadId: THREAD, query: "absent" };

        const {
          result: counted,
          took: scanned,
          longestGap,
        } = yield* besideATicker(makeThreadFinder(parser).searchThread(snapshot, search));
        assert.strictEqual(counted.totalMatches, 0);
        assert.isAbove(scanned, 4 * longestGap, `scan ${scanned} ms, longest gap ${longestGap} ms`);
        assert.isBelow(longestGap, 150);

        const interrupted = yield* makeThreadFinder(parser)
          .searchThreadStream(snapshot, search)
          .pipe(Stream.runCollect, Effect.forkChild);
        yield* Effect.sleep("10 millis");
        const asked = performance.now();
        const exit = yield* Fiber.interrupt(interrupted).pipe(
          Effect.andThen(Fiber.await(interrupted)),
        );
        const stopped = performance.now() - asked;
        assert.isTrue(Exit.hasInterrupts(exit));
        assert.isBelow(stopped, 150);
        assert.isAbove(scanned, 4 * stopped, `scan ${scanned} ms, interrupt ${stopped} ms`);
      }).pipe(Effect.provide(findParserLayer())),
    ),
  );

  it.live("parses a message off the event loop, and counts what it renders", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["Where is the needle?", "here"]]);
        const { text, links } = needleLinks(PARSED_TEXT_LIMIT);
        const snapshot = withQuestion(
          withAnswer(yield* snapshotOf(mend, "FINDLARGE"), text),
          SLOW_TO_PARSE,
        );
        const parser = yield* FindParser;
        const { result, took, longestGap } = yield* besideATicker(
          makeThreadFinder(parser).searchThread(snapshot, { threadId: THREAD, query: "needle" }),
        );
        assert.strictEqual(result.totalMatches, links);
        assert.isBelow(longestGap, 50, `find ${took} ms, longest gap ${longestGap} ms`);
        assert.isAbove(took, 4 * longestGap, `find ${took} ms, longest gap ${longestGap} ms`);
      }).pipe(Effect.provide(findParserLayer())),
    ),
  );

  it.live("counts a message longer than it parses over its text as written", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["Where is the needle?", "here"]]);
        const { text, links } = needleLinks(4 * 1024 * 1024);
        const snapshot = withQuestion(withAnswer(yield* snapshotOf(mend, "FINDHUGE"), text), text);
        const parser = yield* FindParser;
        const { result, took, longestGap } = yield* besideATicker(
          makeThreadFinder(parser).searchThread(snapshot, { threadId: THREAD, query: "needle" }),
        );
        assert.strictEqual(result.totalMatches, 4 * links);
        assert.isBelow(took, 1_000, `find ${took} ms, longest gap ${longestGap} ms`);
        assert.isBelow(longestGap, 100, `find ${took} ms, longest gap ${longestGap} ms`);
      }).pipe(Effect.provide(findParserLayer())),
    ),
  );

  it.live("stops the parse of a find it no longer runs", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["Where is the needle?", "needle"]]);
        const small = yield* snapshotOf(mend, "FINDSTOP");
        const slow = withQuestion(small, SLOW_TO_PARSE);
        const parser = yield* FindParser;
        const search = { threadId: THREAD, query: "needle" };
        const abandoned = yield* makeThreadFinder(parser)
          .searchThread(slow, search)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("500 millis");
        const asked = performance.now();
        const exit = yield* Fiber.interrupt(abandoned).pipe(Effect.andThen(Fiber.await(abandoned)));
        const stopped = performance.now() - asked;
        assert.isTrue(Exit.hasInterrupts(exit));
        assert.isBelow(stopped, 50);

        const cpu = process.cpuUsage();
        yield* Effect.sleep("1 second");
        const { user, system } = process.cpuUsage(cpu);
        assert.isBelow((user + system) / 1_000, 200, "CPU spent in the second after the interrupt");

        const next = yield* makeThreadFinder(parser).searchThread(small, search);
        assert.strictEqual(next.totalMatches, 2);
      }).pipe(Effect.provide(findParserLayer())),
    ),
  );

  it.live("hashes a very large message in slices, letting other work run", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["Where is the needle?", "here"]]);
        // Flat, as a message read from JSON is: a rope would be flattened in one go.
        const huge = Buffer.alloc(128 * 1024 * 1024, "x").toString("latin1");
        const snapshot = withAnswer(yield* snapshotOf(mend, "FINDHASH"), huge);
        const finder = makeThreadFinder({ segments: () => Effect.succeed([]) });
        const { took, longestGap } = yield* besideATicker(
          finder.searchThread(snapshot, { threadId: THREAD, query: "needle" }),
        );
        assert.isBelow(longestGap, 30, `find ${took} ms, longest gap ${longestGap} ms`);
        assert.isAbove(took, 3 * longestGap, `find ${took} ms, longest gap ${longestGap} ms`);
      }),
    ),
  );

  it.live("tells apart messages that differ only in an unpaired surrogate", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["prefix \uD800", "answer"]]);
        const before = yield* snapshotOf(mend, "FINDSURROGATE");
        const after = withQuestion(before, "prefix \uD801");
        const finder = makeThreadFinder(inlineFindParser);
        const search = { threadId: THREAD, query: "\uD801" };
        assert.strictEqual((yield* finder.searchThread(before, search)).totalMatches, 0);
        assert.strictEqual((yield* finder.searchThread(after, search)).totalMatches, 1);
      }),
    ),
  );

  it.live("parses each message once per find, even with nothing cached", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [
          ["needle one", "needle two"],
          ["needle three", "needle four"],
          ["needle five", "needle six"],
        ]);
        const { entries } = yield* connect(mend, "FINDONCE");
        const snapshot = yield* snapshotOf(mend, "FINDONCE2");
        const reading = entries[2];
        if (reading === undefined) return assert.fail("the thread has six messages");
        const { parser, asked } = recordingFindParser();
        const finder = makeThreadFinder(parser, {
          parses: { entries: 512, bytes: 0 },
          scans: { entries: 8, bytes: 0 },
        });
        const streamed = yield* finder
          .searchThreadStream(snapshot, {
            threadId: THREAD,
            query: "needle",
            start: { entryId: reading, occurrence: 0 },
          })
          .pipe(Stream.runCollect);
        assert.deepStrictEqual(completeFlags(streamed), [false, undefined]);
        assert.strictEqual(streamed.at(-1)?.totalMatches, 6);
        assert.deepStrictEqual(
          asked.map(({ text }) => text),
          ["needle three", "needle one", "needle two", "needle four", "needle five", "needle six"],
        );
      }),
    ),
  );

  it.live("keeps the person's parses within a byte budget, whatever skill lists they send", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [
          ["Use $skill-1 for the needle", "Then $skill-2 finds the needle"],
          ["Read **the needle** docs", "[needle](https://example.com/needle)"],
        ]);
        const snapshot = yield* snapshotOf(mend, "FINDBYTES");
        // As large a skill list as the contract allows: 1,000 skills, 200-character names.
        const longest = "s".repeat(190);
        const skillsFor = (request: number) =>
          Array.from({ length: 1_000 }, (_, i) => ({
            name: `${request}-${i}-${longest}`.slice(0, 200),
            displayName: longest,
          }));
        const finder = makeThreadFinder(inlineFindParser);
        const before = retainedHeap();
        for (let request = 0; request < 520; request++) {
          const found = yield* finder.searchThread(snapshot, {
            threadId: THREAD,
            query: "needle",
            skills: skillsFor(request),
          });
          assert.strictEqual(found.totalMatches, 4);
        }
        const grown = retainedHeap() - before;
        const budget = FIND_CACHE_LIMITS.parses.bytes + FIND_CACHE_LIMITS.scans.bytes;
        assert.isAtMost(finder.retainedBytes(), budget);
        assert.isBelow(grown, budget + 8 * 1024 * 1024, `heap grew ${grown} bytes`);
      }),
    ),
  );

  it.live("evicts the oldest parses past its byte budget and still counts right", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(
          mend,
          Array.from({ length: 10 }, (_, i) => [
            repeatedNeedles(2 * i),
            repeatedNeedles(2 * i + 1),
          ]),
        );
        const snapshot = yield* snapshotOf(mend, "FINDEVICT");
        const limits = {
          parses: { entries: 512, bytes: 96 * 1024 },
          scans: { entries: 8, bytes: 16 * 1024 },
        };
        const finder = makeThreadFinder(inlineFindParser, limits);
        for (const query of ["needle", "needle 1", "needle"]) {
          const found = yield* finder.searchThread(snapshot, { threadId: THREAD, query });
          assert.strictEqual(found.totalMatches, query === "needle" ? 16_000 : 800 * 11);
          assert.isAtMost(finder.retainedBytes(), limits.parses.bytes + limits.scans.bytes);
          assert.isAbove(finder.retainedBytes(), 0);
        }
      }),
    ),
  );
});

const environment = makeGatewayEnvironment({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Mend",
  host: "127.0.0.1",
  statePath: ":memory:",
});

const assetUrls: AssetUrls["Service"] = {
  issue: () => Effect.succeed({ relativeUrl: "/api/assets/x/y", expiresAt: 0 }),
  resolve: () => Effect.succeedNone,
};

const projectionsOver = (mendUrl: URL) =>
  ProjectionsLive.pipe(
    Layer.provideMerge(Layer.mergeAll(MendClientFetchLive, GatewayStateLive, findParserLayer())),
    Layer.provideMerge(
      Layer.succeed(GatewayConfig)({
        mendUrl,
        host: "127.0.0.1",
        port: 0,
        statePath: ":memory:",
        label: "Mend under test",
      }),
    ),
  );

const deviceClient = (session: BearerSession, hub: PersonHub) =>
  RpcTest.makeClient(WsRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        gatewayRpcHandlersLayer(session, hub, "0.1.0"),
        rpcScopeAuthorizationLayer(GRANTED_SCOPES),
      ).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(GatewayEnvironment)(environment),
            Layer.succeed(AssetUrls)(assetUrls),
          ),
        ),
      ),
    ),
  );

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
    ),
  );

const sessionOf = (claim: FakeMend["claims"][number]): BearerSession => ({
  ...testBearerSession,
  deviceToken: claim.token,
  mendDeviceId: claim.deviceId,
});

describe("find in a thread, across people", () => {
  it.live("keeps each person's caches to their own hub", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["the needle", "needle, needle"]]);
        const snapshot = yield* snapshotOf(mend, "FINDADA");
        const [claim] = mend.claims;
        if (claim === undefined) return assert.fail("Ada paired");
        const ada = sessionOf(claim);
        const bea: BearerSession = {
          ...ada,
          sessionId: AuthSessionId.make("session-bea"),
          deviceToken: "mdt_bea",
          mendUser: { id: "user-bea", name: "Bea", email: "bea@example.com" },
        };
        yield* Effect.gen(function* () {
          const projections = yield* Projections;
          const adaHub = yield* projections.hub(ada);
          const beaHub = yield* projections.hub(bea);
          const search = { threadId: THREAD, query: "needle" };
          const framesOf = (hub: PersonHub) =>
            hub.threadFinder.searchThreadStream(snapshot, search).pipe(Stream.runCollect);
          assert.deepStrictEqual(completeFlags(yield* framesOf(adaHub)), [false, undefined]);
          assert.deepStrictEqual(completeFlags(yield* framesOf(adaHub)), [undefined]);
          assert.strictEqual(beaHub.threadFinder.retainedBytes(), 0);
          assert.deepStrictEqual(completeFlags(yield* framesOf(beaHub)), [false, undefined]);
        }).pipe(Effect.provide(projectionsOver(mend.url)));
      }),
    ),
  );
});

describe("find in a thread, for a device Mend revoked", () => {
  it.live("is refused from the person's warm hub, for both methods", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        seed(mend, [["the secret needle", "needle"]]);
        yield* pairAndConnect(mend, "LAPTOP");
        yield* pairAndConnect(mend, "TABLET");
        const [laptopClaim, tabletClaim] = mend.claims;
        if (laptopClaim === undefined || tabletClaim === undefined) {
          return assert.fail("both devices paired");
        }
        const laptop = sessionOf(laptopClaim);
        const tablet = sessionOf(tabletClaim);
        yield* Effect.gen(function* () {
          const projections = yield* Projections;
          const hub = yield* projections.hub(laptop);
          const warmThread = yield* hub.subscribeThread(THREAD);
          assert.isNotNull(warmThread);
          const tabletClient = yield* deviceClient(tablet, yield* projections.hub(tablet));
          const laptopClient = yield* deviceClient(laptop, hub);
          const search = { threadId: THREAD, query: "needle" };
          const served = yield* tabletClient[ORCHESTRATION_V2_WS_METHODS.searchThread](search);
          assert.strictEqual(served.totalMatches, 2);

          yield* projections.refuseDevice(PERSON.id, tablet.deviceToken);
          const refused = yield* failureOf(
            tabletClient[ORCHESTRATION_V2_WS_METHODS.searchThread](search),
          );
          assert.strictEqual(refused?._tag, "EnvironmentAuthorizationError");
          const streamed = yield* failureOf(
            tabletClient[ORCHESTRATION_V2_WS_METHODS.searchThreadStream](search).pipe(
              Stream.runCollect,
            ),
          );
          assert.strictEqual(streamed?._tag, "EnvironmentAuthorizationError");
          const stillPaired = yield* laptopClient[ORCHESTRATION_V2_WS_METHODS.searchThreadStream](
            search,
          ).pipe(Stream.runCollect);
          assert.strictEqual(stillPaired.at(-1)?.totalMatches, 2);
        }).pipe(Effect.provide(projectionsOver(mend.url)));
      }),
    ),
  );
});
