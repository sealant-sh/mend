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

const errorOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) =>
      Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined,
    ),
  );

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

const refreshCalls = (mend: FakeMend) =>
  mend.workbench.calls.filter((call) => call.method === "POST" && call.path.endsWith("/refresh"));

const OBSERVED_TITLE = /^session-1 · observed \d{4}-\d\d-\d\d \d\d:\d\d UTC$/u;

/** The counts t3code's panel reads, and the pull request's number and state. */
const countsOf = (status: {
  readonly hasUpstream: boolean;
  readonly aheadCount: number;
  readonly aheadOfDefaultCount?: number | undefined;
  readonly pr: { readonly number: number; readonly state: string } | null;
}) => [
  status.hasUpstream,
  status.aheadCount,
  status.aheadOfDefaultCount,
  status.pr === null ? null : `#${status.pr.number} ${status.pr.state}`,
];

const remoteUpdated = (event: Event): event is Extract<Event, { _tag: "remoteUpdated" }> =>
  event._tag === "remoteUpdated";

const snapshotOf = (event: Event): event is Extract<Event, { _tag: "snapshot" }> =>
  event._tag === "snapshot";

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
          // Mend cannot tell nothing is new after a push, so Push stays offered.
          const after = yield* status.next(remoteUpdated);
          assert.deepStrictEqual(after.remote, {
            hasUpstream: true,
            aheadCount: 1,
            behindCount: 0,
            aheadOfDefaultCount: 1,
            pr: {
              number: 1,
              title: after.remote?.pr?.title ?? "",
              url: "https://github.com/sealant-sh/mend/pull/1",
              baseRef: "main",
              headRef: BRANCH,
              state: "open",
              updatedAt: after.remote?.pr?.updatedAt,
            },
          });
          assert.match(after.remote?.pr?.title ?? "", OBSERVED_TITLE);
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
        assert.deepStrictEqual(countsOf(ahead), [true, 1, 1, "#1 open"]);

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
        assert.deepStrictEqual(countsOf(landed), [true, 1, 1, "#1 open"]);
      }),
    ),
  );

  it.live(
    "pushes, opens #1, sees it merged on GitHub, and opens #2 for the work after the merge",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-SEQUENCE");
          const pushed = yield* runAction(rpc, "push");
          assert.deepStrictEqual(pushed.result?.pr, { status: "skipped_not_requested" });
          assert.deepStrictEqual(pushed.result?.toast.cta, { kind: "none" });

          // Pushed without a pull request: t3code offers "Push & create PR".
          const unopened = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(countsOf(unopened), [true, 1, 1, null]);
          const first = yield* runAction(rpc, "create_pr");
          assert.deepStrictEqual(first.result?.pr, {
            status: "created",
            url: "https://github.com/sealant-sh/mend/pull/1",
            number: 1,
            headBranch: BRANCH,
            title: "session-1",
            baseBranch: "main",
          });

          // Merged on GitHub. The person's refresh asks GitHub through Mend.
          mend.workbench.github.set(1, "merged");
          const merged = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.strictEqual(refreshCalls(mend).length, 1);
          assert.deepStrictEqual(countsOf(merged), [true, 1, 1, "#1 merged"]);

          // Nothing new since: Mend says so in its own words.
          const idle = yield* runAction(rpc, "create_pr");
          assert.include(
            idle.error?.message ?? "",
            "landing not started · nothing new since the last landing",
          );

          // New work after the merge opens a new pull request on the same branch.
          mend.workbench.sinceLanding.set(CHANGE, 1);
          const after = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(countsOf(after), [true, 1, 1, "#1 merged"]);
          const second = yield* runAction(rpc, "create_pr");
          assert.isUndefined(second.error);
          assert.deepStrictEqual(
            [second.result?.pr.status, second.result?.toast.title],
            ["created", "Opened pull request #2"],
          );
          const reopened = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(countsOf(reopened), [true, 1, 1, "#2 open"]);
        }),
      ),
  );

  it.live(
    "says the worktree holds work while some is unlanded, and clean once all of it has landed",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-UNLANDED");
          // Before any landing, the change's files are unlanded: t3code offers "Commit, push & PR".
          const unlanded = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.isTrue(unlanded.hasWorkingTreeChanges);

          yield* runAction(rpc, "create_pr");
          // Everything landed, nothing new since: no commit, and the push stays offered.
          const landed = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.isFalse(landed.hasWorkingTreeChanges);
          assert.deepStrictEqual(countsOf(landed), [true, 1, 1, "#1 open"]);

          // New work after the landing is unlanded again.
          mend.workbench.sinceLanding.set(CHANGE, 2);
          const changed = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.isTrue(changed.hasWorkingTreeChanges);

          // Landing it settles the status again.
          yield* runAction(rpc, "push");
          const settled = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.isFalse(settled.hasWorkingTreeChanges);

          // A change that holds no files has nothing to land, landed or not.
          mend.workbench.stats.set(CHANGE, { files: 0, additions: 0, deletions: 0 });
          mend.workbench.sinceLanding.set(CHANGE, 3);
          const empty = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.isFalse(empty.hasWorkingTreeChanges);
        }),
      ),
  );

  it.live("streams the worktree as clean once the owner lands it", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "LAND-STREAM-CLEAN");
        const events: Array<Event> = [];
        yield* rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }).pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("200 millis");
        const opening = events.find(snapshotOf);
        assert.isTrue(opening?.local.hasWorkingTreeChanges);

        yield* runAction(rpc, "push");
        yield* Effect.sleep("1500 millis");
        const local = events.filter(
          (event): event is Extract<Event, { _tag: "localUpdated" }> =>
            event._tag === "localUpdated",
        );
        assert.isFalse(local.at(-1)?.local.hasWorkingTreeChanges);
      }),
    ),
  );

  it.live("offers a push after the agent commits the tree a landing already pushed", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "LAND-SAME-TREE");
        yield* runAction(rpc, "create_pr");
        mend.workbench.agentCommitted.add(CHANGE);

        const status = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.deepStrictEqual(countsOf(status), [true, 1, 1, "#1 open"]);
        // The agent's commit moved no file past the landed checkpoint: nothing to commit.
        assert.isFalse(status.hasWorkingTreeChanges);
        const { error, result } = yield* runAction(rpc, "push");
        assert.isUndefined(error);
        assert.strictEqual(result?.toast.title, `Pushed to ${BRANCH}`);
        assert.strictEqual(landCalls(mend).length, 2);
      }),
    ),
  );

  it.live("commit & push and commit, push & PR land the change", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "LAND-COMMIT-PUSH");
        const pushed = yield* runAction(rpc, "commit_push");
        assert.isUndefined(pushed.error);
        assert.deepStrictEqual(pushed.result?.push, {
          status: "pushed",
          branch: BRANCH,
          upstreamBranch: `origin/${BRANCH}`,
        });
        assert.deepStrictEqual(pushed.result?.pr, { status: "skipped_not_requested" });

        mend.workbench.sinceLanding.set(CHANGE, 1);
        const opened = yield* runAction(rpc, "commit_push_pr");
        assert.isUndefined(opened.error);
        assert.strictEqual(opened.result?.pr.status, "created");
        assert.strictEqual(opened.result?.toast.title, "Opened pull request #1");
        assert.deepStrictEqual(
          landCalls(mend).map((call) => call.body),
          [
            { pullRequest: false, branch: null, title: null, body: null },
            { pullRequest: true, branch: null, title: null, body: null },
          ],
        );
      }),
    ),
  );

  it.live(
    "a failed pull request step ends the action failed after the push, and Create PR stays offered",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const { rpc } = yield* pairAndConnect(mend, "LAND-PR-FAILED");
          mend.workbench.nextPullRequestFailure = "gh: HTTP 502";
          const { events, error, result } = yield* runAction(rpc, "create_pr");
          assert.isUndefined(result);
          assert.strictEqual(error?._tag, "GitManagerError");
          assert.match(
            error?.message ?? "",
            new RegExp(
              `pushed [0-9a-f]{7} to ${BRANCH} · pull request step failed · gh: HTTP 502$`,
              "u",
            ),
          );
          const ended = events.at(-1);
          assert.deepStrictEqual(
            ended?.kind === "action_failed" ? [ended.phase, ended.message] : [],
            ["pr", error?.message],
          );

          // On reload the push stands and no pull request is open, so Create PR is offered.
          const status = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(countsOf(status), [true, 1, 1, null]);
          const retried = yield* runAction(rpc, "create_pr");
          assert.isUndefined(retried.error);
          assert.strictEqual(retried.result?.toast.title, "Opened pull request #1");
        }),
      ),
  );

  it.live("offers no pull request when origin is not on GitHub, and keeps Push", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const reason = "pull request unavailable · origin is on gitlab.com, not GitHub";
        mend.workbench.pullRequestAvailability.set("project-1", { available: false, reason });
        const { rpc } = yield* pairAndConnect(mend, "LAND-GITLAB");

        const before = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.deepStrictEqual(countsOf(before), [false, 1, 0, null]);
        // t3code's main action still reads "Push & create PR"; Mend pushes and says why not.
        const { error, result } = yield* runAction(rpc, "create_pr");
        assert.isUndefined(error);
        assert.deepStrictEqual(result?.pr, { status: "skipped_not_requested" });
        assert.match(result?.toast.description ?? "", new RegExp(` · ${reason}$`, "u"));
        const after = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.deepStrictEqual(countsOf(after), [true, 1, 0, null]);
      }),
    ),
  );

  it.live("asks GitHub at most once a minute, only on the person's refresh", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        setup(mend);
        const { rpc } = yield* pairAndConnect(mend, "LAND-REFRESH");
        yield* runAction(rpc, "create_pr");
        const status = yield* feed(rpc[WS_METHODS.subscribeVcsStatus]({ cwd: WORKTREE }));
        yield* status.next(snapshotOf);
        assert.deepStrictEqual(refreshCalls(mend), [], "a status stream never asks GitHub");

        const first = yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        yield* rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
        assert.strictEqual(refreshCalls(mend).length, 1);
        assert.match(first.pr?.title ?? "", OBSERVED_TITLE);
      }),
    ),
  );

  it.live(
    "a teammate reads the owner's counts, and a landing is refused in Mend's words with no side effect",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          setup(mend);
          const ada = yield* pairAndConnect(mend, "LAND-ADA");
          yield* runAction(ada.rpc, "create_pr");
          mend.workbench.sinceLanding.set(CHANGE, 3);

          const bea = yield* pairAndConnect(mend, "LAND-BEA", BEA);
          const seen = yield* bea.rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          const owners = yield* ada.rpc[WS_METHODS.vcsRefreshStatus]({ cwd: WORKTREE });
          assert.deepStrictEqual(countsOf(seen), [true, 1, 1, "#1 open"]);
          assert.deepStrictEqual(countsOf(seen), countsOf(owners), "the counts Ada sees");
          assert.strictEqual(refreshCalls(mend).length, 1, "only Ada's refresh asked GitHub");

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
