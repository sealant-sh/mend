import {
  AgentConversationRepo,
  AuditEventsRepo,
  ChangeLandingsRepo,
  ProjectsRepo,
  SessionNotFoundError,
  SessionsRepo,
  SettingsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  WorktreeChangesRepo,
  WorktreesRepo,
  type NewAuditEvent,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import {
  AgentItemId,
  AgentTurnId,
  ChangeId,
  ChangeLandingId,
  CheckpointId,
  defaultSettings,
  MendSettings,
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentItem,
  AgentTurn,
  Change,
  ChangeLanding,
  LANDING_GUARD,
  Project,
  Session,
  Worktree,
  type AgentTurnOrigin,
  type AgentTurnStatus,
  type AutomationChoice,
  type RequestIntent,
  type RequestIntentReading,
  type SessionOrigin,
  type TurnLanding,
} from "@mend/domain/workbench";
import { InferenceError, RequestIntentReader, type RequestIntentInput } from "@mend/inference";
import { Landing, LandingNotStartedError, type LandInput } from "@mend/landing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import {
  type CaptureFlushObservation,
  type PullRequestOpenedEvent,
  SessionEngine,
  WorkspaceGitHooks,
  WorktreeReads,
} from "@mend/sessions";
import {
  AgentBridge,
  type ChangedFile,
  makeSourcePolicy,
  MendKeys,
  SourcePolicy,
} from "@mend/store";
import { Duration, Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { makeAutomaticLanding } from "./automatic-landing.ts";
import { OwnerLandingLive } from "./owner-landing.ts";

/**
 * Automatic landing (docs/adr/0007-landing.md, "Automatic landing") over in-memory repositories:
 * which ended turns land, which are recorded as not landed and why, which say nothing, and that
 * each turn is decided once however many times the worker looks.
 */

const ACME = OrganizationId.make("org-acme");
const PROJECT = ProjectId.make("project-api");
const SESSION = SessionId.make("session-1");
const WORKTREE = WorktreeId.make("worktree-1");
const CHANGE = ChangeId.make("change-1");
const BASE = Sha.make("b".repeat(40));
const LANDED_CHECKPOINT = Sha.make("c".repeat(40));
const NOW = new Date("2026-09-24T12:00:00.000Z");
const APP_URL = "https://mend.acme.test";

const file = (path: string): ChangedFile => ({ path, additions: 3, deletions: 1 });

/** What the fakes answer and what they were asked; reset before every test. */
interface World {
  turns: Array<AgentTurn>;
  origin: SessionOrigin;
  ownerUserId: string | null;
  /** Other sessions in the worktree, such as the one that started it. */
  siblings: Array<Session>;
  sessionAutoLand: boolean | null;
  projectAutoLand: AutomationChoice;
  settingsAutoLand: boolean;
  slackLands: boolean;
  pending: boolean;
  /** Files changed against a base, by base sha. */
  changed: Map<string, ReadonlyArray<ChangedFile>>;
  landings: Array<ChangeLanding>;
  intent: RequestIntent | InferenceError;
  claimed: Set<string>;
  reads: Array<RequestIntentInput>;
  intents: Array<{ readonly turnId: string; readonly reading: RequestIntentReading }>;
  lands: Array<LandInput>;
  /** Why the landing does not start, when it does not. */
  landRefusal: LandingNotStartedError | null;
  audited: Array<NewAuditEvent>;
  changedFilesReads: number;
  /** What each ask for a capture flush answers, in order; `flushed` once they run out. */
  flushes: Array<CaptureFlushObservation>;
  flushAsks: number;
  /** What each turn's agent said and did, by turn id. */
  items: Map<string, ReadonlyArray<AgentItem>>;
  opened: Array<PullRequestOpenedEvent>;
}

const blankWorld = (): World => ({
  turns: [],
  origin: "mend",
  ownerUserId: "alice",
  siblings: [],
  sessionAutoLand: null,
  projectAutoLand: "on",
  settingsAutoLand: false,
  slackLands: true,
  pending: false,
  changed: new Map([[BASE, [file("src/login.ts")]]]),
  landings: [],
  intent: "change",
  claimed: new Set(),
  reads: [],
  intents: [],
  lands: [],
  landRefusal: null,
  audited: [],
  changedFilesReads: 0,
  flushes: [],
  flushAsks: 0,
  items: new Map(),
  opened: [],
});

let world: World = blankWorld();

const turn = (
  ordinal: number,
  overrides: {
    readonly status?: AgentTurnStatus;
    readonly author?: string | null;
    readonly input?: string;
    readonly endedAt?: Date | null;
    readonly intent?: RequestIntent | null;
    readonly intentSource?: RequestIntentReading["source"] | null;
    readonly origin?: AgentTurnOrigin;
    readonly startedAt?: Date;
  } = {},
) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${ordinal}`),
    sessionId: SESSION,
    processId: SessionProcessId.make("process-1"),
    ordinal,
    author: overrides.author === undefined ? "alice" : overrides.author,
    origin: overrides.origin ?? "request",
    input: overrides.input ?? "fix the flaky login test",
    status: overrides.status ?? "completed",
    providerTurnId: null,
    error: null,
    usage: null,
    intent: overrides.intent ?? null,
    intentSource: overrides.intentSource ?? null,
    createdAt: new Date(NOW.getTime() - 60_000),
    startedAt: overrides.startedAt ?? new Date(NOW.getTime() - 60_000),
    endedAt: overrides.endedAt === undefined ? new Date(NOW.getTime() - 5_000) : overrides.endedAt,
  });

const project = () =>
  new Project({
    ...makeProject({
      id: PROJECT,
      organizationId: ACME,
      visibility: "shared",
      createdByUserId: "alice",
      storePath: "/store/project-api/repo.git",
    }),
    originUrl: "git@github.com:acme/api.git",
    gitAuthMode: "mend-key",
    autoLand: world.projectAutoLand,
  });

const session = () =>
  new Session({
    ...makeSession(SESSION, PROJECT, WORKTREE, world.ownerUserId),
    origin: world.origin,
    autoLand: world.sessionAutoLand,
  });

const worktree = new Worktree({
  id: WORKTREE,
  projectId: PROJECT,
  name: "fix-login",
  directory: "fix-login",
  branch: "mend/fix-login",
  baseSha: BASE,
  baseRef: "main",
  createdAt: NOW,
  updatedAt: NOW,
});

const change = new Change({
  id: CHANGE,
  projectId: PROJECT,
  worktreeId: WORKTREE,
  sessionId: SESSION,
  branch: "mend/fix-login",
  baseSha: BASE,
  headSha: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const landed = (id: string, overrides: Partial<ChangeLanding> = {}) =>
  new ChangeLanding({
    id: ChangeLandingId.make(id),
    changeId: CHANGE,
    sessionId: SESSION,
    projectId: PROJECT,
    checkpointId: CheckpointId.make("cp-3"),
    checkpointRef: "refs/mend/checkpoints/worktree-1/3",
    checkpointSha: LANDED_CHECKPOINT,
    commitSha: null,
    remoteBranch: "mend/fix-login",
    pushedSha: Sha.make("3f2a1c0".padEnd(40, "0")),
    trigger: "automatic",
    pullRequest: null,
    outcome: "pushed",
    message: null,
    userId: "alice",
    createdAt: NOW,
    ...overrides,
  });

const thread: SlackThreadSession = {
  sessionId: SESSION,
  teamId: "T-acme",
  channelId: "C-1",
  threadTs: "1.0",
  requestTs: "1.1",
  statusTs: "1.2",
  slackUserId: "U-alice",
  projectSource: "message",
  external: false,
  reportedState: null,
  reportedStatus: null,
  createdAt: NOW,
};

const install = (): SealedSlackInstall => ({
  organizationId: ACME,
  teamId: "T-acme",
  teamName: "Acme HQ",
  botUserId: "U-bot",
  appId: "A-acme",
  sealedAppToken: "sealed:xapp",
  sealedBotToken: "sealed:xoxb",
  webOrigin: "https://slack-origin.acme.test",
  settings: {
    defaultHarness: "claude",
    showAgentMessages: true,
    showDiffs: false,
    externalChannels: false,
    landAutomatically: world.slackLands,
  },
  installedByUserId: "alice",
  createdAt: NOW,
  updatedAt: NOW,
});

const replaceTurn = (id: AgentTurnId, update: (turn: AgentTurn) => AgentTurn) => {
  const index = world.turns.findIndex((candidate) => candidate.id === id);
  const current = world.turns[index];
  if (current === undefined) return null;
  const next = update(current);
  world.turns[index] = next;
  return next;
};

const layer = Layer.mergeAll(
  Layer.mock(WorkspaceGitHooks, {
    pullRequestOpened: (event) => Effect.sync(() => void world.opened.push(event)),
  }),
  Layer.mock(AgentConversationRepo, {
    listTurns: () => Effect.sync(() => [...world.turns]),
    hasPendingRequests: () => Effect.sync(() => world.pending),
    turnItems: (id) => Effect.sync(() => world.items.get(id) ?? []),
    claimTurnLanding: (id) =>
      Effect.sync(() => {
        const current = world.turns.find((candidate) => candidate.id === id);
        if (current === undefined || world.claimed.has(id)) return null;
        if (current.status === "queued" || current.status === "running") return null;
        world.claimed.add(id);
        return current;
      }),
    decideTurnLanding: (id, landing, landingId) =>
      Effect.suspend(() => {
        const next = replaceTurn(
          id,
          (current) => new AgentTurn({ ...current, landing, landingId }),
        );
        return next === null ? Effect.die("no such turn") : Effect.succeed(next);
      }),
    setTurnIntent: (id, reading) =>
      Effect.suspend(() => {
        world.intents.push({ turnId: id, reading });
        const next = replaceTurn(
          id,
          (current) =>
            new AgentTurn({ ...current, intent: reading.intent, intentSource: reading.source }),
        );
        return next === null ? Effect.die("no such turn") : Effect.succeed(next);
      }),
  }),
  Layer.mock(SessionsRepo, {
    byId: (id) =>
      id === SESSION
        ? Effect.sync(session)
        : Effect.fail(new SessionNotFoundError({ sessionId: id })),
    listActive: () => Effect.sync(() => [session()]),
    listForWorktree: () => Effect.sync(() => [session(), ...world.siblings]),
  }),
  Layer.mock(ProjectsRepo, { byId: () => Effect.sync(project) }),
  Layer.mock(SettingsRepo, {
    // What the project's organization resolves to: its own defaults over the instance's.
    forOrganization: () =>
      Effect.sync(() => new MendSettings({ ...defaultSettings, autoLand: world.settingsAutoLand })),
  }),
  Layer.mock(WorktreesRepo, { byId: () => Effect.succeed(worktree) }),
  Layer.mock(WorktreeChangesRepo, { byWorktree: () => Effect.succeed(change) }),
  Layer.mock(ChangeLandingsRepo, { listForChange: () => Effect.sync(() => world.landings) }),
  Layer.mock(SlackThreadsRepo, {
    forSession: () => Effect.sync(() => (world.origin === "slack" ? thread : null)),
  }),
  Layer.mock(SlackInstallsRepo, { byTeam: () => Effect.sync(install) }),
  Layer.mock(WorktreeReads, {
    changedFiles: (_project, _worktree, base) =>
      Effect.sync(() => {
        world.changedFilesReads += 1;
        return {
          value: world.changed.get(base) ?? [],
          stamp: {
            source: "worktree",
            captureN: null,
            captureId: null,
            seq: null,
            kind: null,
            partial: false,
            observedAt: null,
          },
        };
      }),
  }),
  Layer.mock(RequestIntentReader, {
    read: (input) =>
      Effect.suspend(() => {
        world.reads.push(input);
        const intent = world.intent;
        return intent instanceof InferenceError ? Effect.fail(intent) : Effect.succeed(intent);
      }),
  }),
  Layer.mock(Landing, {
    land: (input) =>
      Effect.suspend(() => {
        world.lands.push(input);
        if (world.landRefusal !== null) return Effect.fail(world.landRefusal);
        const row = landed(`landing-${world.lands.length}`, { createdAt: NOW });
        return Effect.succeed({ landing: row, pullRequest: { _tag: "off" as const } });
      }),
  }),
  Layer.mock(SessionEngine, {
    launchUnderWay: () => false,
    flushCaptures: () =>
      Effect.sync(() => {
        world.flushAsks += 1;
        return world.flushes.shift() ?? "flushed";
      }),
  }),
  Layer.succeed(
    NetworkConfig,
    makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)(APP_URL), []),
  ),
  Layer.mock(AuditEventsRepo, {
    record: (event) =>
      Effect.sync(() => {
        world.audited.push(event);
      }),
  }),
  Layer.mock(ProjectAccess, { isOperator: () => Effect.succeed(false) }),
  // The push env is resolved by the landing, which is faked here: these are never asked.
  Layer.succeed(
    SourcePolicy,
    makeSourcePolicy({ profile: "operator", allowedHosts: [], resolve: async () => [] }),
  ),
  Layer.mock(MendKeys, {}),
  Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
);

/** Look at the session the way the worker does after an event, `times` times. */
const look = (times = 1) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const lander = yield* makeAutomaticLanding({
        now: () => NOW.getTime(),
        flushPause: Duration.zero,
      });
      for (let index = 0; index < times; index += 1) yield* lander.consider(SESSION);
    }).pipe(Effect.provide(OwnerLandingLive.pipe(Layer.provideMerge(layer)))),
  );

const decisions = (): ReadonlyArray<[number, TurnLanding | null]> =>
  world.turns.map((candidate) => [candidate.ordinal, candidate.landing]);

beforeEach(() => {
  world = blankWorld();
});

describe("automatic landing (docs/adr/0007, When a completed turn lands)", () => {
  it("lands the owner's completed change as the owner, audits it, and records it on the turn", async () => {
    world.turns = [turn(0, { input: `fix the flaky login test\n\n${LANDING_GUARD}` })];

    await look();

    expect(world.lands).toHaveLength(1);
    expect(world.lands[0]).toMatchObject({
      sessionId: SESSION,
      actorUserId: "alice",
      trigger: "automatic",
      remoteBranch: null,
      pullRequest: true,
      title: null,
      body: null,
      webOrigin: APP_URL,
    });
    // The reading sees what the requester wrote, not the guard Mend added.
    expect(world.reads).toEqual([{ request: "fix the flaky login test", context: [] }]);
    expect(world.intents).toEqual([
      { turnId: "turn-0", reading: { intent: "change", source: "read" } },
    ]);
    expect(world.audited).toEqual([
      expect.objectContaining({
        organizationId: ACME,
        actorUserId: "alice",
        action: "change.landed",
        subjectType: "change",
        subjectId: CHANGE,
        data: expect.objectContaining({ trigger: "automatic", landingId: "landing-1" }),
      }),
    ]);
    expect(world.turns[0]).toMatchObject({ landing: "attempted", landingId: "landing-1" });
  });

  it("decides a turn the agent opened itself by the request that started the work", async () => {
    // The owner asked for a change; the agent started a workflow and ended the turn. When the
    // workflow finished, the agent opened a turn of its own to report it.
    const harness = (intent: RequestIntent) => [
      turn(0, { intent, intentSource: "read" }),
      turn(1, {
        origin: "harness",
        author: null,
        input: 'Dynamic workflow "fix" completed',
        startedAt: new Date(NOW.getTime() - 30_000),
      }),
    ];
    world.turns = harness("change");
    await look();
    expect(world.lands).toHaveLength(1);
    expect(world.lands[0]).toMatchObject({ actorUserId: "alice", trigger: "automatic" });
    // The request's recorded intent decides; nothing reads the agent's own turn.
    expect(world.reads).toEqual([]);
    expect(world.turns[1]).toMatchObject({ landing: "attempted" });

    world = blankWorld();
    world.turns = harness("question");
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toContainEqual([1, "question"]);
  });

  it("decides each turn once, however often it is looked at", async () => {
    world.turns = [turn(0)];
    await look(3);
    expect(world.lands).toHaveLength(1);
    expect(world.reads).toHaveLength(1);
  });

  it("does not land a request that read as a question, and says so", async () => {
    world.turns = [turn(0, { input: "why does the login test flake?" })];
    world.intent = "question";

    await look();

    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "question"]]);
    expect(world.intents).toEqual([
      { turnId: "turn-0", reading: { intent: "question", source: "read" } },
    ]);
  });

  it("treats a request whose intent could not be read as a change, and records it unread", async () => {
    world.turns = [turn(0)];
    world.intent = new InferenceError({ message: "no connected account", cause: null });

    await look();

    expect(world.lands).toHaveLength(1);
    expect(world.intents).toEqual([
      { turnId: "turn-0", reading: { intent: null, source: "unread" } },
    ]);
    expect(decisions()).toEqual([[0, "attempted"]]);
  });

  it("uses an intent read before the turn ended, without another call", async () => {
    world.turns = [turn(0, { intent: "question", intentSource: "option" })];
    await look();
    expect(world.reads).toEqual([]);
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "option"]]);
  });

  it("reads a follow-up with the earlier requests as context, and lands it after a question", async () => {
    world.turns = [
      new AgentTurn({
        ...turn(0, { input: `why does the login test flake?\n\n${LANDING_GUARD}` }),
        intent: "question",
        intentSource: "read",
        landing: "question",
      }),
      turn(1, { input: "go ahead and fix it" }),
    ];
    world.claimed.add("turn-0");

    await look();

    expect(world.reads).toEqual([
      {
        request: "go ahead and fix it",
        context: [{ author: "the owner", text: "why does the login test flake?" }],
      },
    ]);
    expect(decisions()).toEqual([
      [0, "question"],
      [1, "attempted"],
    ]);
  });

  it("does not land a follow-up someone else sent under shared control", async () => {
    world.turns = [turn(0), turn(1, { author: "bob" })];
    world.claimed.add("turn-0");
    world.turns[0] = new AgentTurn({ ...(world.turns[0] ?? turn(0)), landing: "attempted" });

    await look();

    expect(world.lands).toEqual([]);
    expect(world.reads).toEqual([]);
    expect(decisions()).toEqual([
      [0, "attempted"],
      [1, "not-owner"],
    ]);
  });

  it("does not land a turn with no recorded sender, even the opening one", async () => {
    world.turns = [turn(0, { author: null })];
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "not-owner"]]);
  });

  it("does not land a turn in a session a teammate started in the owner's worktree", async () => {
    // Bob's session joined Alice's worktree; the change is hers, so Bob's turns never land it.
    world.ownerUserId = "bob";
    world.siblings = [
      new Session({
        ...makeSession(SessionId.make("session-0"), PROJECT, WORKTREE, "alice"),
        // Before Bob's (the harness stamps sessions 2026-09-17).
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ];
    world.turns = [turn(0, { author: "bob" })];
    await look();
    expect(world.lands).toEqual([]);
    expect(world.reads).toEqual([]);
    expect(decisions()).toEqual([[0, "not-owner"]]);

    // Alice steering Bob's session under shared control does not land it either.
    world.claimed = new Set();
    world.turns = [turn(0, { author: "alice" })];
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "not-owner"]]);
  });

  it.each<AgentTurnStatus>(["failed", "interrupted", "cancelled"])(
    "never lands a %s turn",
    async (status) => {
      world.turns = [turn(0, { status })];
      await look();
      expect(world.lands).toEqual([]);
      expect(decisions()).toEqual([[0, "skipped"]]);
    },
  );

  it("leaves a turn that is still running undecided", async () => {
    world.turns = [turn(0, { status: "running", endedAt: null })];
    await look();
    expect(decisions()).toEqual([[0, null]]);
  });

  it("says nothing while the agent waits on the owner", async () => {
    world.turns = [turn(0)];
    world.pending = true;
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });

  it("lets the latest of two ended turns decide", async () => {
    world.turns = [turn(0), turn(1)];
    await look();
    expect(world.lands).toHaveLength(1);
    expect(decisions()).toEqual([
      [0, "skipped"],
      [1, "attempted"],
    ]);
  });

  it("says the change is empty when a change was asked for, and nothing after a question", async () => {
    world.turns = [turn(0)];
    world.changed = new Map();
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "no-change"]]);

    world = { ...blankWorld(), changed: new Map(), intent: "question" };
    world.turns = [turn(0, { input: "why does the login test flake?" })];
    await look();
    expect(world.reads).toHaveLength(1);
    // A question reads the change as it is: it waits on no flush.
    expect(world.flushAsks).toBe(0);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });

  it("says nothing new since the last landing when a change turn added nothing", async () => {
    world.turns = [turn(0)];
    // Landed before the turn started.
    world.landings = [landed("landing-0", { createdAt: new Date(NOW.getTime() - 120_000) })];
    world.changed = new Map([[BASE, [file("src/login.ts")]]]);
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "nothing-new"]]);

    // Work since the landed checkpoint lands again.
    world.turns = [turn(1)];
    world.changed = new Map([
      [BASE, [file("src/login.ts")]],
      [LANDED_CHECKPOINT, [file("src/session.ts")]],
    ]);
    await look();
    expect(world.lands).toHaveLength(1);
  });

  it("with landing off, reads nothing for a session run from the web", async () => {
    world.turns = [turn(0)];
    world.projectAutoLand = "inherit";
    await look();
    expect(world.lands).toEqual([]);
    expect(world.changedFilesReads).toBe(0);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });

  it("lands a web session its own override turned on, and not one turned off", async () => {
    world.projectAutoLand = "inherit";
    world.sessionAutoLand = true;
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toHaveLength(1);

    world = { ...blankWorld(), settingsAutoLand: true, projectAutoLand: "inherit" };
    world.sessionAutoLand = false;
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toEqual([]);
  });

  it("lets the project's off win over everything, Slack included", async () => {
    world.projectAutoLand = "off";
    world.sessionAutoLand = true;
    world.origin = "slack";
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toEqual([]);
    // Slack's thread hears why, so it can offer the button.
    expect(decisions()).toEqual([[0, "off"]]);
  });

  it("lands a Slack session by default, with the install's links", async () => {
    world.projectAutoLand = "inherit";
    world.origin = "slack";
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toHaveLength(1);
    expect(world.lands[0]?.webOrigin).toBe("https://slack-origin.acme.test");
  });

  it("records a Slack session whose install lands nothing as not landed, off", async () => {
    world.projectAutoLand = "inherit";
    world.origin = "slack";
    world.slackLands = false;
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "off"]]);
  });

  it("never lands a turn that ended long ago", async () => {
    world.turns = [turn(0, { endedAt: new Date(NOW.getTime() - 60 * 60_000) })];
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });

  it("has nobody to land as for a session with no owner", async () => {
    world.ownerUserId = null;
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });
});

describe("automatic landing waits for the captures (docs/adr/0007, amended 2026-09-27)", () => {
  it("asks the executor to flush before it reads the change, and lands once it caught up", async () => {
    world.turns = [turn(0)];
    world.flushes = ["incomplete"];
    await look();
    expect(world.flushAsks).toBe(2);
    expect(world.lands).toHaveLength(1);
    expect(decisions()).toEqual([[0, "attempted"]]);
  });

  it("neither lands nor calls the change empty while the captures never catch up", async () => {
    // The alpha run: the edits were never registered, so the head read `0 files · +0 −0`.
    world.origin = "slack";
    world.projectAutoLand = "inherit";
    world.changed = new Map();
    world.flushes = ["incomplete", "incomplete", "incomplete"];
    world.turns = [
      turn(0, {
        input: "Can you take a look and sort it out",
        intent: "change",
        intentSource: "read",
      }),
    ];
    await look();
    expect(world.flushAsks).toBe(3);
    expect(world.changedFilesReads).toBe(0);
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "not-captured"]]);
  });

  it("reads nothing as stale where nothing holds the worktree", async () => {
    world.turns = [turn(0)];
    world.flushes = ["none"];
    await look();
    expect(world.flushAsks).toBe(1);
    expect(world.lands).toHaveLength(1);
  });
});

describe("a request to land (docs/adr/0007, amended 2026-09-27)", () => {
  const afterALanding = () => {
    // Turn 0 landed; the follow-up changed nothing of its own.
    world.landings = [landed("landing-0", { createdAt: new Date(NOW.getTime() - 120_000) })];
    world.turns = [
      new AgentTurn({
        ...turn(0, { endedAt: new Date(NOW.getTime() - 120_000) }),
        intent: "change",
        intentSource: "read",
        landing: "attempted",
      }),
      turn(1, { input: "ok land it" }),
    ];
    world.claimed.add("turn-0");
  };

  it("lands a follow-up that read as land for the owner, as their own landing", async () => {
    afterALanding();
    world.intent = "land";
    await look();
    expect(world.reads).toEqual([
      {
        request: "ok land it",
        context: [{ author: "the owner", text: "fix the flaky login test" }],
      },
    ]);
    // Nothing is new since the landing, and it lands anyway: the landing knows what is left.
    expect(world.lands).toEqual([
      expect.objectContaining({ trigger: "manual", actorUserId: "alice" }),
    ]);
    expect(decisions()).toEqual([
      [0, "attempted"],
      [1, "attempted"],
    ]);
  });

  it("says nothing new since the last landing when the landing finds nothing to push", async () => {
    afterALanding();
    world.intent = "land";
    world.landRefusal = new LandingNotStartedError({
      reason: "nothing-new",
      message: "landing not started · nothing new since the last landing",
    });
    await look();
    expect(decisions()).toEqual([
      [0, "attempted"],
      [1, "nothing-new"],
    ]);
  });

  it("says nothing more for a change turn whose agent already ran `mend land`", async () => {
    world.turns = [turn(0)];
    world.landings = [landed("landing-0", { createdAt: NOW })];
    world.changed = new Map([[BASE, [file("src/login.ts")]]]);
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });

  it("says nothing more when `mend land` already landed during the turn", async () => {
    afterALanding();
    world.intent = "land";
    world.landings = [landed("landing-1", { createdAt: NOW }), ...world.landings];
    world.landRefusal = new LandingNotStartedError({
      reason: "nothing-new",
      message: "landing not started · nothing new since the last landing",
    });
    await look();
    expect(decisions()).toEqual([
      [0, "attempted"],
      [1, "skipped"],
    ]);
  });

  it("lands a Slack request to land even with automatic landing off", async () => {
    world.origin = "slack";
    world.slackLands = false;
    world.projectAutoLand = "inherit";
    world.turns = [turn(0, { input: "open a PR for this" })];
    world.intent = "land";
    await look();
    expect(world.lands).toEqual([expect.objectContaining({ trigger: "manual" })]);

    // The same thread, a change request: automatic landing is off, and the thread hears it.
    world = { ...blankWorld(), origin: "slack", slackLands: false, projectAutoLand: "inherit" };
    world.turns = [turn(0)];
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "off"]]);
  });

  it("keeps a question about a landing a question", async () => {
    world.turns = [turn(0, { input: "did you open a pr ?" })];
    world.intent = "question";
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "question"]]);
  });

  it("does not land a request to land that someone else sent", async () => {
    world.turns = [turn(0, { author: "bob", input: "land it" })];
    world.intent = "land";
    await look();
    expect(world.lands).toEqual([]);
    expect(world.reads).toEqual([]);
    expect(decisions()).toEqual([[0, "not-owner"]]);
  });

  it("says the change is empty when a request to land finds nothing", async () => {
    world.turns = [turn(0, { input: "ship it" })];
    world.intent = "land";
    world.changed = new Map();
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "no-change"]]);
  });

  it("with landing off, reads nothing for a web session, even a request to land", async () => {
    // The agent's `mend land` answers there; the turn itself says nothing.
    world.projectAutoLand = "inherit";
    world.turns = [turn(0, { input: "land it" })];
    world.intent = "land";
    await look();
    expect(world.reads).toEqual([]);
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });
});

describe("a turn that ran gh pr create (docs/adr/0007, pull requests opened outside Mend)", () => {
  const item = (
    turnId: string,
    index: number,
    kind: AgentItem["kind"],
    fields: { readonly title?: string; readonly text?: string; readonly data?: unknown },
  ) =>
    new AgentItem({
      id: AgentItemId.make(`${turnId}-item-${index}`),
      sessionId: SESSION,
      processId: SessionProcessId.make("process-1"),
      turnId: AgentTurnId.make(turnId),
      seq: index,
      providerItemId: `provider-${index}`,
      kind,
      status: "completed",
      title: fields.title ?? null,
      text: fields.text ?? null,
      data: fields.data ?? null,
      createdAt: NOW,
      updatedAt: NOW,
    });

  it("has the pull request looked for when the turn ends, landing on or off", async () => {
    world.projectAutoLand = "inherit";
    world.turns = [turn(0, { input: "open a pull request for this" })];
    world.items.set("turn-0", [
      item("turn-0", 0, "command-execution", {
        title: "Bash",
        data: { input: { command: "gh pr create --fill" } },
      }),
      item("turn-0", 1, "assistant-message", {
        text: "Opened https://github.com/acme/api/pull/413.",
      }),
    ]);
    await look();
    expect(world.opened).toEqual([
      {
        sessionId: SESSION,
        worktreeId: WORKTREE,
        urls: ["https://github.com/acme/api/pull/413"],
        since: world.turns[0]?.startedAt ?? world.turns[0]?.createdAt,
      },
    ]);
  });

  it("looks for nothing when no command ran gh pr create, or the turn is history", async () => {
    world.turns = [turn(0)];
    world.items.set("turn-0", [
      item("turn-0", 0, "assistant-message", { text: "See https://github.com/acme/api/pull/400." }),
    ]);
    await look();
    expect(world.opened).toEqual([]);

    world = blankWorld();
    world.turns = [turn(0, { endedAt: new Date(NOW.getTime() - 60 * 60_000) })];
    world.items.set("turn-0", [
      item("turn-0", 0, "command-execution", {
        title: "gh pr create --fill",
        text: "https://github.com/acme/api/pull/413",
      }),
    ]);
    await look();
    expect(world.opened).toEqual([]);
  });
});
