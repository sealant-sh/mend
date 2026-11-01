import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  AgentConversationRepo,
  ChangeLandingsRepo,
  ChangePassesRepo,
  ChangeToursRepo,
  ProjectsRepo,
  ReviewCommentsRepo,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  WorktreeNotFoundError,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  ChangeId,
  ChangeLandingId,
  OrganizationId,
  PreviewId,
  ProjectId,
  ReviewCommentId,
  SealantRunId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentItem,
  AgentRequest,
  AgentTurn,
  AgentWait,
  Change,
  ChangeLanding,
  ChangePass,
  ChangeTour,
  foldSessionLiveness,
  Project,
  ReviewComment,
  idleStopSummary,
  Session,
  SessionProcess,
  type AgentItemKind,
  type AgentRequestKind,
  type AgentTurnStatus,
  type SlackInstallSettings,
  type PreviewStatus,
  type TurnLanding,
} from "@mend/domain/workbench";
import { PublicOrigin } from "@mend/network";
import { ResourceStatusReadsNone } from "@mend/sessions";
import { WORKTREE_STAMP, WorktreeReads } from "@mend/sessions";
import {
  NO_PREVIEWS,
  PRIVATE_PROJECT_STATUS,
  SLACK_ACTIONS,
  statusLine,
  SUMMARY_PROVENANCE,
  type WorktreePreviews,
} from "@mend/slack";
import { makeFakeSlack, SlackApi, SlackApiError, type FakeSlackCall } from "@mend/slack/client";
import { SecretCipher, Store, StoreConfig, type ChangedFile } from "@mend/store";
import { TestClock } from "@mend/test-ci/effect-vitest";
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { PreviewReadUnavailable, SlackPreviewReads } from "../src/slack-preview-reads.ts";
import {
  closingOf,
  makeSlackReporter,
  openingOf,
  REQUEST_RETRY_MS,
  reviewMoment,
  SlackReports,
  SlackReportsLive,
  STATUS_EDIT_EVERY_MS,
  STATUS_PREVIEW_EVERY_MS,
  type SlackReportTarget,
} from "../src/slack-reporter.ts";

const NOW = new Date("2026-09-23T10:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const ACME = OrganizationId.make("org-acme");
const PROJECT = ProjectId.make("p-billing");
const SESSION = SessionId.make("session-1");
const WORKTREE = WorktreeId.make("wt-1");
const CHANGE = ChangeId.make("chg-1");
const CHANNEL = "C-general";
const THREAD = "1700000100.000100";
const REQUEST = "1700000100.000300";
const STATUS = "1700000100.000400";
const SESSION_URL = "https://mend.acme.test/sessions/session-1";

const settings: SlackInstallSettings = {
  defaultHarness: "claude",
  showAgentMessages: true,
  showDiffs: false,
  externalChannels: false,
  landAutomatically: true,
};

const installWith = (overrides: Partial<SlackInstallSettings> = {}): SealedSlackInstall => ({
  organizationId: ACME,
  teamId: "T-acme",
  teamName: "Acme HQ",
  botUserId: "U-bot",
  appId: "A-acme",
  sealedAppToken: "sealed:xapp-acme",
  sealedBotToken: "sealed:xoxb-acme",
  webOrigin: "https://mend.acme.test",
  settings: { ...settings, ...overrides },
  installedByUserId: "alice",
  createdAt: NOW,
  updatedAt: NOW,
});

const project = new Project({
  id: PROJECT,
  name: "billing-api",
  organizationId: ACME,
  visibility: "shared",
  createdByUserId: "alice",
  originUrl: "git@github.com:acme/billing-api.git",
  storePath: "/store/p-billing/repo.git",
  defaultBranch: "main",
  adoptedSha: Sha.make("0".repeat(40)),
  autoTour: "inherit",
  autoName: "inherit",
  autoLand: "inherit",
  autoSuggest: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "mend-key",
  workspaceImage: null,
  applyDotfiles: true,
  defaultShellProfile: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
  installEnabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});

const sessionWith = (status: Session["status"]) =>
  new Session({
    id: SESSION,
    projectId: PROJECT,
    worktreeId: WORKTREE,
    harness: "claude",
    providerSessionId: null,
    label: null,
    worktree: "flaky-login-test",
    branch: "mend/flaky-login-test",
    baseSha: Sha.make("abc"),
    baseRef: "main",
    contextSnapshotId: null,
    referenceMounts: [],
    extraMounts: [],
    sealantRunId: SealantRunId.make("run-1"),
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: "protocol-1",
    workspaceExpiresAt: null,
    workspaceTtlRenewedAt: null,
    workspaceTtlRenewalFailedAt: null,
    workspaceTtlRenewalError: null,
    workspaceImage: null,
    dotfiles: null,
    ownerUserId: "alice",
    origin: "slack",
    hasTranscript: null,
    status,
    summary: null,
    lastSeenSequence: 0n,
    recordHistoryComplete: true,
    startedAt: NOW,
    settledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

const agent = new SessionProcess({
  id: SessionProcessId.make("agent-1"),
  sessionId: SESSION,
  sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
  sealantSessionId: "protocol-1",
  sealantRunId: null,
  launchCorrelationId: null,
  serviceId: null,
  attemptOrdinal: null,
  kind: "agent-protocol",
  harness: "claude",
  providerSessionId: null,
  protocolOptions: null,
  label: "claude",
  argv: ["claude"],
  status: "running",
  exitCode: null,
  workspacePort: null,
  protocol: "tcp",
  hostPort: null,
  createdAt: NOW,
  exitedAt: null,
  updatedAt: NOW,
});

const turn = (ordinal: number, status: AgentTurnStatus, endedAt: Date | null = null) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${ordinal}`),
    sessionId: SESSION,
    processId: agent.id,
    ordinal,
    author: "alice",
    input: "fix the flaky login test",
    status,
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: NOW,
    startedAt: NOW,
    endedAt,
  });

/** A turn automatic landing decided about (docs/adr/0007-landing.md). */
const decidedTurn = (
  ordinal: number,
  landing: TurnLanding,
  endedAt: Date = NOW,
  intentSource: AgentTurn["intentSource"] = null,
) =>
  new AgentTurn({
    ...turn(ordinal, "completed", endedAt),
    landing,
    intent: intentSource === "read" ? "change" : null,
    intentSource,
  });

/** A landing of the change, as `change_landings` records it. */
const landingOf = (
  id: string,
  outcome: ChangeLanding["outcome"],
  options: {
    readonly createdAt?: Date;
    readonly pullRequest?: number;
    readonly message?: string;
  } = {},
) =>
  new ChangeLanding({
    id: ChangeLandingId.make(id),
    changeId: CHANGE,
    sessionId: SESSION,
    projectId: PROJECT,
    checkpointId: null,
    checkpointRef: null,
    checkpointSha: null,
    commitSha: null,
    remoteBranch: "mend/flaky-login-test",
    pushedSha: outcome === "refused" ? null : Sha.make("3f2a1c0".padEnd(40, "0")),
    trigger: "automatic",
    pullRequest:
      options.pullRequest === undefined
        ? null
        : {
            number: options.pullRequest,
            url: `https://github.com/acme/billing-api/pull/${options.pullRequest}`,
            state: "open",
            title: null,
            observedAt: options.createdAt ?? NOW,
          },
    outcome,
    message: options.message ?? null,
    userId: "alice",
    createdAt: options.createdAt ?? NOW,
  });

const item = (
  id: string,
  turnOrdinal: number,
  kind: AgentItemKind,
  text: string | null,
  status: AgentItem["status"] = "completed",
  updatedAt: Date = NOW,
) =>
  new AgentItem({
    id: AgentItemId.make(id),
    sessionId: SESSION,
    processId: agent.id,
    turnId: AgentTurnId.make(`turn-${turnOrdinal}`),
    seq: 1,
    providerItemId: id,
    kind,
    status,
    title: null,
    text,
    data: null,
    createdAt: updatedAt,
    updatedAt,
  });

const request = (id: string, kind: AgentRequestKind, createdAt: Date = NOW) =>
  new AgentRequest({
    id: AgentRequestId.make(id),
    sessionId: SESSION,
    processId: agent.id,
    turnId: AgentTurnId.make("turn-1"),
    kind,
    providerRequestId: id,
    providerItemId: null,
    title: kind === "user-input" ? null : "pnpm test --filter login",
    detail: null,
    questions:
      kind === "user-input"
        ? [
            {
              id: "q1",
              header: null,
              question: "Keep the retry limit at 3?",
              options: [
                { label: "Yes", description: null },
                { label: "No", description: "make it configurable" },
              ],
              multiSelect: false,
            },
          ]
        : null,
    status: "pending",
    decision: null,
    decidedBy: null,
    answers: null,
    createdAt,
    decidedAt: null,
  });

