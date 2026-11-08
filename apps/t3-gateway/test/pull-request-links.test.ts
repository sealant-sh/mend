import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS as METHODS,
  ThreadId,
  type OrchestrationV2ShellStreamItem,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { MendChangeLandings } from "../src/mend-workbench.ts";
import { discoverLandingPullRequests } from "../src/pull-request-observations.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { advanceClock } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const THREAD = ThreadId.make("session-1");
const KEY = { host: "github.com", repository: "sealant-sh/mend", number: 123 };
const URL = "https://github.com/sealant-sh/mend/pull/123";
const BEA = { id: "user-2", name: "Bea", email: "bea@example.com" };

describe("thread pull request links", () => {
  it.live("discovers a landing once and keeps an explicit unlink after restart", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: THREAD, projectId: "project-1" });
      const path = join(mkdtempSync(join(tmpdir(), "t3-pr-discovery-")), "state.sqlite");
      const history: MendChangeLandings = {
        sessionId: THREAD,
        land: true,
        pullRequest: { available: true, reason: null },
        facts: [],
        landings: [
          {
            id: "landing-1",
            commitSha: "abc123",
            remoteBranch: "feature",
            pushedSha: "abc123",
            pullRequest: {
              number: KEY.number,
              url: URL,
              state: "open",
              title: "Observed PR",
              observedAt: "2026-11-07T00:00:00Z",
            },
            outcome: "pull-request",
            message: null,
          },
        ],
      };
      for (const first of [true, false])
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, first ? "DISCOVER" : "REDISCOVER");
          yield* discoverLandingPullRequests({
            threads: () => [{ id: THREAD, changeId: "change-1" }],
            read: () => Effect.succeed(history),
            apply: (command) =>
              rpc[METHODS.dispatchCommand](command).pipe(Effect.map((answer) => answer.sequence)),
          });
          const projection = yield* rpc[METHODS.getThreadProjection]({ threadId: THREAD });
          assert.deepEqual(
            projection.thread.pullRequests?.map((pr) => pr.number),
            first ? [123] : [],
          );
          if (first)
            yield* rpc[METHODS.dispatchCommand]({
              type: "thread.pull-request.unlink",
              commandId: CommandId.make("unlink-discovered"),
              threadId: THREAD,
              ...KEY,
            });
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, path)));
    }),
  );

  it.live(
    "links several PRs, keeps them after restart, and keeps another person's links separate",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        advanceClock(Date.now());
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.projectVisibility.set("project-1", "shared");
        mend.workbench.addSession({ id: THREAD, projectId: "project-1" });
        mend.workbench.addTurn(THREAD, "Implement the change", "completed");
        const path = join(mkdtempSync(join(tmpdir(), "t3-pr-links-")), "state.sqlite");

        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "LINK");
          yield* rpc[METHODS.dispatchCommand]({
            type: "thread.pull-request.link",
            commandId: CommandId.make("link-1"),
            threadId: THREAD,
            ...KEY,
            url: URL,
            source: "manual",
          });
          yield* rpc[METHODS.dispatchCommand]({
            type: "thread.pull-request.link",
            commandId: CommandId.make("link-2"),
            threadId: THREAD,
            ...KEY,
            number: 124,
            url: "https://github.com/sealant-sh/mend/pull/124",
            source: "agent",
          });
          const projection = yield* rpc[METHODS.getThreadProjection]({ threadId: THREAD });
          assert.deepEqual(
            projection.thread.pullRequests?.map((pr) => pr.number),
            [123, 124],
          );
          const shell = yield* rpc[METHODS.subscribeShell]({}).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          const first = shell[0];
          assert.isTrue(first?.kind === "snapshot");
          if (first?.kind === "snapshot")
            assert.deepEqual(
              first.snapshot.threads[0]?.pullRequests,
              projection.thread.pullRequests,
            );
          const { rpc: other } = yield* pairAndConnect(mend, "BEA", BEA);
          const theirs = yield* other[METHODS.getThreadProjection]({ threadId: THREAD });
          assert.deepEqual(theirs.thread.pullRequests, []);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, path)));

        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "AFTER");
          const before = yield* rpc[METHODS.getThreadProjection]({ threadId: THREAD });
          assert.deepEqual(
            before.thread.pullRequests?.map((pr) => pr.number),
            [123, 124],
          );
          yield* rpc[METHODS.dispatchCommand]({
            type: "thread.pull-request.unlink",
            commandId: CommandId.make("unlink-1"),
            threadId: THREAD,
            ...KEY,
          });
          const after = yield* rpc[METHODS.getThreadProjection]({ threadId: THREAD });
          assert.deepEqual(
            after.thread.pullRequests?.map((pr) => pr.number),
            [124],
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, path)));
      }),
  );
  it.live(
    "settles only after every linked PR is terminal, and an explicit unsettle stays active",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        advanceClock(Date.now());
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: THREAD, projectId: "project-1" });
        mend.workbench.addTurn(THREAD, "Finish the change", "completed");
        const at = new Date(Date.now() - 60_000).toISOString();
        mend.workbench.turns.set(
          THREAD,
          (mend.workbench.turns.get(THREAD) ?? []).map((turn) => ({
            ...turn,
            createdAt: at,
            startedAt: at,
            endedAt: at,
          })),
        );

        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "SETTLE-PRS");
          for (const number of [123, 124])
            yield* rpc[METHODS.dispatchCommand]({
              type: "thread.pull-request.link",
              commandId: CommandId.make(`settle-link-${number}`),
              threadId: THREAD,
              ...KEY,
              number,
              url: `https://github.com/sealant-sh/mend/pull/${number}`,
              source: "manual",
            });
          const shell = yield* feed(rpc[METHODS.subscribeShell]({}));
          const terminal = new Date(Date.now() + 3_600_000).toISOString();
          for (const number of [123, 124]) {
            yield* rpc[METHODS.dispatchCommand]({
              type: "thread.pull-request-link.sync",
              commandId: CommandId.make(`sync-${number}`),
              threadId: THREAD,
              ...KEY,
              number,
              stack: null,
              snapshot: {
                state: number === 123 ? "merged" : "closed",
                title: "Finish the change",
                headBranch: "feature",
                baseBranch: "main",
                isDraft: false,
                updatedAt: terminal,
                syncedAt: terminal,
                mergedAt: number === 123 ? terminal : null,
                closedAt: terminal,
              },
            });
            if (number === 123) {
              const projection = yield* rpc[METHODS.getThreadProjection]({ threadId: THREAD });
              assert.isNull(projection.thread.settledOverride);
            }
          }
          yield* shell.next(
            (item): item is Extract<OrchestrationV2ShellStreamItem, { kind: "thread.updated" }> =>
              item.kind === "thread.updated" && item.thread.settledOverride === "settled",
          );
          yield* rpc[METHODS.dispatchCommand]({
            type: "thread.unsettle",
            reason: "user",
            commandId: CommandId.make("unsettle-prs"),
            threadId: THREAD,
          });
          const active = yield* rpc[METHODS.getThreadProjection]({ threadId: THREAD });
          assert.strictEqual(active.thread.settledOverride, "active");
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );
});
