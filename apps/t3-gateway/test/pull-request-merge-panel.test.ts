import { ProjectId, WS_METHODS } from "@mend/t3-contracts";
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
  expectedAccountId: "ada",
};
const pr: MendPullRequest = {
  number: 123,
  title: "Fix login",
  body: "Keep this readable while merge permissions change.",
  url: "https://github.com/sealant-sh/mend/pull/123",
  author: { login: "ada", name: null, avatarUrl: null },
  headBranch: "fix-login",
  baseBranch: "main",
  headSha: "abc123",
  headRepository: "sealant-sh/mend",
  state: "open",
  isDraft: false,
  additions: 10,
  deletions: 2,
  changedFiles: 1,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
  closedAt: null,
  mergedAt: null,
  mergeability: "mergeable",
  reviewDecision: "approved",
  labels: [],
  checks: [{ name: "test", status: "success", description: null, url: null }],
  viewerCanUpdate: true,
  observedAt: 1794009600000,
};

// Ordinary use: open a PR detail, choose a repository-supported method, then press Merge.
describe("merge controls in PR detail over the real gateway WebSocket", () => {
  it.live("advertises fresh merge access and sends only the person's chosen remote merge", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.workbench.addProject("project-1", "mend");
      mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
      mend.workbench.pullRequests.set(123, pr);
      mend.workbench.fileContents.set("session-1", new Map([["a.ts", "uncommitted edit\n"]]));
      const sessionsBefore = structuredClone([...mend.workbench.sessions]);
      const filesBefore = structuredClone([...mend.workbench.fileContents]);
      const turnsBefore = structuredClone([...mend.workbench.turns]);
      yield* Effect.gen(function* () {
        const { rpc } = yield* pairAndConnect(mend, "PR-PANEL-MERGE");
        const detail = yield* rpc[WS_METHODS.pullRequestsDetail](reference);
        assert.deepEqual(detail.capabilities.actions, ["merge"]);
        assert.deepEqual(detail.capabilities.mergeMethods, ["merge", "squash", "rebase"]);
        assert.deepEqual(detail.viewerPermissions.actions, ["merge"]);
        assert.deepEqual(detail.mergeCapabilities, { merge: true, squash: true, rebase: true });
        assert.isFalse(detail.capabilities.comment);
        assert.isFalse(detail.capabilities.diff);
        assert.isTrue(detail.capabilities.search);
        assert.deepEqual(detail.capabilities.review.verdicts, []);
        assert.strictEqual(detail.body, pr.body);
        assert.strictEqual(detail.checks[0]?.status, "success");
        yield* rpc[WS_METHODS.pullRequestsRunAction]({
          ...reference,
          action: "merge",
          mergeMethod: "squash",
        });
        const writes = mend.workbench.calls.filter((call) => call.method !== "GET");
        assert.deepEqual(
          writes.map((call) => [call.method, call.path, call.body]),
          [
            [
              "POST",
              "/api/projects/project-1/pull-requests/123/merge",
              {
                repository: reference.repository,
                method: "squash",
                expectedAccountId: "ada",
                removeAgentCredits: false,
              },
            ],
          ],
        );
        assert.strictEqual(writes[0]?.authorization, `Bearer ${mend.claims[0]?.token}`);
        assert.deepEqual([...mend.workbench.sessions], sessionsBefore);
        assert.deepEqual([...mend.workbench.fileContents], filesBefore);
        assert.deepEqual([...mend.workbench.turns], turnsBefore);

        // The detail cache must not preserve write access after GitHub permission changes.
        mend.workbench.pullRequestMergeAccessResponse = {
          status: 200,
          body: { viewer: "ada", canMerge: false, mergeMethods: ["squash"] },
        };
        const reader = yield* rpc[WS_METHODS.pullRequestsDetail](reference);
        assert.deepEqual(reader.viewerPermissions.actions, []);
        assert.deepEqual(reader.capabilities.actions, ["merge"]);
        assert.deepEqual(reader.capabilities.mergeMethods, ["squash"]);
        assert.deepEqual(reader.mergeCapabilities, { merge: false, squash: true, rebase: false });
        assert.strictEqual(reader.body, detail.body);
        assert.strictEqual(
          mend.workbench.calls.filter((call) => call.path.endsWith("/pull-requests/123")).length,
          1,
        );
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  for (const scenario of [
    {
      name: "read-only account",
      canMerge: false,
      methods: ["merge", "squash", "rebase"],
      message: "Your GitHub account cannot merge this pull request.",
    },
    {
      name: "disabled merge method",
      canMerge: true,
      methods: ["squash"],
      message: "This repository does not allow merge commits.",
    },
  ]) {
    it.live(`shows the allowed controls and preserves a ${scenario.name} refusal`, () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.pullRequests.set(123, pr);
        mend.workbench.pullRequestMergeAccessResponse = {
          status: 200,
          body: { viewer: "ada", canMerge: scenario.canMerge, mergeMethods: scenario.methods },
        };
        mend.workbench.pullRequestMergeResponse = {
          status: 422,
          body: { _tag: "PullRequestMergeFailed", message: scenario.message },
        };
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PR-PANEL-REFUSE");
          const detail = yield* rpc[WS_METHODS.pullRequestsDetail](reference);
          assert.deepEqual(detail.capabilities.actions, ["merge"]);
          assert.deepEqual(detail.capabilities.mergeMethods, scenario.methods);
          assert.deepEqual(detail.viewerPermissions.actions, scenario.canMerge ? ["merge"] : []);
          const refused = yield* rpc[WS_METHODS.pullRequestsRunAction]({
            ...reference,
            action: "merge",
            mergeMethod: "merge",
          }).pipe(Effect.flip);
          assert.strictEqual(refused._tag, "PullRequestOperationError");
          assert.include(refused.detail, scenario.message);
          assert.deepEqual(
            mend.workbench.calls.filter((call) => call.method !== "GET").map((call) => call.path),
            ["/api/projects/project-1/pull-requests/123/merge"],
          );
          assert.strictEqual(mend.workbench.turns.size, 0);
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
    );
  }

  it.live(
    "keeps detail and checks readable with no merge controls when access cannot be read",
    () =>
      Effect.gen(function* () {
        const mend = yield* startFakeMend;
        mend.workbench.addProject("project-1", "mend");
        mend.workbench.pullRequests.set(123, pr);
        mend.workbench.pullRequestMergeAccessResponse = { status: 503, body: {} };
        yield* Effect.gen(function* () {
          const { rpc } = yield* pairAndConnect(mend, "PR-PANEL-OFFLINE");
          const detail = yield* rpc[WS_METHODS.pullRequestsDetail](reference);
          assert.deepEqual(detail.capabilities.actions, []);
          assert.deepEqual(detail.viewerPermissions.actions, []);
          assert.deepEqual(detail.capabilities.mergeMethods, []);
          assert.strictEqual(detail.body, pr.body);
          assert.strictEqual(detail.checks[0]?.status, "success");
          assert.isTrue(mend.workbench.calls.some((call) => call.path.endsWith("/merge-access")));
          const checks = yield* rpc[WS_METHODS.pullRequestsChecks](reference);
          assert.strictEqual(checks?.checks[0]?.status, "success");
        }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
      }),
  );
});