const change = new Change({
  id: CHANGE,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SESSION,
  branch: "mend/flaky-login-test",
  baseSha: Sha.make("abc"),
  headSha: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const draft = (id: string, kind: "note" | "suggestion") =>
  new ReviewComment({
    id: ReviewCommentId.make(id),
    changeId: CHANGE,
    file: "src/login.ts",
    line: 3,
    endLine: null,
    anchor: null,
    authorKind: "mend",
    authorName: "Mend",
    body: "the retry is unbounded",
    kind,
    suggestion: kind === "suggestion" ? "retry(3)" : null,
    state: "draft",
    evidence: [],
    sentToSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

/** A machine pass over the change, finished at `at` unless it is running. */
const passOf = (
  kind: ChangePass["kind"],
  status: ChangePass["status"],
  at: Date = NOW,
  findings: number | null = null,
) =>
  new ChangePass({
    changeId: CHANGE,
    kind,
    status,
    detail: status === "failed" ? "the provider refused the request" : null,
    findings,
    startedAt: at,
    finishedAt: status === "running" ? null : at,
  });

const tourOf = (createdAt: Date = NOW) =>
  new ChangeTour({
    id: "tour-1",
    changeId: CHANGE,
    sessionId: SESSION,
    summary: "Bounds the login retry at three attempts and logs each one.",
    approach: "Read the flaky test, reproduced the failure, then ran the suite.",
    stops: [],
    diffDigest: "d".repeat(64),
    createdAt,
  });

const SUMMARY_BLOCK =
  "**Summary**\nBounds the login retry at three attempts and logs each one.\n\n**Approach**\nRead the flaky test, reproduced the failure, then ran the suite.";

const DIFF = [
  "diff --git a/src/login.ts b/src/login.ts",
  "--- a/src/login.ts",
  "+++ b/src/login.ts",
  "@@ -1,2 +1,3 @@",
  "-retry()",
  "+retry(3)",
  "+log()",
  "diff --git a/test/login.test.ts b/test/login.test.ts",
  "--- a/test/login.test.ts",
  "+++ b/test/login.test.ts",
  "@@ -1 +1 @@",
  "+expect(retries).toBe(3)",
  "",
].join("\n");

const startingLine = statusLine({
  project: "billing-api",
  source: "thread-link",
  harness: "claude",
  branch: "mend/flaky-login-test",
  state: "starting",
  recorded: true,
  change: null,
  url: SESSION_URL,
});

interface WorldOptions {
  /** A real Store observation supplied at the existing WorktreeReads boundary. */
  readonly diff?: { readonly files: ReadonlyArray<ChangedFile>; readonly patch: string };
  readonly settings?: Partial<SlackInstallSettings>;
  /** The channel the thread is in; a `D…` channel is a direct message with the bot. */
  readonly channelId?: string;
  /** The organization that installed the app, when it is not the project's. */
  readonly installOrganization?: OrganizationId;
  readonly external?: boolean;
  /** When the thread started: recent threads have no history to replay. */
  readonly threadCreatedAt?: Date;
}

/**
 * A reporter over fakes. `state` is the database: the thread row, the session, its turns, items,
 * requests, change and passes, which a test moves between looks. Slack is the in-memory fake, and
 * `posts` and `updates` read what it was sent.
 */
const world = (options: WorldOptions = {}) => {
  const slack = makeFakeSlack([
    {
      teamId: "T-acme",
      teamName: "Acme HQ",
      appId: "A-acme",
      botId: "B-acme",
      botUserId: "U-bot",
      botToken: "xoxb-acme",
      appToken: "xapp-acme",
    },
  ]);
  const state = {
    thread: {
      sessionId: SESSION,
      teamId: "T-acme",
      channelId: options.channelId ?? CHANNEL,
      threadTs: THREAD,
      requestTs: REQUEST,
      statusTs: STATUS,
      slackUserId: "U-alice",
      projectSource: "thread-link",
      external: options.external ?? false,
      reportedState: "starting",
      reportedStatus: startingLine,
      createdAt: options.threadCreatedAt ?? minutesAgo(30),
    } satisfies SlackThreadSession as SlackThreadSession,
    session: sessionWith("running"),
    processes: [agent] as ReadonlyArray<SessionProcess>,
    turns: [] as ReadonlyArray<AgentTurn>,
    items: [] as ReadonlyArray<AgentItem>,
    requests: [] as ReadonlyArray<AgentRequest>,
    change: null as Change | null,
    passes: [] as ReadonlyArray<ChangePass>,
    tour: null as ChangeTour | null,
    comments: [] as ReadonlyArray<ReviewComment>,
    /** The change's landings, newest first. */
    landings: [] as ReadonlyArray<ChangeLanding>,
    posted: new Set<string>(),
    project,
    /** The thread row is gone (its session deleted). */
    threadGone: false,
    /** A later session started from the same request (a switch): its reaction is that one's. */
    requestReused: false,
    /** The worktree's previews as Slack's read returns them. */
    previews: NO_PREVIEWS,
    /** The next preview reads fail. */
    previewReadsFail: 0,
    /** How many times the previews were read. */
    previewReads: 0,
    /** How many times a thread's row was read: one per look. */
    threadReads: 0,
    /** How many times the change's files were read from the worktree. */
    diffReads: 0,
    /** The worktree cannot be read (it was removed). */
    worktreeGone: false,
    /** The next reads of the active sessions fail. */
    listActiveFailuresLeft: 0,
    /** The next `chat.update` waits for this before it reaches Slack. */
    updateGate: null as Deferred.Deferred<void> | null,
    /** The reporter's clock. */
    now: NOW.getTime(),
  };
  // The runner put ⏳ on the request when the session started; the reporter's writes follow.
  Effect.runSync(
    slack.service.reactionsAdd("xoxb-acme", {
      channel: options.channelId ?? CHANNEL,
      timestamp: REQUEST,
      name: "hourglass_flowing_sand",
    }),
  );
  const writes = () => slack.calls.slice(1);

  const scope = Scope.makeUnsafe();
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const clock = Effect.runSync(Layer.buildWithScope(TestClock.layer(), scope));

  const layer = Layer.mergeAll(
    ResourceStatusReadsNone,
    Layer.succeedContext(clock),
    Layer.succeed(SlackApi, {
      ...slack.service,
      update: (token, input) =>
        Effect.suspend(() => {
          const gate = state.updateGate;
          if (gate === null) return slack.service.update(token, input);
          state.updateGate = null;
          return Effect.andThen(Deferred.await(gate), slack.service.update(token, input));
        }),
    }),
    Layer.mock(SlackThreadsRepo, {
      forSession: (id) =>
        Effect.sync(() => {
          state.threadReads += 1;
          return id === SESSION && !state.threadGone ? state.thread : null;
        }),
      claimStatus: (_id, from, to) =>
        Effect.sync(() => {
          if (
            state.thread.statusTs === null ||
            state.thread.reportedState !== from.state ||
            state.thread.reportedStatus !== from.status
          ) {
            return false;
          }
          state.thread = { ...state.thread, reportedState: to.state, reportedStatus: to.status };
          return true;
        }),
      ownsRequestReaction: () => Effect.sync(() => !state.requestReused),
      sessionsReached: () => Effect.sync(() => (state.threadGone ? [] : [SESSION])),
      claimPost: (id, key) =>
        Effect.sync(() => {
          const claimed = `${id}:${key}`;
          if (state.posted.has(claimed)) return false;
          state.posted.add(claimed);
          return true;
        }),
    }),
    Layer.mock(SlackInstallsRepo, {
      byTeam: (teamId) =>
        Effect.succeed(
          teamId === "T-acme"
            ? {
                ...installWith(options.settings),
                organizationId: options.installOrganization ?? ACME,
              }
            : null,
        ),
    }),
    Layer.mock(SessionsRepo, {
      byId: (id) =>
        id === SESSION
          ? Effect.sync(() => state.session)
          : Effect.fail(new SessionNotFoundError({ sessionId: id })),
      listActive: () =>
        Effect.suspend(() => {
          if (state.listActiveFailuresLeft === 0) return Effect.succeed([state.session]);
          state.listActiveFailuresLeft -= 1;
          return Effect.die("the database is down");
        }),
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSession: () => Effect.sync(() => state.processes),
    }),
    Layer.mock(ProjectsRepo, { byId: () => Effect.sync(() => state.project) }),
    Layer.mock(AgentConversationRepo, {
      listTurns: () => Effect.sync(() => state.turns),
      listRequests: () => Effect.sync(() => state.requests),
      turnMessages: (turnId) =>
        Effect.sync(() => state.items.filter((entry) => entry.turnId === turnId)),
    }),
    Layer.mock(WorktreeChangesRepo, { byWorktree: () => Effect.sync(() => state.change) }),
    Layer.mock(ChangePassesRepo, { listForChange: () => Effect.sync(() => state.passes) }),
    Layer.mock(ChangeLandingsRepo, { listForChange: () => Effect.sync(() => state.landings) }),
    Layer.mock(ChangeToursRepo, { byChange: () => Effect.sync(() => state.tour) }),
    Layer.mock(ReviewCommentsRepo, { listForChange: () => Effect.sync(() => state.comments) }),
    Layer.mock(WorktreeReads, {
      changedFiles: () =>
        Effect.suspend(() => {
          state.diffReads += 1;
          return state.worktreeGone
            ? Effect.fail(new WorktreeNotFoundError({ id: WORKTREE }))
            : Effect.succeed({
                value: options.diff?.files ?? [
                  { path: "src/login.ts", additions: 2, deletions: 1 },
                  { path: "test/login.test.ts", additions: 1, deletions: 0 },
                ],
                stamp: WORKTREE_STAMP,
              });
        }),
      diffWorktree: () =>
        Effect.succeed({ value: options.diff?.patch ?? DIFF, stamp: WORKTREE_STAMP }),
    }),
    Layer.succeed(SecretCipher, {
      encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
      decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
    }),
    Layer.succeed(SlackPreviewReads, {
      forWorktree: (worktreeId) =>
        Effect.suspend(() => {
          state.previewReads += 1;
          if (state.previewReadsFail > 0) {
            state.previewReadsFail -= 1;
            return Effect.fail(new PreviewReadUnavailable({ worktreeId, cause: "refused" }));
          }
          return Effect.succeed(state.previews);
        }),
    }),
  );

  /** One worker process: its own memory of what it has seen, the shared database and Slack. */
  const worker = () =>
    Effect.runSync(
      makeSlackReporter({ now: () => state.now }).pipe(
        Effect.provide(layer),
        Effect.provideService(Scope.Scope, scope),
      ),
    );
  const observe = (reporter: ReturnType<typeof worker>) =>
    Effect.runPromise(reporter.observe(SESSION).pipe(Effect.provide(layer)));
  const baseline = (reporter: ReturnType<typeof worker>) =>
    Effect.runPromise(reporter.baseline().pipe(Effect.provide(layer)));

  /** The reporter as the worker runs it: built once, then asked to report. */
  const reports = () =>
    Effect.runSync(
      Layer.buildWithScope(SlackReportsLive.pipe(Layer.provide(layer)), scope).pipe(
        Effect.map((context) => Context.get(context, SlackReports)),
      ),
    );

  const advance = async (ms: number) => {
    state.now += ms;
    await Effect.runPromise(TestClock.adjust(ms).pipe(Effect.provideContext(clock)));
  };

  /** Hold the next `chat.update` until the returned release is called. */
  const hold = () => {
    const gate = Deferred.makeUnsafe<void>();
    state.updateGate = gate;
    return () => Effect.runSync(Deferred.succeed(gate, undefined));
  };

  return {
    state,
    slack,
    worker,
    observe,
    baseline,
    reports,
    advance,
    hold,
    writes,
    posts: () =>
      writes().flatMap((call: FakeSlackCall) => (call.kind === "postMessage" ? [call.input] : [])),
    updates: () =>
      writes().flatMap((call: FakeSlackCall) => (call.kind === "update" ? [call.input.text] : [])),
    reactions: () => slack.reactions.get(`${options.channelId ?? CHANNEL}:${REQUEST}`),
  };
};

const blockText = (post: { readonly blocks?: ReadonlyArray<unknown> }) => JSON.stringify(post);

const statusWith = (state: string) =>
  `billing-api · from a link in the thread · claude · ${state} · mend/flaky-login-test`;

/** The session's live terminal claude, waiting as its hooks last reported. */
const terminal = (waiting: AgentWait | null) =>
  new SessionProcess({ ...agent, kind: "agent-pty", sealantSessionId: "pty-1", waiting });

describe("the Slack thread reporter", () => {
  it("reports a session it is asked about, and every active session again after a resync", async () => {
    const w = world();
    w.state.turns = [turn(1, "running")];
    // Building it records what is live without writing anything.
    const reports = w.reports();
    expect(w.updates()).toEqual([]);

    await Effect.runPromise(reports.request({ _tag: "Resync" }));
    await vi.waitFor(() => expect(w.updates()).toEqual([statusWith("running")]));

    w.state.turns = [turn(1, "completed", NOW)];
    await Effect.runPromise(reports.request({ _tag: "Session", id: SESSION }));
    await vi.waitFor(() => expect(w.updates().at(-1)).toBe(statusWith("completed · observed")));
  });

  it("edits the one status message as the state moves, and swaps ⏳ for ✅ with the line counts", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    expect(w.updates()).toEqual([
      "billing-api · from a link in the thread · claude · running · mend/flaky-login-test",
    ]);
    expect(w.reactions()).toEqual(new Set(["hourglass_flowing_sand"]));

    // Nothing moved: nothing is written.
    await w.observe(reporter);
    expect(w.updates()).toHaveLength(1);

    w.state.turns = [turn(1, "completed", NOW)];
    w.state.change = change;
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      "billing-api · from a link in the thread · claude · completed · observed · mend/flaky-login-test · 2 files · +3 −1",
    );
    expect(w.reactions()).toEqual(new Set(["white_check_mark"]));
    const update = w.writes().find((call) => call.kind === "update");
    expect(update?.kind === "update" ? update.input : null).toMatchObject({
      channel: CHANNEL,
      ts: STATUS,
    });
    expect(w.state.thread.reportedState).toBe("completed");
  });

  it("moves the status line at most every 30 s while the session runs, then lands on the latest state", async () => {
    const running =
      "billing-api · from a link in the thread · claude · running · mend/flaky-login-test";
    const waiting =
      "billing-api · from a link in the thread · claude · waiting for input · mend/flaky-login-test";
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    expect(w.updates()).toEqual([running]);

    await w.advance(5_000);
    w.state.session = sessionWith("waiting");
    await w.observe(reporter);
    await w.observe(reporter);
    expect(w.updates()).toEqual([running]);
    expect(w.state.thread.reportedState).toBe("running");

    await w.advance(STATUS_EDIT_EVERY_MS - 5_000);
    expect(w.updates()).toEqual([running, waiting]);
    expect(w.state.thread.reportedState).toBe("waiting");

    await w.advance(STATUS_EDIT_EVERY_MS);
    expect(w.updates()).toEqual([running, waiting]);
  });

  it("words a terminal agent's finished turn as idle with no reaction, and its next ask as waiting", async () => {
    const w = world();
    const reporter = w.worker();
    const report = async (row: SessionProcess) => {
      w.state.processes = [row];
      const liveness = foldSessionLiveness([row]);
      if (liveness === "settled") throw new Error("the terminal agent is live");
      w.state.session = sessionWith(liveness);
      await w.observe(reporter);
      await w.advance(STATUS_EDIT_EVERY_MS);
    };

    await report(terminal(null));
    expect(w.updates()).toEqual([statusWith("running")]);
    expect(w.reactions()).toEqual(new Set(["hourglass_flowing_sand"]));

    await report(terminal(new AgentWait({ kind: "prompt", tool: null, since: NOW })));
    expect(w.updates().at(-1)).toBe(statusWith("idle · claude finished its turn"));
    expect(w.state.thread.reportedState).toBe("idle");
    expect(w.reactions()).toEqual(new Set());

    await report(terminal(new AgentWait({ kind: "permission", tool: "Bash", since: NOW })));
    expect(w.updates().at(-1)).toBe(
      statusWith("waiting · claude needs your permission to use Bash"),
    );
    expect(w.state.thread.reportedState).toBe("waiting");
    expect(w.reactions()).toEqual(new Set(["hourglass_flowing_sand"]));
  });

  it("follows the session's fold when several agents are live, and words only a line of its state", async () => {
    const pty = (id: string, waiting: AgentWait | null, createdAt: Date) =>
      new SessionProcess({
        ...terminal(waiting),
        id: SessionProcessId.make(id),
        sealantSessionId: id,
        createdAt,
      });
    const asks = new AgentWait({ kind: "permission", tool: "Bash", since: NOW });
    const finished = new AgentWait({ kind: "prompt", tool: null, since: NOW });
    const threadSays = async (
      rows: ReadonlyArray<SessionProcess>,
      requests: ReadonlyArray<AgentRequest> = [],
    ) => {
      const w = world();
      w.state.processes = rows;
      w.state.requests = requests;
      const liveness = foldSessionLiveness(rows, requests.length > 0);
      if (liveness === "settled") throw new Error("an agent is live");
      w.state.session = sessionWith(liveness);
      await w.observe(w.worker());
      return { line: w.updates().at(-1), reactions: w.reactions() };
    };
    const waiting = {
      line: statusWith("waiting · claude needs your permission to use Bash"),
      reactions: new Set(["hourglass_flowing_sand"]),
    };
    const older = new Date(NOW.getTime() - 60_000);

    expect(await threadSays([pty("old", asks, older), pty("new", finished, NOW)])).toEqual(waiting);
    expect(await threadSays([pty("b", finished, NOW), pty("a", asks, NOW)])).toEqual(waiting);
    expect(await threadSays([pty("a", asks, NOW), pty("b", finished, NOW)])).toEqual(waiting);
    expect(await threadSays([pty("one", finished, older), pty("two", finished, NOW)])).toEqual({
      line: statusWith("idle · claude finished its turn"),
      reactions: new Set(),
    });
    expect(await threadSays([pty("working", null, older), pty("done", finished, NOW)])).toEqual({
      line: statusWith("running"),
      reactions: new Set(["hourglass_flowing_sand"]),
    });
    expect(
      await threadSays([agent, pty("done", finished, NOW)], [request("r1", "user-input")]),
    ).toEqual({
      line: statusWith("waiting for input"),
      reactions: new Set(["hourglass_flowing_sand"]),
    });
  });

  it("offers Switch project until the first turn completes, and takes it off with that edit", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    w.state.turns = [turn(1, "completed", NOW)];
    await w.observe(reporter);
    const [running, completed] = w
      .writes()
      .flatMap((call: FakeSlackCall) => (call.kind === "update" ? [call.input] : []));
    expect(blockText(running ?? {})).toContain(SLACK_ACTIONS.switchProject);
    expect(blockText(completed ?? {})).not.toContain(SLACK_ACTIONS.switchProject);
  });

  it("marks a failed turn with ❌, and a stopped one with no reaction", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "failed", NOW)];
    await w.observe(reporter);
    expect(w.reactions()).toEqual(new Set(["x"]));

    w.state.turns = [turn(1, "failed", NOW), turn(2, "interrupted", NOW)];
    await w.observe(reporter);
    expect(w.reactions()).toEqual(new Set());
    expect(w.updates().at(-1)).toContain("· stopped ·");
  });

  it("reads an idle stop as idle-stopped: the summary on the status line, and 💤 for ⏳ or ✅", async () => {
    const idleStopped = () =>
      new Session({
        ...sessionWith("stopped"),
        summary: idleStopSummary(15),
        idleStoppedAt: NOW,
        settledAt: NOW,
      });
    const stoppedAgent = new SessionProcess({ ...agent, status: "stopped", exitedAt: NOW });

    // A turn that completed, then the idle stop.
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "completed", NOW)];
    await w.observe(reporter);
    expect(w.reactions()).toEqual(new Set(["white_check_mark"]));
    w.state.session = idleStopped();
    w.state.processes = [stoppedAgent];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      "billing-api · from a link in the thread · claude · idle · stopped after 15 min · reply to resume · mend/flaky-login-test",
    );
    expect(w.reactions()).toEqual(new Set(["zzz"]));
    expect(w.state.thread.reportedState).toBe("idle-stopped");

    // An agent that never took a turn: ⏳ goes, and nothing reads ❌.
    const quiet = world();
    const quietReporter = quiet.worker();
    await quiet.observe(quietReporter);
    expect(quiet.reactions()).toEqual(new Set(["hourglass_flowing_sand"]));
    quiet.state.session = idleStopped();
    quiet.state.processes = [stoppedAgent];
    await quiet.observe(quietReporter);
    expect(quiet.reactions()).toEqual(new Set(["zzz"]));

    // The reply that resumes it puts the thread back to running.
    w.state.session = sessionWith("running");
    w.state.processes = [agent];
    w.state.turns = [turn(1, "completed", NOW), turn(2, "running")];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toContain("· running ·");
    expect(w.reactions()).toEqual(new Set(["hourglass_flowing_sand"]));
  });

  it("posts each turn's closing message, cut to 3,000 characters with a link", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);

    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [
      item("i1", 1, "assistant-message", "Reading the test first."),
      item("i2", 1, "command-execution", "pnpm test"),
      item("i3", 1, "assistant-message", `Fixed the retry.\n${"detail ".repeat(600)}`),
    ];
    await w.observe(reporter);
    const [closing] = w.posts();
    expect(closing?.threadTs).toBe(THREAD);
    expect(closing?.blocks?.[0]?.type).toBe("markdown");
    const text = closing?.blocks?.[0]?.type === "markdown" ? closing.blocks[0].text : "";
    expect(text.startsWith("Fixed the retry.")).toBe(true);
    expect(text).toContain(`[The full message is in Mend](${SESSION_URL})`);
    expect(text.length).toBeLessThan(3_100);
    // The opening message was not a plan, so only the closing one is posted.
    expect(w.posts()).toHaveLength(1);
  });

  it("records a session first seen mid-flight without posting, and announces nothing older than two minutes", async () => {
    const w = world();
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    w.state.requests = [request("r1", "user-input")];
    const reporter = w.worker();
    await w.observe(reporter);
    // The status message still converges; no reply is posted.
    expect(w.updates()).toHaveLength(1);
    expect(w.posts()).toEqual([]);

    // A turn that ended five minutes ago is history, not news.
    w.state.turns = [turn(1, "completed", NOW), turn(2, "completed", minutesAgo(5))];
    w.state.items = [...w.state.items, item("i2", 2, "assistant-message", "Old news.")];
    w.state.requests = [
      request("r1", "user-input"),
      request("r2", "command-approval", minutesAgo(5)),
    ];
    await w.observe(reporter);
    expect(w.posts()).toEqual([]);
  });

  it("records what is live at startup, and treats a thread from the last two minutes as news", async () => {
    const settled = world();
    settled.state.turns = [turn(1, "running")];
    const restarted = settled.worker();
    await settled.baseline(restarted);
    settled.state.turns = [turn(1, "completed", NOW)];
    settled.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    await settled.observe(restarted);
    expect(settled.posts().map((post) => post.text)).toEqual(["Fixed the retry."]);

    const young = world({ threadCreatedAt: minutesAgo(1) });
    young.state.turns = [turn(1, "completed", NOW)];
    young.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    await young.observe(young.worker());
    expect(young.posts().map((post) => post.text)).toEqual(["Fixed the retry."]);
  });

  it("posts the agent's first message when it is a plan, once it is written", async () => {
    const w = world({ threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    w.state.items = [item("p1", 1, "plan", "1. read the test", "in-progress")];
    await w.observe(reporter);
    expect(w.posts()).toEqual([]);

    w.state.items = [item("p1", 1, "plan", "1. read the test\n2. bound the retry")];
    await w.observe(reporter);
    await w.observe(reporter);
    expect(w.posts().map((post) => post.text)).toEqual(["1. read the test\n2. bound the retry"]);
  });

  it("asks the owner the agent's question, and words an approval as a status line with a link", async () => {
    const w = world({ threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.session = sessionWith("waiting");
    w.state.turns = [turn(1, "running")];
    w.state.requests = [request("r1", "user-input"), request("r2", "command-approval")];
    await w.observe(reporter);

    expect(w.updates()).toEqual([
      "billing-api · from a link in the thread · claude · waiting for input · mend/flaky-login-test",
    ]);
    const [question, approval] = w.posts();
    expect(blockText(question ?? {})).toContain("<@U-alice> the agent asks:");
    expect(blockText(question ?? {})).toContain("Keep the retry limit at 3?");
    expect(approval?.text).toBe(
      "approval requested · a command · `pnpm test --filter login` · answered in Mend",
    );
    expect(blockText(approval ?? {})).toContain(SESSION_URL);
  });

  it("counts the review pass's drafts once it has run, with Review in Mend", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.session = sessionWith("completed");
    w.state.change = change;
    w.state.passes = [
      new ChangePass({
        changeId: CHANGE,
        kind: "suggest",
        status: "running",
        detail: null,
        findings: null,
        startedAt: NOW,
        finishedAt: null,
      }),
    ];
    await w.observe(reporter);
    expect(w.posts()).toEqual([]);

    w.state.passes = [
      new ChangePass({
        changeId: CHANGE,
        kind: "suggest",
        status: "completed",
        detail: null,
        findings: 2,
        startedAt: NOW,
        finishedAt: NOW,
      }),
    ];
    w.state.comments = [draft("c1", "note"), draft("c2", "suggestion")];
    await w.observe(reporter);
    await w.observe(reporter);
    const [review] = w.posts();
    expect(w.posts()).toHaveLength(1);
    expect(review?.text).toBe("Mend read the change · 2 draft comments · 1 with a suggested edit");
    expect(review?.blocks?.[0]).toMatchObject({
      accessory: {
        action_id: SLACK_ACTIONS.reviewChange,
        url: "https://mend.acme.test/changes/chg-1",
      },
    });
  });

  it("posts one end-of-session reply: the tour's summary and approach, the draft count, and Review in Mend", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.session = sessionWith("completed");
    w.state.change = change;
    w.state.passes = [passOf("tour", "completed"), passOf("suggest", "running")];
    w.state.tour = tourOf();
    await w.observe(reporter);
    // The suggestion pass is still running: the reply waits for it.
    expect(w.posts()).toEqual([]);

    w.state.passes = [passOf("tour", "completed", minutesAgo(1)), passOf("suggest", "completed")];
    w.state.comments = [draft("c1", "note"), draft("c2", "suggestion")];
    await Promise.all([w.observe(reporter), w.observe(w.worker())]);
    await w.observe(w.worker());

    expect(w.posts()).toHaveLength(1);
    const [reply] = w.posts();
    expect(reply?.threadTs).toBe(THREAD);
    expect(reply?.text).toBe("Mend read the change · 2 draft comments · 1 with a suggested edit");
    expect(reply?.blocks).toEqual([
      { type: "markdown", text: SUMMARY_BLOCK },
      { type: "context", elements: [{ type: "mrkdwn", text: SUMMARY_PROVENANCE }] },
      expect.objectContaining({
        type: "section",
        accessory: expect.objectContaining({
          action_id: SLACK_ACTIONS.reviewChange,
          url: "https://mend.acme.test/changes/chg-1",
        }),
      }),
    ]);
  });

  it("posts the summary alone when only the tour ran, and does not repeat it for a later pass", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.session = sessionWith("completed");
    w.state.change = change;
    w.state.passes = [passOf("tour", "running")];
    await w.observe(reporter);
    w.state.passes = [passOf("tour", "completed", minutesAgo(1))];
    w.state.tour = tourOf(minutesAgo(1));
    await w.observe(reporter);
    expect(w.posts().map((post) => post.text)).toEqual(["Mend read the change"]);
    expect(w.posts()[0]?.blocks?.[0]).toEqual({ type: "markdown", text: SUMMARY_BLOCK });

    // Someone asks for suggestions from the review page: the count is news, the summary is not.
    w.state.passes = [passOf("tour", "completed", minutesAgo(1)), passOf("suggest", "completed")];
    await w.observe(reporter);
    expect(w.posts().map((post) => post.text)).toEqual([
      "Mend read the change",
      "Mend read the change · no draft comments",
    ]);
    expect(blockText(w.posts()[1] ?? {})).not.toContain("**Summary**");
  });

  it("keeps the summary out where agent messages are not shown, and out of a Slack Connect channel", async () => {
    const finish = async (options: WorldOptions, passes: ReadonlyArray<ChangePass>) => {
      const w = world({ ...options, threadCreatedAt: minutesAgo(1) });
      w.state.session = sessionWith("completed");
      w.state.change = change;
      w.state.passes = passes;
      w.state.tour = tourOf();
      await w.observe(w.worker());
      return w.posts();
    };
    const both = [passOf("tour", "completed"), passOf("suggest", "completed")];

    const off = await finish({ settings: { showAgentMessages: false } }, both);
    expect(off.map((post) => post.text)).toEqual(["Mend read the change · no draft comments"]);
    expect(blockText(off[0] ?? {})).not.toContain("Bounds the login retry");

    const external = await finish({ external: true }, both);
    expect(external.map((post) => post.text)).toEqual(["Mend read the change · no draft comments"]);
    expect(blockText(external[0] ?? {})).not.toContain("Bounds the login retry");

    const opened = await finish({ external: true, settings: { externalChannels: true } }, both);
    expect(blockText(opened[0] ?? {})).toContain("Bounds the login retry");

    // A tour alone, not shown: nothing to say beyond the status message.
    expect(
      await finish({ settings: { showAgentMessages: false } }, [passOf("tour", "completed")]),
    ).toEqual([]);
  });

  it("falls back to the closing message when the tour fails, and says nothing more for no change", async () => {
    const failed = world({ threadCreatedAt: NOW });
    failed.state.session = sessionWith("completed");
    failed.state.turns = [turn(1, "completed", NOW)];
    failed.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    failed.state.change = change;
    failed.state.passes = [passOf("tour", "failed")];
    await failed.observe(failed.worker());
    expect(failed.posts().map((post) => post.text)).toEqual(["Fixed the retry."]);

    // The tour failed and the suggestion pass ran: the count, without a summary.
    failed.state.passes = [passOf("tour", "failed"), passOf("suggest", "completed")];
    await failed.observe(failed.worker());
    expect(failed.posts().map((post) => post.text)).toEqual([
      "Fixed the retry.",
      "Mend read the change · no draft comments",
    ]);

    const nothing = world({ threadCreatedAt: NOW });
    nothing.state.session = sessionWith("completed");
    nothing.state.turns = [turn(1, "completed", NOW)];
    nothing.state.items = [item("i1", 1, "assistant-message", "Nothing to change.")];
    await nothing.observe(nothing.worker());
    expect(nothing.posts().map((post) => post.text)).toEqual(["Nothing to change."]);
  });

  it("posts a Claude plan's todo list as a checklist", async () => {
    const w = world({ threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    const todoWrite = {
      type: "tool_use",
      id: "toolu_1",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Read the flaky test", status: "in_progress", activeForm: "Reading" },
          { content: "Bound the retry", status: "pending", activeForm: "Bounding" },
        ],
      },
    };
    w.state.items = [
      new AgentItem({ ...item("p1", 1, "plan", null, "in-progress"), data: todoWrite }),
    ];
    await w.observe(reporter);
    expect(w.posts()).toEqual([]);

    w.state.items = [new AgentItem({ ...item("p1", 1, "plan", null), data: todoWrite })];
    await w.observe(reporter);
    await w.observe(reporter);
    expect(w.posts().map((post) => post.text)).toEqual([
      "**Plan**\n- ☐ Read the flaky test · in progress\n- ☐ Bound the retry",
    ]);
  });

  it("keeps to status, reactions and links when agent messages are off", async () => {
    const w = world({ settings: { showAgentMessages: false }, threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [
      item("p1", 1, "plan", "1. read the test"),
      item("i1", 1, "assistant-message", "Fixed the retry."),
    ];
    w.state.requests = [request("r1", "user-input"), request("r2", "command-approval")];
    await w.observe(reporter);

    expect(w.posts().map((post) => post.text)).toEqual([
      "<@U-alice> the agent asked a question · answer it in Mend, or mention Mend here with the answer",
      "approval requested · a command · answered in Mend",
    ]);
    expect(w.updates()).toHaveLength(1);
  });

  it("posts each changed file's diff only when diffs are on, and not in a Slack Connect channel unless opened", async () => {
    const finish = async (options: WorldOptions) => {
      const w = world({ ...options, threadCreatedAt: NOW });
      w.state.turns = [turn(1, "completed", NOW)];
      w.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
      w.state.change = change;
      await w.observe(w.worker());
      return w.posts().map((post) => post.text);
    };

    expect(await finish({})).toEqual(["Fixed the retry."]);
    expect(await finish({ settings: { showDiffs: true } })).toEqual([
      "Fixed the retry.",
      "diff · 2 files",
    ]);
    // A Slack Connect channel gets status and links only…
    expect(await finish({ settings: { showDiffs: true }, external: true })).toEqual([]);
    // …until the owner opens external channels.
    expect(
      await finish({ settings: { showDiffs: true, externalChannels: true }, external: true }),
    ).toEqual(["Fixed the retry.", "diff · 2 files"]);

    const w = world({ settings: { showDiffs: true }, threadCreatedAt: NOW });
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.change = change;
    await w.observe(w.worker());
    const diff = w.posts()[0];
    const text = diff?.blocks?.[0]?.type === "markdown" ? diff.blocks[0].text : "";
    expect(text).toContain("**src/login.ts** · +2 −1\n\n```diff\ndiff --git a/src/login.ts");
    expect(text).toContain("**test/login.test.ts** · +1 −0");
  });

  it("posts actual Store diffs for quoted UTF-8 and renamed filenames instead of No text diff", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-slack-paths-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    try {
      git("init", "-q");
      git("config", "core.quotePath", "true");
      fs.writeFileSync(path.join(root, "naïve.txt"), "before\n");
      fs.writeFileSync(path.join(root, "old-ñ.txt"), "same content\n");
      git("add", "--all");
      git(
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "base",
      );
      fs.writeFileSync(path.join(root, "naïve.txt"), "after\n");
      const destination = 'new b/quote".txt';
      fs.mkdirSync(path.dirname(path.join(root, destination)), { recursive: true });
      fs.renameSync(path.join(root, "old-ñ.txt"), path.join(root, destination));
      git("add", "--all");
      const untracked = "untracked-界\tline\n.txt";
      fs.writeFileSync(path.join(root, untracked), "untracked-content\n");
      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          return {
            files: yield* store.changedFiles(root, "HEAD", null),
            patch: yield* store.diffWorktree(root, "HEAD"),
          };
        }).pipe(Effect.provide(Store.layer), Effect.provide(StoreConfig.layerFor(root))),
      );
      expect(observed.files.map((file) => file.path).toSorted()).toEqual(
        ["naïve.txt", destination, untracked].toSorted(),
      );
      const w = world({ settings: { showDiffs: true }, threadCreatedAt: NOW, diff: observed });
      w.state.change = change;
      w.state.turns = [turn(1, "completed", NOW)];
      await w.observe(w.worker());
      expect(w.posts()).toHaveLength(1);
      const block = w.posts()[0]?.blocks?.[0];
      const text = block?.type === "markdown" ? block.text : "";
      expect(text).toContain("**naïve.txt**");
      expect(text).toContain(`**${destination}**`);
      expect(text).toContain("+untracked-content");
      expect(text).toContain(`**${untracked}**`);
      expect(text).toContain("+after");
      expect(text).toContain("rename to ");
      expect(text).not.toContain("No text diff.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("posts the diff once, when the session first settles, not on every turn", async () => {
    const w = world({ settings: { showDiffs: true }, threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.change = change;
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    w.state.turns = [turn(1, "completed", NOW)];
    await w.observe(reporter);
    await w.observe(reporter);
    // A follow-up turn runs and completes: the change is posted in full only the first time.
    w.state.turns = [turn(1, "completed", NOW), turn(2, "running")];
    await w.observe(reporter);
    w.state.turns = [turn(1, "completed", NOW), turn(2, "completed", NOW)];
    await w.observe(reporter);
    await w.observe(w.worker());

    expect(w.posts().filter((post) => post.text.startsWith("diff ·"))).toHaveLength(1);
  });

  it("names nothing in a channel once the project is private: the status says so, and nothing is posted", async () => {
    const w = world({ threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toContain("billing-api");

    w.state.project = new Project({ ...project, visibility: "private" });
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [item("i1", 1, "assistant-message", "Fixed the retry in billing-api.")];
    w.state.requests = [request("r1", "user-input")];
    w.state.change = change;
    await w.observe(reporter);
    await w.observe(reporter);

    expect(w.posts()).toEqual([]);
    expect(w.updates()).toEqual([
      "billing-api · from a link in the thread · claude · running · mend/flaky-login-test",
      PRIVATE_PROJECT_STATUS,
    ]);
    const edit = w.writes().findLast((call) => call.kind === "update");
    expect(JSON.stringify(edit)).not.toContain("billing-api");
    expect(JSON.stringify(edit)).not.toContain(SESSION_URL);
    // The reaction still follows the state: it names nothing.
    expect(w.reactions()).toEqual(new Set(["white_check_mark"]));
  });

  it("keeps posting a private project's session in a direct message with the bot", async () => {
    const w = world({ channelId: "D-alice", threadCreatedAt: NOW });
    w.state.project = new Project({ ...project, visibility: "private" });
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    await w.observe(w.worker());

    expect(w.posts().map((post) => post.text)).toEqual(["Fixed the retry."]);
    expect(w.updates().at(-1)).toContain("billing-api");
  });

  it("writes nothing through an install of another organization than the project's", async () => {
    const w = world({
      installOrganization: OrganizationId.make("org-globex"),
      threadCreatedAt: NOW,
    });
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    await w.observe(w.worker());

    expect(w.writes()).toEqual([]);
  });

  it("forgets a settled session after an hour unseen, and a session that is gone at once", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.turns = [turn(1, "completed", NOW)];
    await w.observe(reporter);
    expect(reporter.remembered()).toBe(1);

    // Half an hour on, it is remembered: a question asked now is news.
    w.state.now = NOW.getTime() + 30 * 60_000;
    w.state.requests = [request("r1", "command-approval", new Date(w.state.now))];
    await w.observe(reporter);
    expect(w.posts()).toHaveLength(1);

    // An hour after that look it is forgotten, so the next look is a baseline and posts nothing.
    w.state.now += 61 * 60_000;
    w.state.requests = [
      ...w.state.requests,
      request("r2", "command-approval", new Date(w.state.now)),
    ];
    await w.observe(reporter);
    expect(w.posts()).toHaveLength(1);
    expect(reporter.remembered()).toBe(1);

    // Its thread is gone: forgotten at once.
    w.state.threadGone = true;
    await w.observe(reporter);
    expect(reporter.remembered()).toBe(0);
  });

  it("posts each reply once across two workers and a restart, and edits the status once", async () => {
    const w = world({ threadCreatedAt: NOW });
    const first = w.worker();
    const second = w.worker();
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [item("i1", 1, "assistant-message", "Fixed the retry.")];
    w.state.requests = [request("r1", "command-approval")];
    await Promise.all([w.observe(first), w.observe(second)]);
    await w.observe(w.worker());

    expect(w.posts().map((post) => post.text)).toEqual([
      "Fixed the retry.",
      "approval requested · a command · `pnpm test --filter login` · answered in Mend",
    ]);
    expect(w.updates()).toHaveLength(1);
    expect(w.writes().filter((call) => call.kind === "reactionsAdd")).toHaveLength(1);
  });

  it("holds every edit until Slack's Retry-After, whatever asks for the next look", async () => {
    const w = world();
    const reporter = w.worker();
    w.slack.refuseUpdates(
      new SlackApiError({
        method: "chat.update",
        code: "ratelimited",
        message: "rate limited",
        retryAfterSeconds: 3,
      }),
    );
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    expect(w.slack.refused.map((input) => input.text)).toEqual([statusWith("running")]);
    expect(w.state.thread.reportedState).toBe("running");

    await w.observe(reporter);
    w.state.turns = [turn(1, "completed", NOW)];
    await w.observe(reporter);
    expect(w.slack.refused).toHaveLength(1);
    expect(w.updates()).toEqual([]);

    await w.advance(3_000);
    await vi.waitFor(() => expect(w.updates()).toEqual([statusWith("completed · observed")]));
    // Shown now: a look at the same message edits nothing.
    await w.observe(reporter);
    expect(w.updates()).toHaveLength(1);
  });

  it("backs off an edit Slack refused without a Retry-After, longer after each refusal in a row", async () => {
    const w = world();
    const reporter = w.worker();
    w.slack.refuseUpdates(
      ...["first", "second"].map(
        () =>
          new SlackApiError({ method: "chat.update", code: "is_archived", message: "archived" }),
      ),
    );
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    await w.advance(4_999);
    await w.observe(reporter);
    expect(w.slack.refused).toHaveLength(1);
    await w.advance(1);
    await vi.waitFor(() => expect(w.slack.refused).toHaveLength(2));
    await w.advance(9_999);
    await w.observe(reporter);
    expect(w.slack.refused).toHaveLength(2);
    expect(w.updates()).toEqual([]);
    await w.advance(1);
    await vi.waitFor(() => expect(w.updates()).toEqual([statusWith("running")]));
  });

  it("never edits a status message Slack says is gone again, whatever moves, and still moves the reaction", async () => {
    for (const code of ["message_not_found", "channel_not_found"]) {
      const w = world();
      const reporter = w.worker();
      w.slack.refuseUpdates(new SlackApiError({ method: "chat.update", code, message: "gone" }));
      w.state.turns = [turn(1, "running")];
      await w.observe(reporter);
      w.state.turns = [turn(1, "completed", NOW)];
      w.state.previews = {
        _tag: "Shown",
        appUrl: PublicOrigin.make("https://app.mend.test"),
        previews: [{ id: PreviewId.make("pv-web"), service: "web", facts: [], openable: true }],
        unprepared: null,
      };
      await w.observe(reporter);
      await w.advance(60_000);
      await w.observe(reporter);
      expect(w.slack.refused).toHaveLength(1);
      expect(w.updates()).toEqual([]);
      expect(w.reactions()).toEqual(new Set(["white_check_mark"]));
    }
  });

  it("lets no retry overtake a newer edit: every look and send for a session takes its turn", async () => {
    const w = world();
    const reporter = w.worker();
    w.slack.refuseUpdates(
      new SlackApiError({ method: "chat.update", code: "internal_error", message: "try again" }),
    );
    w.state.turns = [turn(1, "running")];
    await w.observe(reporter);
    const release = w.hold();
    await w.advance(5_000);
    await vi.waitFor(() => expect(w.state.updateGate).toBeNull());
    w.state.turns = [turn(1, "completed", NOW)];
    const completed = w.observe(reporter);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(w.updates()).toEqual([]);
    release();
    await completed;
    expect(w.updates()).toEqual([statusWith("running"), statusWith("completed · observed")]);
  });

  it("lets no held-back preview edit land after a project turned private hid it", async () => {
    const w = world();
    const reporter = w.worker();
    const app = PublicOrigin.make("https://app.mend.test");
    const preview = (phase: "setup" | "depends"): WorktreePreviews => ({
      _tag: "Shown",
      appUrl: app,
      previews: [
        {
          id: PreviewId.make("pv-web"),
          service: "web",
          facts: [{ _tag: "Starting", service: "web", phase }],
          openable: false,
        },
      ],
      unprepared: null,
    });
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.session = sessionWith("completed");
    w.state.previews = preview("setup");
    await w.observe(reporter);
    w.state.previews = preview("depends");
    await w.observe(reporter);
    expect(w.updates()).toHaveLength(1);
    w.state.now += STATUS_PREVIEW_EVERY_MS;
    const release = w.hold();
    const previewed = w.observe(reporter);
    await vi.waitFor(() => expect(w.state.updateGate).toBeNull());
    w.state.project = new Project({ ...project, visibility: "private" });
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    release();
    await previewed;
    await vi.waitFor(() => expect(w.updates().at(-1)).toBe(PRIVATE_PROJECT_STATUS));
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(PRIVATE_PROJECT_STATUS);
  });

  it("leaves the request's reaction to the session a switch started from it", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.requestReused = true;
    w.state.turns = [turn(1, "completed", NOW)];
    await w.observe(reporter);
    expect(w.updates()).toEqual([statusWith("completed · observed")]);
    expect(w.reactions()).toEqual(new Set(["hourglass_flowing_sand"]));
    expect(w.state.thread.reportedState).toBe("completed");
  });

  it("keeps a failed launch's state while the rest of its status message still moves", async () => {
    const w = world();
    w.state.thread = {
      ...w.state.thread,
      reportedState: "failed",
      reportedStatus: statusWith("failed · observed"),
    };
    w.state.session = sessionWith("idle");
    w.state.processes = [];
    w.state.project = new Project({ ...project, name: "billing" });
    await w.observe(w.worker());
    expect(w.updates()).toEqual([
      "billing · from a link in the thread · claude · failed · observed · mend/flaky-login-test",
    ]);
    expect(w.state.thread.reportedState).toBe("failed");
  });

  it("never moves a failed launch back to starting, and writes nothing for a removed app", async () => {
    const w = world();
    w.state.thread = {
      ...w.state.thread,
      reportedState: "failed",
      reportedStatus: statusWith("failed · observed"),
    };
    w.state.session = sessionWith("idle");
    w.state.processes = [];
    await w.observe(w.worker());
    expect(w.writes()).toEqual([]);

    const gone = world();
    gone.state.thread = { ...gone.state.thread, teamId: "T-removed" };
    gone.state.turns = [turn(1, "running")];
    await gone.observe(gone.worker());
    expect(gone.writes()).toEqual([]);
  });
});

describe("landing in the thread (docs/adr/0007-landing.md)", () => {
  const COMPLETED =
    "billing-api · from a link in the thread · claude · completed · observed · mend/flaky-login-test · 2 files · +3 −1";

  it("puts the landing under the status line, and each later landing edits it in place", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "attempted")];
    // A landing from before the thread began is not this thread's news.
    w.state.landings = [landingOf("l0", "pushed", { createdAt: minutesAgo(40) })];
    await w.observe(reporter);
    expect(w.updates()).toEqual([COMPLETED]);

    w.state.landings = [landingOf("l1", "pull-request", { pullRequest: 412 }), ...w.state.landings];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      `${COMPLETED}\npushed · mend/flaky-login-test · pull request #412 · opened`,
    );

    // The next turn's landing updates the same pull request: the line moves, no reply is added.
    w.state.landings = [landingOf("l2", "pull-request", { pullRequest: 412 }), ...w.state.landings];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      `${COMPLETED}\npushed · mend/flaky-login-test · pull request #412 · updated`,
    );

    // A refusal reads in the remote's own words, on one line.
    w.state.landings = [
      landingOf("l3", "refused", {
        message:
          "origin has moved · mend/flaky-login-test has 1 commit Mend has not seen\n ! [rejected] (fetch first)",
      }),
      ...w.state.landings,
    ];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      `${COMPLETED}\npush refused · mend/flaky-login-test · origin has moved · mend/flaky-login-test has 1 commit Mend has not seen ! [rejected] (fetch first)`,
    );
    expect(w.posts()).toEqual([]);
    expect(w.updates()).toHaveLength(4);
  });

  it("says a pull request step that failed after the push, and a read that did not happen", async () => {
    const w = world();
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "attempted", NOW, "unread")];
    w.state.landings = [
      landingOf("l1", "failed", { message: "gh: no GitHub account is connected" }),
    ];
    await w.observe(w.worker());
    expect(w.updates().at(-1)).toBe(
      `${COMPLETED}\npushed · mend/flaky-login-test · pull request step failed · gh: no GitHub account is connected\nintent not read`,
    );
  });

  it("offers Push and open pull request once when a turn's change did not land, and a landing answers it", async () => {
    const w = world({ threadCreatedAt: NOW });
    const reporter = w.worker();
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "question")];
    await w.observe(reporter);
    await w.observe(reporter);
    await w.observe(w.worker());

    expect(w.updates().at(-1)).toBe(
      `${COMPLETED}\nchanges not landed · the request read as a question`,
    );
    expect(w.posts()).toHaveLength(1);
    const [offer] = w.posts();
    expect(offer?.threadTs).toBe(THREAD);
    expect(offer?.text).toBe("changes not landed · the request read as a question");
    expect(offer?.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "changes not landed · the request read as a question" },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_ACTIONS.landChange,
            text: { type: "plain_text", text: "Push and open pull request", emoji: true },
            value: SESSION,
            style: "primary",
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "lands as the change's owner, <@U-alice> · only they can use it",
          },
        ],
      },
    ]);

    // The owner pressed it: the landing answers the turn, and the line says what it did.
    w.state.landings = [landingOf("l1", "pull-request", { pullRequest: 412 })];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      `${COMPLETED}\npushed · mend/flaky-login-test · pull request #412 · opened`,
    );
    expect(w.posts()).toHaveLength(1);
  });

  it("offers it for automatic landing off and for someone else's follow-up, and not for an old turn", async () => {
    for (const [landing, line] of [
      ["off", "changes not landed · automatic landing is off"],
      ["not-owner", "changes not landed · the turn was not sent by the owner"],
      ["option", "changes not landed · the request said autopr=false"],
      ["not-captured", "not landed · the change was not captured"],
    ] as const) {
      const w = world({ threadCreatedAt: NOW });
      w.state.change = change;
      w.state.turns = [decidedTurn(1, landing)];
      await w.observe(w.worker());
      expect(w.posts().map((post) => post.text)).toEqual([line]);
    }

    for (const landing of ["attempted", "skipped"] as const) {
      const w = world({ threadCreatedAt: NOW });
      w.state.change = change;
      w.state.turns = [decidedTurn(1, landing)];
      await w.observe(w.worker());
      expect(w.posts()).toEqual([]);
    }

    // Nothing to push: no button, and the status line says why.
    for (const [landing, line] of [
      ["no-change", "not landed · the change is empty"],
      ["nothing-new", "not landed · nothing new since the last landing"],
    ] as const) {
      const w = world({ threadCreatedAt: NOW });
      w.state.change = change;
      w.state.turns = [decidedTurn(1, landing)];
      await w.observe(w.worker());
      expect(w.posts()).toEqual([]);
      expect(w.updates().at(-1)).toContain(line);
    }

    // Ten minutes after the turn ended the offer is history; the status line still says it.
    const late = world({ threadCreatedAt: NOW });
    late.state.change = change;
    late.state.turns = [decidedTurn(1, "question", minutesAgo(10))];
    await late.observe(late.worker());
    expect(late.posts()).toEqual([]);
    expect(late.updates().at(-1)).toContain("changes not landed · the request read as a question");
  });

  it("puts the offer on the end-of-session reply when both are due in the same look", async () => {
    const w = world({ threadCreatedAt: NOW });
    w.state.session = sessionWith("completed");
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "question")];
    w.state.passes = [passOf("tour", "completed")];
    w.state.tour = tourOf();
    await w.observe(w.worker());
    await w.observe(w.worker());

    expect(w.posts()).toHaveLength(1);
    const [reply] = w.posts();
    expect(reply?.text).toBe("Mend read the change");
    const text = blockText(reply ?? {});
    expect(text).toContain("**Summary**");
    expect(text).toContain(SLACK_ACTIONS.reviewChange);
    expect(text).toContain(SLACK_ACTIONS.landChange);
    expect(text).toContain("changes not landed · the request read as a question");
  });

  it("names nothing about landing once a channel's project is private", async () => {
    const w = world({ threadCreatedAt: NOW });
    w.state.project = new Project({ ...project, visibility: "private" });
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "question")];
    w.state.landings = [landingOf("l1", "pull-request", { pullRequest: 412 })];
    await w.observe(w.worker());
    expect(w.updates()).toEqual([PRIVATE_PROJECT_STATUS]);
    expect(w.posts()).toEqual([]);
  });
});

