import {
  WS_METHODS,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type VcsStatusStreamEvent,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { COMMIT_ALONE, FEATURE_BRANCH, ONLY_THE_OWNER, WHOLE_CHANGE } from "../src/landing.ts";
import { BRANCH_KEPT, PULL_REFUSED, PULL_REQUEST_THREAD } from "../src/rpc.ts";
import { PROJECT_ROOT_HAS_NO_CHANGE } from "../src/vcs.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import type { FakeLanding } from "./support/fake-workbench.ts";
import { feed } from "./support/feed.ts";
import { gatewayTestLayer } from "./support/gateway.ts";
import { pairAndConnect } from "./support/rpc.ts";

/**
 * t3code's git panel over Mend's landing (ADR 0012, ADR 0007): push and "create PR" land the
 * thread's change as its owner, the status's remote half reads the landing record, and everything
 * else the panel offers is refused in Mend's words before anything reaches Mend.
 */

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

const WORKTREE = "/var/lib/mend/store/project-1/worktrees/wt-session-1";
const STORE = "/var/lib/mend/store/project-1/repo.git";
const CHANGE = "change-session-1";
const BRANCH = "mend/wt-session-1";
const BEA = { id: "user-2", name: "Bea", email: "bea@example.com" } as const;

type Rpc = Effect.Success<ReturnType<typeof pairAndConnect>>["rpc"];
type Event = VcsStatusStreamEvent;

const setup = (mend: FakeMend) => {
  mend.workbench.addProject("project-1", "mend");
  mend.workbench.projectVisibility.set("project-1", "shared");
  mend.workbench.addSession({ id: "session-1", projectId: "project-1" });
  mend.workbench.stats.set(CHANGE, { files: 2, additions: 10, deletions: 3 });
};

/** The typed failure a call ended with, if any. */
const errorOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
    ),
  );

/** Every event a git action sent, and how it ended. */
const runAction = (
  rpc: Rpc,
  action: GitRunStackedActionInput["action"],
  extra: Partial<GitRunStackedActionInput> = {},
) =>
  Effect.gen(function* () {
    const events: Array<GitActionProgressEvent> = [];
    const error = yield* errorOf(
      Stream.runForEach(
        rpc[WS_METHODS.gitRunStackedAction]({
          actionId: `action-${action}`,
          cwd: WORKTREE,
          action,
          ...extra,
        }),
        (event) => Effect.sync(() => events.push(event)),
      ),
    );
    const finished = events.find((event) => event.kind === "action_finished");
    return {
      events,
      error,
      result: finished?.kind === "action_finished" ? finished.result : undefined,
    };
  });

const landCalls = (mend: FakeMend) =>
  mend.workbench.calls.filter((call) => call.method === "POST" && call.path.endsWith("/land"));

const remoteUpdated = (event: Event): event is Extract<Event, { _tag: "remoteUpdated" }> =>
  event._tag === "remoteUpdated";

const snapshotOf = (event: Event): event is Extract<Event, { _tag: "snapshot" }> =>
  event._tag === "snapshot";

/** A landing as Mend records one, for an answer a test makes Mend give. */
const landingAs = (overrides: Partial<FakeLanding>): FakeLanding => ({
  id: "landing-x",
  changeId: CHANGE,
  sessionId: "session-1",
  projectId: "project-1",
  checkpointId: "checkpoint-x",
  checkpointRef: "refs/mend/landed/x",
  checkpointSha: "c".repeat(40),
  commitSha: null,
  remoteBranch: BRANCH,
  pushedSha: null,
  trigger: "manual",
  pullRequest: null,
  pullRequestCrossRepository: false,
  pullRequestHeadOwner: null,
  outcome: "pushed",
  message: null,
  userId: "user-1",
  createdAt: "2026-10-17T09:00:00.000Z",
  ...overrides,
});

