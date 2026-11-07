import { createHash } from "node:crypto";

import {
  CommandId,
  ProjectId,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS as ORCH,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";

import type { MendPullRequest } from "../src/mend-pull-requests.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

const reference = {
  projectId: ProjectId.make("project-1"),
  repository: "sealant-sh/mend",
  number: 123,
};
const pr: MendPullRequest = {
  number: 123,
  title: "Fix login",
  body: "Read the observed checks",
  url: "https://github.com/sealant-sh/mend/pull/123",
  author: { login: "ada", name: null, avatarUrl: null },
  headBranch: "fix-login",
  baseBranch: "main",
  headSha: "abc123",
  headRepository: "ada/mend",
  state: "merged",
  isDraft: false,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  closedAt: "2026-11-07T00:00:00.000Z",
  mergedAt: "2026-11-07T00:00:00.000Z",
  mergeability: "unknown",
  reviewDecision: "approved",
  labels: [{ name: "bug", color: "ff0000" }],
  checks: [{ name: "test", status: "success", description: null, url: null }],
  viewerCanUpdate: true,
  observedAt: 1794009600000,
};

describe("PR browsing through the gateway", () => {
  it.live(
    "lists host pages and reads detail/checks as the paired person, refreshing linked observations",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
        mend.workbench.pullRequests.set(123, pr);
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PRS");
          yield* rpc[ORCH.dispatchCommand]({
            type: "thread.pull-request.link",
            commandId: CommandId.make("link-browse"),
            threadId: ThreadId.make("session-1"),
            host: "github.com",
            repository: reference.repository,
            number: 123,
            url: pr.url,
            source: "manual",
          });
          const listed = yield* rpc[WS_METHODS.pullRequestsList]({
            state: "merged",
            involvement: "authored",
            query: "#123",
            limit: 20,
            filters: { labels: [["bug", "feature"]], draft: "hide" },
          });
          assert.strictEqual(listed.entries[0]?.title, "Fix login");
          assert.strictEqual(listed.entries[0]?.checksState, "passing");
          assert.strictEqual(listed.viewers["github.com"], "ada");
          const request = mend.workbench.calls.find((call) =>
            call.path.endsWith("/pull-requests/search"),
          );
          assert.deepEqual(request?.body, {
            query: 'sort:updated-desc is:merged author:@me draft:false label:"bug","feature" 123',
            limit: 20,
            cursor: null,
          });
          assert.isString(request?.authorization);
          const detail = yield* rpc[WS_METHODS.pullRequestsDetail](reference);
          assert.strictEqual(detail.headRepositoryNameWithOwner, "ada/mend");
          assert.strictEqual(detail.body, pr.body);
          assert.strictEqual(detail.capabilities.comment, false);
          const readsBeforeChecks = mend.workbench.calls.filter((call) =>
            call.path.endsWith("/pull-requests/123"),
          ).length;
          const checks = yield* rpc[WS_METHODS.pullRequestsChecks](reference);
          assert.strictEqual(checks?.checks[0]?.status, "success");
          assert.strictEqual(
            mend.workbench.calls.filter((call) => call.path.endsWith("/pull-requests/123")).length,
            readsBeforeChecks,
          );
          const linked = yield* rpc[WS_METHODS.pullRequestsLinkedThreads](reference);
          assert.deepEqual(
            linked.threads.map((thread) => thread.id),
            ["session-1"],
          );
          const thread = yield* rpc[ORCH.getThreadProjection]({
            threadId: ThreadId.make("session-1"),
          });
          assert.strictEqual(thread.thread.pullRequests?.[0]?.snapshot?.mergedAt, pr.mergedAt);
          const routing = yield* rpc[WS_METHODS.pullRequestsRouting](reference);
          assert.strictEqual(routing.accountId, "ada");
          const identity = yield* rpc[WS_METHODS.pullRequestsRoutingIdentity]({
            host: "github.com",
          });
          assert.strictEqual(identity.accountId, "ada");
          assert.isTrue(
            mend.workbench.calls.some((call) => call.path === "/api/github/pull-request-identity"),
          );
          const changed = yield* rpc[WS_METHODS.pullRequestsDetail]({
            ...reference,
            expectedAccountId: "another-account",
          }).pipe(Effect.flip);
          assert.strictEqual(changed._tag, "PullRequestOperationError");
          const hidden = yield* rpc[WS_METHODS.pullRequestsDetail]({
            ...reference,
            projectId: ProjectId.make("hidden"),
          }).pipe(Effect.flip);
          assert.strictEqual(hidden._tag, "PullRequestOperationError");
          assert.isFalse(
            mend.workbench.calls.some((call) => call.path.includes("/projects/hidden/")),
          );
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );
});

it.live(
  "adapts only a current landed tour, preserves inferred reading, and queues a rewrite through Mend",
  () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      mend.workbench.changes.set("session-1", "change-1");
      mend.workbench.pullRequests.set(123, pr);
      const diff = "diff --git a/a.ts b/a.ts\n+change\n";
      mend.workbench.diffs.set("change-1", {
        diff,
        files: [{ path: "a.ts", additions: 1, deletions: 0 }],
      });
      mend.workbench.landings.set("change-1", [
        {
          id: "landing-1",
          changeId: "change-1",
          sessionId: "session-1",
          projectId: "project-1",
          checkpointId: null,
          checkpointRef: null,
          checkpointSha: null,
          commitSha: pr.headSha,
          remoteBranch: pr.headBranch,
          pushedSha: pr.headSha,
          trigger: "manual",
          pullRequest: {
            number: 123,
            url: pr.url,
            state: "merged",
            title: pr.title,
            observedAt: pr.updatedAt,
          },
          pullRequestCrossRepository: false,
          pullRequestHeadOwner: null,
          outcome: "pull-request",
          message: null,
          userId: "user-1",
          createdAt: pr.createdAt,
        },
      ]);
      mend.workbench.tours.set("change-1", {
        summary: "Fix login",
        approach: null,
        createdAt: pr.updatedAt,
        diffDigest: createHash("sha256").update(diff).digest("hex"),
        stops: [
          {
            title: "Login",
            file: "a.ts",
            line: 1,
            endLine: 2,
            narration: "Inspect the login branch",
            evidence: [{ sealantRunId: "run-1", sequence: "7", excerpt: "read the login flow" }],
            grounded: false,
          },
        ],
      });
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "GUIDE");
        const guide = yield* rpc[WS_METHODS.pullRequestsReviewGuide](reference);
        assert.strictEqual(guide.guide?.headSha, pr.headSha);
        assert.strictEqual(guide.guide?.stops[1]?.excerpts[0]?.path, "a.ts");
        assert.include(guide.guide?.stops[1]?.summary, "Record run-1, sequence 7");
        assert.isNotNull(guide.guide?.stops[1]?.attention);
        const generated = yield* rpc[WS_METHODS.pullRequestsGenerateReviewGuide](reference);
        assert.strictEqual(generated.run?._tag, "Running");
        assert.isTrue(
          mend.workbench.calls.some(
            (call) => call.method === "POST" && call.path === "/api/changes/change-1/tour",
          ),
        );
        mend.workbench.sinceLanding.set("change-1", 1);
        const stale = yield* rpc[WS_METHODS.pullRequestsReviewGuide](reference);
        assert.isNull(stale.guide);
        const refused = yield* rpc[WS_METHODS.pullRequestsGenerateReviewGuide](reference).pipe(
          Effect.flip,
        );
        assert.strictEqual(refused._tag, "PullRequestOperationError");
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
);