describe("what the reporter reads", () => {
  it("decides the opening message once it is said, and closes a turn on its last message", () => {
    expect(openingOf([])).toBeUndefined();
    expect(openingOf([item("p", 1, "plan", "1.", "in-progress")])).toBeUndefined();
    expect(openingOf([item("m", 1, "assistant-message", "hi")])?.kind).toBe("assistant-message");
    expect(
      closingOf([
        item("a", 1, "assistant-message", "first"),
        item("b", 1, "assistant-message", " "),
        item("c", 1, "plan", "plan"),
      ])?.text,
    ).toBe("first");
  });

  it("names a review once no pass is running, keyed by when the latest finished", () => {
    const since = minutesAgo(10);
    expect(reviewMoment(null, [passOf("read", "completed")], since)).toBeNull();
    expect(
      reviewMoment(change, [passOf("read", "completed"), passOf("suggest", "running")], since),
    ).toBeNull();
    // The tour is waited for too: the reply carries its summary.
    expect(
      reviewMoment(change, [passOf("suggest", "completed"), passOf("tour", "running")], since),
    ).toBeNull();
    expect(
      reviewMoment(
        change,
        [passOf("read", "completed", minutesAgo(1)), passOf("suggest", "completed")],
        since,
      ),
    ).toEqual({
      key: `review:chg-1:${NOW.getTime()}`,
      finishedAt: NOW,
      tourAt: null,
      drafted: true,
    });
    expect(
      reviewMoment(
        change,
        [passOf("tour", "completed", minutesAgo(2)), passOf("suggest", "failed")],
        since,
      ),
    ).toEqual({
      key: `review:chg-1:${minutesAgo(2).getTime()}`,
      finishedAt: minutesAgo(2),
      tourAt: minutesAgo(2),
      drafted: false,
    });
    // A failed pass adds nothing, and a pass from before the thread began is not this thread's.
    expect(reviewMoment(change, [passOf("tour", "failed")], since)).toBeNull();
    expect(reviewMoment(change, [passOf("read", "completed", minutesAgo(20))], since)).toBeNull();
  });
});

