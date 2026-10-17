import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
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
import { Projections, ProjectionsLive, type PersonHub, type ThreadSnapshot } from "../src/hub.ts";
import { rpcScopeAuthorizationLayer } from "../src/rpc-scopes.ts";
import { gatewayRpcHandlersLayer } from "../src/rpc.ts";
import { MendClientFetchLive } from "../src/server.ts";
import { GatewayStateLive, type BearerSession } from "../src/state.ts";
import { FIND_CACHE_LIMITS, makeThreadFinder } from "../src/thread-find.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
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
        const search = { threadId: THREAD, query: "absent" };

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
        const counted = yield* makeThreadFinder().searchThread(snapshot, search);
        const scanned = performance.now() - started;
        yield* Fiber.interrupt(ticker);
        assert.strictEqual(counted.totalMatches, 0);
        const longestGap = Math.max(...gaps);
        assert.isAbove(scanned, 4 * longestGap, `scan ${scanned} ms, longest gap ${longestGap} ms`);
        assert.isBelow(longestGap, 150);

        const interrupted = yield* makeThreadFinder()
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
        const finder = makeThreadFinder();
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
        const finder = makeThreadFinder(limits);
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
    Layer.provideMerge(Layer.mergeAll(MendClientFetchLive, GatewayStateLive)),
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
        gatewayRpcHandlersLayer(session, hub),
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
