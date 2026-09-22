import {
  AgentConversationRepo,
  ChangePassesRepo,
  ProjectsRepo,
  ReviewCommentsRepo,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import {
  AgentItemId,
  AgentRequestId,
  AgentTurnId,
  ChangeId,
  OrganizationId,
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
  Change,
  ChangePass,
  Project,
  ReviewComment,
  Session,
  SessionProcess,
  type AgentItemKind,
  type AgentRequestKind,
  type AgentTurnStatus,
  type SlackInstallSettings,
} from "@mend/domain/workbench";
import { WORKTREE_STAMP, WorktreeReads } from "@mend/sessions";
import { PRIVATE_PROJECT_STATUS, SLACK_ACTIONS, statusLine } from "@mend/slack";
import { makeFakeSlack, type FakeSlackCall } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { closingOf, makeSlackReporter, openingOf, reviewMoment } from "../src/slack-reporter.ts";

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
  autoSuggest: "inherit",
  backgroundSessions: "inherit",
  gitAuthMode: "ambient",
  workspaceImage: null,
  applyDotfiles: true,
  inheritUserSkills: true,
  hotSessions: 0,
  installCommand: null,
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
    comments: [] as ReadonlyArray<ReviewComment>,
    posted: new Set<string>(),
    project,
    /** The thread row is gone (its session deleted). */
    threadGone: false,
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

  const layer = Layer.mergeAll(
    slack.layer,
    Layer.mock(SlackThreadsRepo, {
      forSession: (id) =>
        Effect.sync(() => (id === SESSION && !state.threadGone ? state.thread : null)),
      claimStatus: (_id, from, to) =>
        Effect.sync(() => {
          if (state.thread.statusTs === null || state.thread.reportedStatus !== from) return false;
          state.thread = { ...state.thread, reportedState: to.state, reportedStatus: to.line };
          return true;
        }),
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
      listActive: () => Effect.sync(() => [state.session]),
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
    Layer.mock(ReviewCommentsRepo, { listForChange: () => Effect.sync(() => state.comments) }),
    Layer.mock(WorktreeReads, {
      changedFiles: () =>
        Effect.succeed({
          value: [
            { path: "src/login.ts", additions: 2, deletions: 1 },
            { path: "test/login.test.ts", additions: 1, deletions: 0 },
          ],
          stamp: WORKTREE_STAMP,
        }),
      diffWorktree: () => Effect.succeed({ value: DIFF, stamp: WORKTREE_STAMP }),
    }),
    Layer.succeed(SecretCipher, {
      encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
      decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
    }),
  );

  /** One worker process: its own memory of what it has seen, the shared database and Slack. */
  const worker = () =>
    Effect.runSync(makeSlackReporter({ now: () => state.now }).pipe(Effect.provide(layer)));
  const observe = (reporter: ReturnType<typeof worker>) =>
    Effect.runPromise(reporter.observe(SESSION).pipe(Effect.provide(layer)));
  const baseline = (reporter: ReturnType<typeof worker>) =>
    Effect.runPromise(reporter.baseline().pipe(Effect.provide(layer)));

  return {
    state,
    slack,
    worker,
    observe,
    baseline,
    writes,
    posts: () =>
      writes().flatMap((call: FakeSlackCall) => (call.kind === "postMessage" ? [call.input] : [])),
    updates: () =>
      writes().flatMap((call: FakeSlackCall) => (call.kind === "update" ? [call.input.text] : [])),
    reactions: () => slack.reactions.get(`${options.channelId ?? CHANNEL}:${REQUEST}`),
  };
};

const blockText = (post: { readonly blocks?: ReadonlyArray<unknown> }) => JSON.stringify(post);

describe("the Slack thread reporter", () => {
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

  it("never moves a failed launch back to starting, and writes nothing for a removed app", async () => {
    const w = world();
    w.state.thread = {
      ...w.state.thread,
      reportedState: "failed",
      reportedStatus: "billing-api · … · failed",
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
    const pass = (kind: "read" | "suggest" | "tour", status: "running" | "completed", at: Date) =>
      new ChangePass({
        changeId: CHANGE,
        kind,
        status,
        detail: null,
        findings: 0,
        startedAt: at,
        finishedAt: status === "completed" ? at : null,
      });
    const since = minutesAgo(10);
    expect(reviewMoment(null, [pass("read", "completed", NOW)], since)).toBeNull();
    expect(reviewMoment(change, [pass("tour", "completed", NOW)], since)).toBeNull();
    expect(
      reviewMoment(
        change,
        [pass("read", "completed", NOW), pass("suggest", "running", NOW)],
        since,
      ),
    ).toBeNull();
    expect(
      reviewMoment(
        change,
        [pass("read", "completed", minutesAgo(1)), pass("suggest", "completed", NOW)],
        since,
      ),
    ).toEqual({ key: `review:chg-1:${NOW.getTime()}`, finishedAt: NOW });
    // A pass over the worktree from before the thread began is not this thread's.
    expect(reviewMoment(change, [pass("read", "completed", minutesAgo(20))], since)).toBeNull();
  });
});