const answered = (at: Date): PreviewStatus => ({
  _tag: "Observed",
  service: "web",
  reachable: true,
  httpStatus: 200,
  observedAt: at,
});
/** The status message's last edit, whole. */
const lastEdit = (w: ReturnType<typeof world>) =>
  w.writes().findLast((call) => call.kind === "update");

describe("a worktree's previews in the thread (docs/adr/0017-live-preview.md)", () => {
  const APP_URL = PublicOrigin.make("https://app.mend.test");
  const PREVIEW = PreviewId.make("pv-web");
  const OPEN = "https://app.mend.test/preview-auth?preview=pv-web&path=%2F";
  const COMPLETED = statusWith("completed · observed");
  const web = (facts: ReadonlyArray<PreviewStatus>, openable = true): WorktreePreviews => ({
    _tag: "Shown",
    appUrl: APP_URL,
    previews: [{ id: PREVIEW, service: "web", facts, openable }],
    unprepared: null,
  });
  const opensOf = (w: ReturnType<typeof world>) => {
    const edit = lastEdit(w);
    return edit?.kind === "update"
      ? [...JSON.stringify(edit.input.blocks).matchAll(/"url":"([^"]+preview-auth[^"]+)"/gu)].map(
          ([, url]) => url,
        )
      : [];
  };
  const completedWith = () => {
    const w = world();
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.session = sessionWith("completed");
    return w;
  };

  const replyEdits = (w: ReturnType<typeof world>) =>
    w
      .writes()
      .flatMap((call) => (call.kind === "update" && call.input.ts !== STATUS ? [call.input] : []));
  const offeredReply = async () => {
    const w = world({ threadCreatedAt: NOW });
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "question")];
    const reporter = w.worker();
    await w.observe(reporter);
    return { w, reporter };
  };

  it("edits the latest turn's landing reply once when its preview answers, including follow-ups and a worker restart", async () => {
    const { w, reporter } = await offeredReply();
    expect(JSON.stringify(w.posts())).not.toContain("Open preview");
    w.state.previews = web([answered(NOW)]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(replyEdits(w)).toHaveLength(1);
    const edit = replyEdits(w)[0];
    expect(JSON.stringify(edit?.blocks)).toContain(OPEN);
    const button = edit?.blocks?.flatMap((block) =>
      block.type === "section" && block.accessory?.url === OPEN ? [block.accessory] : [],
    )[0];
    expect(button?.style).toBe("primary");
    expect(JSON.stringify(edit?.blocks)).toContain("Push and open pull request");
    expect(w.posts()).toHaveLength(1);
    await w.observe(w.worker());
    expect(replyEdits(w)).toHaveLength(1);
    w.state.turns = [
      decidedTurn(1, "question"),
      decidedTurn(2, "off", new Date(NOW.getTime() + 30_000)),
    ];
    w.state.previews = NO_PREVIEWS;
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(w.posts()).toHaveLength(2);
    w.state.previews = web([answered(NOW)]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(replyEdits(w).at(-1)?.ts).not.toBe(edit?.ts);
    expect(JSON.stringify(replyEdits(w).at(-1)?.blocks)).toContain(OPEN);
  });

  it("edits a combined review and landing reply without losing its summary or review link", async () => {
    const w = world({ threadCreatedAt: NOW });
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "question")];
    w.state.passes = [passOf("tour", "completed")];
    w.state.tour = tourOf();
    const reporter = w.worker();
    await w.observe(reporter);
    w.state.previews = web([answered(NOW)]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(w.worker());
    expect(w.posts()).toHaveLength(1);
    expect(replyEdits(w)).toHaveLength(1);
    const blocks = JSON.stringify(replyEdits(w)[0]?.blocks);
    expect(blocks).toContain("**Summary**");
    expect(blocks).toContain(SLACK_ACTIONS.reviewChange);
    expect(blocks).toContain(SLACK_ACTIONS.landChange);
    expect(blocks).toContain(OPEN);
  });

  it("retries a refused reply edit after Retry-After, across workers", async () => {
    const { w, reporter } = await offeredReply();
    w.state.previews = web([answered(NOW)]);
    w.slack.refuseUpdates(
      ...[1, 2].map(
        () =>
          new SlackApiError({
            method: "chat.update",
            code: "ratelimited",
            message: "rate limited",
            retryAfterSeconds: 3,
          }),
      ),
    );
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(replyEdits(w)).toHaveLength(0);
    expect(w.slack.refused).toHaveLength(2);
    await w.observe(w.worker());
    expect(w.slack.refused).toHaveLength(2);
    await w.advance(3_000);
    await w.observe(reporter);
    expect(replyEdits(w)).toHaveLength(1);
    await w.observe(reporter);
    expect(replyEdits(w)).toHaveLength(1);
  });

  it("sends no reply edit or button after a person's Stop", async () => {
    const { w, reporter } = await offeredReply();
    w.state.previews = web([
      { _tag: "Stopped", service: "web", by: { _tag: "Person", name: "Maria" } },
    ]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    await w.observe(reporter);
    expect(replyEdits(w)).toEqual([]);
    expect(JSON.stringify(w.posts())).not.toContain("Open preview");
  });

  it("removes a stopped explicit run's Open from both the status and the retained landing reply", async () => {
    const { w, reporter } = await offeredReply();
    w.state.previews = web([answered(NOW)]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(opensOf(w)).toContain(OPEN);
    expect(JSON.stringify(replyEdits(w).at(-1)?.blocks)).toContain(OPEN);
    w.state.previews = web([], false);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(opensOf(w)).toEqual([]);
    expect(JSON.stringify(replyEdits(w).at(-1)?.blocks)).not.toContain(OPEN);
  });

  it("keeps the reply's preview button after an idle stop and removes it after a person's Stop", async () => {
    const { w, reporter } = await offeredReply();
    w.state.previews = web([answered(NOW)]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    w.state.previews = web([
      { _tag: "Stopped", service: "web", by: { _tag: "Idle", minutes: 30 } },
    ]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(JSON.stringify(replyEdits(w).at(-1)?.blocks)).toContain(OPEN);
    w.state.previews = web([
      { _tag: "Stopped", service: "web", by: { _tag: "Person", name: "Maria" } },
    ]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    expect(JSON.stringify(replyEdits(w).at(-1)?.blocks)).not.toContain(OPEN);
  });

  it("does not change the status rendering when retaining a landing reply", async () => {
    const offered = await offeredReply();
    const ordinary = completedWith();
    ordinary.state.change = change;
    ordinary.state.turns = [decidedTurn(1, "question")];
    const reporter = ordinary.worker();
    for (const previews of [NO_PREVIEWS, web([answered(NOW)])]) {
      offered.w.state.previews = previews;
      ordinary.state.previews = previews;
      await offered.w.advance(STATUS_PREVIEW_EVERY_MS);
      await ordinary.advance(STATUS_PREVIEW_EVERY_MS);
      await offered.w.observe(offered.reporter);
      await ordinary.observe(reporter);
      const status = (w: ReturnType<typeof world>) =>
        w
          .writes()
          .flatMap((call) =>
            call.kind === "update" && call.input.ts === STATUS ? [call.input] : [],
          )
          .at(-1);
      expect(status(offered.w)).toEqual(status(ordinary));
    }
  });

  it("makes no chat.update for an unchanged reply rendering", async () => {
    const { w, reporter } = await offeredReply();
    w.state.previews = web([answered(NOW)]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await w.observe(reporter);
    const writes = w.writes().length;
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    w.state.previews = web([answered(new Date(NOW.getTime() + 20_000))]);
    await w.observe(w.worker());
    await w.observe(reporter);
    expect(w.writes()).toHaveLength(writes);
  });

  it("edits the status message once per move of the preview, and never for a repeated check", async () => {
    const w = completedWith();
    const reporter = w.worker();
    const settle = async () => {
      await w.observe(reporter);
      await w.advance(STATUS_PREVIEW_EVERY_MS);
    };
    w.state.previews = web([{ _tag: "Starting", service: "web", phase: "setup" }], false);
    await settle();
    w.state.previews = web([answered(NOW)]);
    await settle();
    // Readiness checks repeat: the observation's time moves, what it says does not.
    for (let check = 1; check <= 12; check++) {
      w.state.previews = web([answered(new Date(NOW.getTime() + check * 10_000))]);
      await settle();
    }
    w.state.previews = web([
      { _tag: "Stopped", service: "web", by: { _tag: "Person", name: "Maria" } },
    ]);
    await settle();
    w.state.previews = {
      _tag: "Shown",
      appUrl: APP_URL,
      previews: [],
      unprepared: {
        _tag: "NotPrepared",
        service: "web",
        why: { _tag: "Refused", words: "setup exited 1" },
      },
    };
    await settle();
    expect(w.updates()).toEqual([
      `${COMPLETED}\npreview · web · starting · setup`,
      `${COMPLETED}\npreview · web · answered HTTP 200 · observed`,
      `${COMPLETED}\npreview · web · stopped by Maria`,
      `${COMPLETED}\npreview not prepared · web · setup exited 1`,
    ]);
    expect(JSON.stringify(w.writes())).not.toMatch(/ticket/u);
  });

  it("edits once when only the Open button changes", async () => {
    const w = completedWith();
    const reporter = w.worker();
    const facts = [answered(NOW)];
    w.state.previews = web(facts, false);
    await w.observe(reporter);
    expect(opensOf(w)).toEqual([]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    w.state.previews = web(facts, true);
    await w.observe(reporter);
    await w.observe(reporter);
    expect(w.updates()).toHaveLength(2);
    expect(w.updates()[0]).toBe(w.updates()[1]);
    expect(opensOf(w)).toEqual([OPEN]);
  });

  it("holds a run of preview moves to one edit every 10 s, and lands on the latest", async () => {
    const w = completedWith();
    const reporter = w.worker();
    w.state.previews = web([{ _tag: "Starting", service: "web", phase: "setup" }], false);
    await w.observe(reporter);
    w.state.previews = web([{ _tag: "Starting", service: "web", phase: "depends" }], false);
    await w.observe(reporter);
    w.state.previews = web([answered(NOW)]);
    await w.observe(reporter);
    expect(w.updates()).toEqual([`${COMPLETED}\npreview · web · starting · setup`]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    expect(w.updates()).toEqual([
      `${COMPLETED}\npreview · web · starting · setup`,
      `${COMPLETED}\npreview · web · answered HTTP 200 · observed`,
    ]);
  });

  it("reads no preview for a private project's channel thread, and shows one in a direct message", async () => {
    const channel = completedWith();
    channel.state.project = new Project({ ...project, visibility: "private" });
    channel.state.previews = web([answered(NOW)]);
    await channel.observe(channel.worker());
    expect(channel.state.previewReads).toBe(0);
    expect(channel.updates()).toEqual([PRIVATE_PROJECT_STATUS]);
    expect(JSON.stringify(channel.writes())).not.toMatch(/preview/u);

    const direct = world({ channelId: "D-alice" });
    direct.state.turns = [turn(1, "completed", NOW)];
    direct.state.project = new Project({ ...project, visibility: "private" });
    direct.state.previews = web([answered(NOW)]);
    await direct.observe(direct.worker());
    expect(direct.updates()).toEqual([
      `${COMPLETED}\npreview · web · answered HTTP 200 · observed`,
    ]);
  });

  it("keeps previews out of a Slack Connect channel the owner did not open, and in a thread with agent messages off", async () => {
    const external = world({ external: true });
    external.state.turns = [turn(1, "completed", NOW)];
    external.state.previews = web([answered(NOW)]);
    await external.observe(external.worker());
    expect(external.state.previewReads).toBe(0);
    expect(external.updates()).toEqual([COMPLETED]);

    const opened = world({ external: true, settings: { externalChannels: true } });
    opened.state.turns = [turn(1, "completed", NOW)];
    opened.state.previews = web([answered(NOW)]);
    await opened.observe(opened.worker());
    expect(opened.updates()).toEqual([
      `${COMPLETED}\npreview · web · answered HTTP 200 · observed`,
    ]);

    const quiet = world({ settings: { showAgentMessages: false } });
    quiet.state.turns = [turn(1, "completed", NOW)];
    quiet.state.previews = web([answered(NOW)]);
    await quiet.observe(quiet.worker());
    expect(quiet.updates()).toEqual([`${COMPLETED}\npreview · web · answered HTTP 200 · observed`]);
  });

  it("holds a move of the previews alone to one edit every 10 s, across workers too", async () => {
    const w = completedWith();
    const first = w.worker();
    const second = w.worker();
    w.state.previews = web([{ _tag: "Starting", service: "web", phase: "setup" }], false);
    await w.observe(first);
    w.state.previews = web([{ _tag: "Starting", service: "web", phase: "depends" }], false);
    await w.observe(second);
    expect(w.updates()).toEqual([`${COMPLETED}\npreview · web · starting · setup`]);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await vi.waitFor(() =>
      expect(w.updates()).toEqual([
        `${COMPLETED}\npreview · web · starting · setup`,
        `${COMPLETED}\npreview · web · starting · depends`,
      ]),
    );
  });

  it("reads the change's counts when its own session moves, never for a look at its worktree's previews", async () => {
    const w = completedWith();
    w.state.change = change;
    const reports = w.reports();
    const ask = (target: SlackReportTarget) => Effect.runPromise(reports.request(target));
    await ask({ _tag: "Session", id: SESSION });
    await vi.waitFor(() => expect(w.updates()).toEqual([`${COMPLETED} · 2 files · +3 −1`]));
    expect(w.state.diffReads).toBe(1);

    w.state.previews = web([answered(NOW)]);
    await ask({ _tag: "SessionWorktree", id: SessionId.make("s-service") });
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    await ask({ _tag: "Worktree", id: WORKTREE });
    await vi.waitFor(() =>
      expect(w.updates().at(-1)).toBe(
        `${COMPLETED} · 2 files · +3 −1\npreview · web · answered HTTP 200 · observed`,
      ),
    );
    expect(w.state.diffReads).toBe(1);

    await ask({ _tag: "Session", id: SESSION });
    await vi.waitFor(() => expect(w.state.diffReads).toBe(2));
  });

  it("keeps a settled message's counts when its worktree can no longer be read", async () => {
    const w = completedWith();
    w.state.change = change;
    const reporter = w.worker();
    await w.observe(reporter);
    w.state.worktreeGone = true;
    await w.observe(reporter);
    expect(w.state.diffReads).toBe(2);
    expect(w.updates()).toEqual([`${COMPLETED} · 2 files · +3 −1`]);
  });

  it("looks at a project's threads again only when its visibility or name moved", async () => {
    const w = completedWith();
    const reports = w.reports();
    const ask = (target: SlackReportTarget) => Effect.runPromise(reports.request(target));
    await ask({ _tag: "Project", id: PROJECT });
    await vi.waitFor(() => expect(w.updates()).toEqual([COMPLETED]));
    const looks = w.state.threadReads;

    await ask({ _tag: "Project", id: PROJECT });
    await ask({ _tag: "Session", id: SESSION });
    await vi.waitFor(() => expect(w.state.threadReads).toBe(looks + 1));

    w.state.project = new Project({ ...project, name: "billing" });
    await ask({ _tag: "Project", id: PROJECT });
    await vi.waitFor(() =>
      expect(w.updates().at(-1)).toBe(
        "billing · from a link in the thread · claude · completed · observed · mend/flaky-login-test",
      ),
    );
    expect(w.state.threadReads).toBe(looks + 2);
  });

  it("asks again for a resync whose read of the active sessions failed", async () => {
    const w = world();
    w.state.turns = [turn(1, "running")];
    const reports = w.reports();
    w.state.listActiveFailuresLeft = 1;
    await Effect.runPromise(reports.request({ _tag: "Resync" }));
    await vi.waitFor(() => expect(w.state.listActiveFailuresLeft).toBe(0));
    await w.advance(REQUEST_RETRY_MS - 1);
    expect(w.updates()).toEqual([]);
    await w.advance(1);
    await vi.waitFor(() => expect(w.updates()).toEqual([statusWith("running")]));
  });

  it("removes the previews when the project turns private", async () => {
    const w = completedWith();
    const reporter = w.worker();
    w.state.previews = web([answered(NOW)]);
    await w.observe(reporter);
    w.state.project = new Project({ ...project, visibility: "private" });
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(PRIVATE_PROJECT_STATUS);
    expect(opensOf(w)).toEqual([]);
  });

  it("keeps the previews it showed when a read fails, while the status and the replies go on, and reads again backing off", async () => {
    const w = world({ threadCreatedAt: minutesAgo(1) });
    const reporter = w.worker();
    const RUNNING = statusWith("running");
    w.state.turns = [turn(1, "running")];
    w.state.previews = web([answered(NOW)]);
    await w.observe(reporter);
    expect(w.updates()).toEqual([`${RUNNING}\npreview · web · answered HTTP 200 · observed`]);

    w.state.previewReadsFail = 3;
    w.state.previews = web([{ _tag: "Starting", service: "web", phase: "setup" }]);
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.items = [item("m1", 1, "assistant-message", "Bounded the retry at three.")];
    const reads = w.state.previewReads;
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(`${COMPLETED}\npreview · web · answered HTTP 200 · observed`);
    expect(w.posts().map((post) => post.text)).toEqual(["Bounded the retry at three."]);

    const readAgainAfter = async (ms: number, times: number) => {
      await w.advance(ms - 1);
      expect(w.state.previewReads - reads).toBe(times - 1);
      await w.advance(1);
      await vi.waitFor(() => expect(w.state.previewReads - reads).toBe(times));
    };
    await readAgainAfter(5_000, 2);
    await readAgainAfter(10_000, 3);
    await readAgainAfter(20_000, 4);
    await vi.waitFor(() =>
      expect(w.updates().at(-1)).toBe(`${COMPLETED}\npreview · web · starting · setup`),
    );
  });

  it("shows a switched session stopped with its previews and landing, leaving the request's reaction to its replacement", async () => {
    const w = world();
    const reporter = w.worker();
    w.state.change = change;
    w.state.turns = [decidedTurn(1, "attempted")];
    w.state.landings = [landingOf("l1", "pull-request", { pullRequest: 412 })];
    w.state.previews = web([answered(NOW)]);
    await w.observe(reporter);
    await w.advance(STATUS_PREVIEW_EVERY_MS);
    // The runner stopped it for a switch, recorded the replacement, and asked for a report.
    w.state.requestReused = true;
    w.state.session = sessionWith("stopped");
    w.state.processes = [];
    w.state.turns = [decidedTurn(1, "attempted"), turn(2, "interrupted", NOW)];
    await w.observe(reporter);
    expect(w.updates().at(-1)).toBe(
      `${statusWith("stopped")} · 2 files · +3 −1\npushed · mend/flaky-login-test · pull request #412 · opened\npreview · web · answered HTTP 200 · observed`,
    );
    expect(opensOf(w)).toEqual([OPEN]);
    expect(w.reactions()).toEqual(new Set(["white_check_mark"]));
  });

  it("puts the previews on the end-of-session reply once, and edits only the status as they move", async () => {
    const w = world({ settings: { showAgentMessages: false }, threadCreatedAt: minutesAgo(1) });
    const reporter = w.worker();
    w.state.session = sessionWith("completed");
    w.state.turns = [turn(1, "completed", NOW)];
    w.state.change = change;
    // A tour ran but its summary is not shown, and nothing drafted: the preview is the reply.
    w.state.passes = [passOf("tour", "completed")];
    w.state.tour = tourOf();
    w.state.previews = web([answered(NOW)]);
    await w.observe(reporter);
    expect(w.posts()).toHaveLength(1);
    expect(w.posts()[0]?.text).toBe("preview · web · answered HTTP 200 · observed");
    expect(JSON.stringify(w.posts()[0]?.blocks)).toContain(OPEN);

    await w.advance(STATUS_PREVIEW_EVERY_MS);
    w.state.previews = web([
      { _tag: "Stopped", service: "web", by: { _tag: "Person", name: "Maria" } },
    ]);
    await w.observe(reporter);
    expect(w.posts()).toHaveLength(1);
    expect(w.updates().at(-1)).toBe(
      `${COMPLETED} · 2 files · +3 −1\npreview · web · stopped by Maria`,
    );
  });
});
