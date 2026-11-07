import { ORCHESTRATION_V2_WS_METHODS, ThreadId, UsageDay, WS_METHODS } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

describe("recorded usage", () => {
  it.live("omits unknown payers and ambiguous cumulative intervals", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1", harness: "codex" });
        const add = (inputTokens: number | null, billedUserId: string | null) => {
          const turn = workbench.addTurn("session-1", "Work", "completed");
          Object.assign(turn, {
            billedUserId,
            usage:
              inputTokens === null
                ? null
                : {
                    inputTokens,
                    cachedInputTokens: 0,
                    outputTokens: 0,
                    totalTokens: inputTokens,
                    contextWindow: null,
                  },
          });
        };
        add(10000, null);
        add(null, "user-2");
        add(30000, "user-1");
        add(31000, "user-1");
        // A reset is another unknown boundary, followed by a usable difference.
        add(10000, "user-2");
        add(10500, "user-1");
        const { rpc } = yield* pairAndConnect(mend, "USAGE-GAPS");
        const summary = yield* rpc[WS_METHODS.serverGetUsageSummary]({
          sinceDay: UsageDay.make("2000-01-01"),
          untilDay: UsageDay.make("2099-12-31"),
          timeZone: "UTC",
        });
        assert.strictEqual(summary.buckets.length, 1);
        assert.deepInclude(summary.buckets[0], {
          records: 2,
          totals: {
            uncachedInputTokens: 1500,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        });
        const projection = yield* rpc[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
          threadId: ThreadId.make("session-1"),
        });
        // Old records with cumulative usage cannot supply an honest context size.
        assert.isNull(projection.providerThreads[0]?.contextUsage);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("buckets Claude turns in the requested zone across a repeated DST hour", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const { workbench } = mend;
        workbench.addProject("project-1", "mend");
        workbench.addSession({ id: "session-1", projectId: "project-1", harness: "claude" });
        for (const endedAt of ["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]) {
          const turn = workbench.addTurn("session-1", "Work", "completed");
          Object.assign(turn, {
            endedAt,
            billedUserId: "user-1",
            usage: {
              inputTokens: 3,
              cachedInputTokens: 120,
              outputTokens: 7,
              totalTokens: 10,
              contextTokens: 130,
              contextWindow: 200000,
            },
          });
        }
        const { rpc } = yield* pairAndConnect(mend, "USAGE-ZONE");
        const input = {
          sinceDay: UsageDay.make("2026-11-01"),
          untilDay: UsageDay.make("2026-11-01"),
          timeZone: "America/New_York",
          resolution: "hour" as const,
        };
        const summary = yield* rpc[WS_METHODS.serverGetUsageSummary](input);
        assert.deepStrictEqual(
          summary.buckets.map((bucket) => bucket.hourStart),
          ["2026-11-01T05:00:00.000Z", "2026-11-01T06:00:00.000Z"],
        );
        assert.deepStrictEqual(summary.buckets[0]?.totals, {
          uncachedInputTokens: 3,
          cachedInputTokens: 120,
          cacheCreationTokens: 0,
          outputTokens: 7,
          reasoningTokens: 0,
        });
        assert.strictEqual(summary.sources[0]?.distinctSessions, 1);
        for (const invalid of [
          { ...input, timeZone: "Not/AZone" },
          { ...input, sinceDay: UsageDay.make("2026-02-30") },
          { ...input, untilDay: UsageDay.make("2026-01-01") },
        ]) {
          const error = yield* rpc[WS_METHODS.serverGetUsageSummary](invalid).pipe(Effect.flip);
          assert.strictEqual(error._tag, "UsageReadError");
        }
        const ranged = yield* rpc[WS_METHODS.serverGetUsageSummary]({
          ...input,
          sinceTime: "2026-11-01T06:00:00Z",
          untilTime: "2026-11-01T07:00:00Z",
        });
        assert.lengthOf(ranged.buckets, 1);
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live(
    "shows completed context separately from cumulative usage and only totals the payer's work",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        yield* Effect.gen(function* () {
          const { workbench } = mend;
          workbench.addProject("project-1", "mend");
          workbench.addSession({ id: "session-1", projectId: "project-1", harness: "codex" });
          const first = workbench.addTurn("session-1", "My work", "completed");
          Object.assign(first, {
            billedUserId: "user-1",
            usage: {
              inputTokens: 1000,
              cachedInputTokens: 100,
              outputTokens: 100,
              totalTokens: 1100,
              contextTokens: 550,
              contextWindow: 2000,
            },
          });
          const second = workbench.addTurn("session-1", "Someone else's work", "completed");
          Object.assign(second, {
            billedUserId: "user-2",
            usage: {
              inputTokens: 9000,
              cachedInputTokens: 1000,
              outputTokens: 500,
              totalTokens: 9500,
              contextTokens: 800,
              contextWindow: 2000,
            },
          });
          const third = workbench.addTurn("session-1", "More of my work", "completed");
          Object.assign(third, {
            billedUserId: "user-1",
            usage: {
              inputTokens: 11000,
              cachedInputTokens: 1200,
              outputTokens: 700,
              totalTokens: 11700,
              contextTokens: 900,
              contextWindow: 2000,
            },
          });
          const { rpc, access } = yield* pairAndConnect(mend, "USAGE");
          assert.include(access.scope.split(" "), "diagnostics:read");
          const stream = yield* feed(
            rpc[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
              threadId: ThreadId.make("session-1"),
            }),
          );
          const snapshot = yield* stream.next((entry) => entry.kind === "snapshot");
          assert.deepInclude(snapshot.projection.providerThreads[0]?.contextUsage, {
            usedTokens: 900,
            totalProcessedTokens: 11700,
            maxTokens: 2000,
          });
          const summary = yield* rpc[WS_METHODS.serverGetUsageSummary]({
            sinceDay: UsageDay.make("2000-01-01"),
            untilDay: UsageDay.make("2099-12-31"),
            timeZone: "UTC",
          });
          assert.strictEqual(summary.buckets.length, 1);
          assert.deepInclude(summary.buckets[0], {
            records: 2,
            costSource: "unpriced",
            unpricedRecords: 2,
            totals: {
              uncachedInputTokens: 2700,
              cachedInputTokens: 300,
              cacheCreationTokens: 0,
              outputTokens: 300,
              reasoningTokens: 0,
            },
          });
          assert.strictEqual(summary.sources[0]?.distinctSessions, 1);
          const other = yield* pairAndConnect(mend, "OTHER-USAGE", {
            id: "user-2",
            name: "Grace",
            email: "grace@example.com",
          });
          const otherSummary = yield* other.rpc[WS_METHODS.serverGetUsageSummary]({
            sinceDay: UsageDay.make("2000-01-01"),
            untilDay: UsageDay.make("2099-12-31"),
            timeZone: "UTC",
          });
          assert.deepInclude(otherSummary.buckets[0], {
            records: 1,
            totals: {
              uncachedInputTokens: 7100,
              cachedInputTokens: 900,
              cacheCreationTokens: 0,
              outputTokens: 400,
              reasoningTokens: 0,
            },
          });
          const noUsage = yield* pairAndConnect(mend, "NO-USAGE", {
            id: "user-3",
            name: "Lin",
            email: "lin@example.com",
          });
          const empty = yield* noUsage.rpc[WS_METHODS.serverGetUsageSummary]({
            sinceDay: UsageDay.make("2000-01-01"),
            untilDay: UsageDay.make("2099-12-31"),
            timeZone: "UTC",
          });
          assert.deepStrictEqual(empty.buckets, []);
          assert.deepStrictEqual(empty.sources, []);
          // Granting the Usage panel must not enable any unrelated diagnostics.
          const diagnostics: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
            rpc[WS_METHODS.serverGetTraceDiagnostics]({}),
            rpc[WS_METHODS.serverGetProcessDiagnostics]({}),
            rpc[WS_METHODS.serverGetProcessResourceHistory]({ windowMs: 60000, bucketMs: 1000 }),
            rpc[WS_METHODS.serverGetResourceTelemetryHistory]({ windowMs: 60000, bucketMs: 1000 }),
            rpc[WS_METHODS.serverRetryResourceTelemetry]({}),
            rpc[WS_METHODS.serverRefreshUsageRates]({}),
          ];
          for (const request of diagnostics) {
            const refused = yield* request.pipe(Effect.flip);
            assert.strictEqual(refused._tag, "EnvironmentAuthorizationError");
          }
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );
});