describe("the git panel over Mend's landing", () => {
  it.live(
    "the owner pushes and opens a pull request, and the status shows it without waiting for a poll",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-OWNER");

          const before = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(
            [before.hasUpstream, before.aheadCount, before.aheadOfDefaultCount, before.pr],
            [false, 1, 1, null],
          );
          const status = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
          yield* status.next(snapshotOf);

          const { events, error, result } = yield* runAction(rpc, "create_pr");
          assert.isUndefined(error);
          assert.deepStrictEqual(
            events.slice(0, 2).map((event) => event.kind),
            ["action_started", "phase_started"],
          );
          assert.deepStrictEqual(events[0]?.kind === "action_started" ? events[0].phases : [], [
            "commit",
            "push",
            "pr",
          ]);
          assert.strictEqual(result?.branch.status, "skipped_not_requested");
          assert.strictEqual(result?.commit.status, "created");
          assert.deepStrictEqual(result?.push, {
            status: "pushed",
            branch: BRANCH,
            upstreamBranch: `origin/${BRANCH}`,
          });
          assert.deepStrictEqual(result?.pr, {
            status: "created",
            url: "https://github.com/sealant-sh/mend/pull/1",
            number: 1,
            headBranch: BRANCH,
            title: "session-1",
            baseBranch: "main",
          });
          assert.strictEqual(result?.toast.title, "Opened pull request #1");
          assert.match(
            result?.toast.description ?? "",
            /^pushed [0-9a-f]{7} · pull request #1 · open · observed$/u,
          );
          assert.deepStrictEqual(result?.toast.cta, {
            kind: "open_pr",
            label: "View PR",
            url: "https://github.com/sealant-sh/mend/pull/1",
          });
          assert.deepStrictEqual(
            landCalls(mend).map((call) => [call.path, call.body]),
            [
              [
                "/api/sessions/session-1/land",
                { pullRequest: true, branch: null, title: null, body: null },
              ],
            ],
          );

          // The feed's 5 s timeout is well inside the 15 s poll, so only the nudge answers.
          const after = yield* status.next(remoteUpdated);
          assert.deepStrictEqual(after.remote, {
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
            pr: {
              number: 1,
              title: "session-1",
              url: "https://github.com/sealant-sh/mend/pull/1",
              baseRef: "main",
              headRef: BRANCH,
              state: "open",
              updatedAt: after.remote?.pr?.updatedAt,
            },
          });
          assert.isString(after.remote?.pr?.updatedAt);
        }),
      ),
  );

  it.live("pushes new work to the change's branch and keeps its pull request", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "LAND-PUSH");
        yield* runAction(rpc, "create_pr");
        mend.workbench.sinceLanding.set(CHANGE, 2);

        const ahead = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.deepStrictEqual(
          [ahead.hasUpstream, ahead.aheadCount, ahead.aheadOfDefaultCount, ahead.pr?.state],
          [true, 1, 1, "open"],
        );

        const { error, result } = yield* runAction(rpc, "push");
        assert.isUndefined(error);
        assert.deepStrictEqual(landCalls(mend).at(-1)?.body, {
          pullRequest: false,
          branch: null,
          title: null,
          body: null,
        });
        assert.deepStrictEqual(result?.pr, { status: "skipped_not_requested" });
        assert.strictEqual(result?.toast.title, `Pushed to ${BRANCH}`);
        assert.deepStrictEqual(result?.toast.cta, {
          kind: "open_pr",
          label: "View PR",
          url: "https://github.com/sealant-sh/mend/pull/1",
        });

        const landed = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.deepStrictEqual(
          [landed.hasUpstream, landed.aheadCount, landed.aheadOfDefaultCount, landed.pr?.number],
          [true, 0, 0, 1],
        );
      }),
    ),
  );

  it.live(
    "offers a pull request for a change pushed without one, and a new one after a merge",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-CREATE");
          const pushed = yield* runAction(rpc, "push");
          assert.deepStrictEqual(pushed.result?.pr, { status: "skipped_not_requested" });
          assert.deepStrictEqual(pushed.result?.toast.cta, { kind: "none" });

          // Pushed, no pull request, nothing new. t3code shows "Create PR".
          const unopened = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(
            [unopened.hasUpstream, unopened.aheadCount, unopened.aheadOfDefaultCount, unopened.pr],
            [true, 0, 1, null],
          );
          const opened = yield* runAction(rpc, "create_pr");
          assert.strictEqual(opened.result?.pr.status, "created");

          // Merged on GitHub with nothing new. Up to date, nothing to offer.
          for (const landing of mend.workbench.landings.get(CHANGE) ?? []) {
            if (landing.pullRequest !== null) landing.pullRequest.state = "merged";
          }
          const merged = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(
            [merged.aheadCount, merged.aheadOfDefaultCount, merged.pr?.state],
            [0, 0, "merged"],
          );
          // New work after the merge. t3code shows "Push & create PR".
          mend.workbench.sinceLanding.set(CHANGE, 1);
          const after = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(
            [after.hasUpstream, after.aheadCount, after.aheadOfDefaultCount, after.pr?.state],
            [true, 1, 1, "merged"],
          );
        }),
      ),
  );

  it.live(
    "a teammate who does not own the change sees its pull request, and a landing is refused in Mend's words",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const ada = yield* pairAndConnect(mend, "LAND-ADA");
          yield* runAction(ada.rpc, "create_pr");
          mend.workbench.sinceLanding.set(CHANGE, 3);

          const bea = yield* pairAndConnect(mend, "LAND-BEA", BEA);
          const seen = yield* bea.rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(
            [seen.hasUpstream, seen.aheadCount, seen.aheadOfDefaultCount, seen.pr?.state],
            [true, 0, 0, "open"],
          );

          const { events, error } = yield* runAction(bea.rpc, "push");
          assert.strictEqual(error?._tag, "EnvironmentAuthorizationError");
          assert.strictEqual(error?.message, ONLY_THE_OWNER);
          assert.deepStrictEqual(events, []);
          assert.strictEqual(landCalls(mend).length, 1, "only Ada's landing reached Mend");
        }),
      ),
  );

  it.live(
    "refuses commit alone, a new branch, a file selection and a message before Mend lands",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-REFUSE");
          const cases: ReadonlyArray<
            readonly [GitRunStackedActionInput["action"], Partial<GitRunStackedActionInput>, string]
          > = [
            ["commit", {}, COMMIT_ALONE],
            ["commit_push", { featureBranch: true }, FEATURE_BRANCH],
            ["commit_push_pr", { filePaths: ["src/a.ts"] }, WHOLE_CHANGE],
            ["commit_push", { commitMessage: "fix the parser" }, WHOLE_CHANGE],
            ["push", { cwd: STORE }, PROJECT_ROOT_HAS_NO_CHANGE],
          ];
          for (const [action, extra, text] of cases) {
            const { events, error } = yield* runAction(rpc, action, extra);
            assert.strictEqual(error?._tag, "EnvironmentAuthorizationError", action);
            assert.strictEqual(error?.message, text, action);
            assert.deepStrictEqual(events, [], action);
          }
          assert.deepStrictEqual(landCalls(mend), []);
        }),
      ),
  );

  it.live(
    "refuses a branch switch or a new one, a pull and a pull request checkout in Mend's words",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-BRANCH");
          const refusals = [
            [
              yield* errorOf(rpc[WS_METHODS.vcsSwitchRef]({ cwd: WORKTREE, refName: "main" })),
              "EnvironmentAuthorizationError",
              BRANCH_KEPT,
            ],
            [
              yield* errorOf(
                rpc[WS_METHODS.vcsCreateRef]({ cwd: WORKTREE, refName: "fix", switchRef: true }),
              ),
              "EnvironmentAuthorizationError",
              BRANCH_KEPT,
            ],
            [
              yield* errorOf(rpc[WS_METHODS.vcsPull]({ cwd: WORKTREE })),
              "EnvironmentAuthorizationError",
              PULL_REFUSED,
            ],
            [
              yield* errorOf(
                rpc[WS_METHODS.gitPreparePullRequestThread]({
                  cwd: STORE,
                  reference: "#12",
                  mode: "worktree",
                }),
              ),
              "GitManagerError",
              PULL_REQUEST_THREAD,
            ],
            [
              yield* errorOf(
                rpc[WS_METHODS.gitResolvePullRequest]({ cwd: STORE, reference: "#12" }),
              ),
              "GitManagerError",
              PULL_REQUEST_THREAD,
            ],
          ] as const;
          for (const [error, tag, text] of refusals) {
            assert.strictEqual(error?._tag, tag, text);
            assert.include(error?.message ?? "", text);
          }
          assert.isFalse(
            mend.workbench.calls.some((call) => call.method !== "GET"),
            "nothing in Mend moved",
          );
        }),
      ),
  );

  it.live("says Mend's own refusals in Mend's words", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "LAND-MEND");
        yield* runAction(rpc, "create_pr");

        const again = yield* runAction(rpc, "push");
        assert.strictEqual(again.error?._tag, "GitManagerError");
        assert.include(
          again.error?.message ?? "",
          "landing not started · nothing new since the last landing",
        );
        assert.deepStrictEqual(
          again.events.map((event) => event.kind),
          ["action_started", "phase_started", "action_failed"],
        );

        mend.workbench.sinceLanding.set(CHANGE, 1);
        mend.workbench.nextLandingAnswer = {
          status: 200,
          body: {
            landing: landingAs({
              outcome: "refused",
              message: "! [rejected] (fetch first)",
            }),
            pullRequest: { _tag: "not-reached" },
          },
        };
        const refused = yield* runAction(rpc, "push");
        assert.strictEqual(refused.error?._tag, "GitManagerError");
        assert.include(
          refused.error?.message ?? "",
          `push refused · ${BRANCH} · ! [rejected] (fetch first)`,
        );

        mend.workbench.nextLandingAnswer = {
          status: 200,
          body: {
            landing: landingAs({
              outcome: "failed",
              pushedSha: "d".repeat(40),
              message: "gh: HTTP 502",
            }),
            pullRequest: { _tag: "failed", message: "gh: HTTP 502" },
          },
        };
        const stepFailed = yield* runAction(rpc, "create_pr");
        assert.isUndefined(stepFailed.error);
        assert.deepStrictEqual(stepFailed.result?.pr, { status: "skipped_not_requested" });
        assert.deepStrictEqual(stepFailed.result?.commit, { status: "skipped_no_changes" });
        assert.strictEqual(
          stepFailed.result?.toast.description,
          "pushed ddddddd · pull request step failed · gh: HTTP 502",
        );

        mend.workbench.nextLandingAnswer = {
          status: 200,
          body: {
            landing: landingAs({ outcome: "failed", message: "checkpoint failed" }),
            pullRequest: { _tag: "not-reached" },
          },
        };
        const notPushed = yield* runAction(rpc, "push");
        assert.include(notPushed.error?.message ?? "", "landing failed · checkpoint failed");
      }),
    ),
  );
});
