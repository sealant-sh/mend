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
  AgentTurn,
  Change,
  ChangeLanding,
  LANDING_GUARD,
  Project,
  Session,
  Worktree,
  type AgentTurnStatus,
  type AutomationChoice,
  type RequestIntent,
  type RequestIntentReading,
  type SessionOrigin,
  type TurnLanding,
} from "@mend/domain/workbench";
import { InferenceError, RequestIntentReader, type RequestIntentInput } from "@mend/inference";
import { Landing, type LandInput } from "@mend/landing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { WorktreeReads } from "@mend/sessions";
import {
  AgentBridge,
  type ChangedFile,
  makeSourcePolicy,
  MendKeys,
  SourcePolicy,
} from "@mend/store";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { makeAutomaticLanding } from "./automatic-landing.ts";

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
  audited: Array<NewAuditEvent>;
  changedFilesReads: number;
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
  audited: [],
  changedFilesReads: 0,
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
  } = {},
) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${ordinal}`),
    sessionId: SESSION,
    processId: SessionProcessId.make("process-1"),
    ordinal,
    author: overrides.author === undefined ? "alice" : overrides.author,
    input: overrides.input ?? "fix the flaky login test",
    status: overrides.status ?? "completed",
    providerTurnId: null,
    error: null,
    usage: null,
    intent: overrides.intent ?? null,
    intentSource: overrides.intentSource ?? null,
    createdAt: new Date(NOW.getTime() - 60_000),
    startedAt: new Date(NOW.getTime() - 60_000),
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
  Layer.mock(AgentConversationRepo, {
    listTurns: () => Effect.sync(() => [...world.turns]),
    hasPendingRequests: () => Effect.sync(() => world.pending),
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
    get: () =>
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
      Effect.sync(() => {
        world.lands.push(input);
        const row = landed(`landing-${world.lands.length}`, { createdAt: NOW });
        return { landing: row, pullRequest: { _tag: "off" as const } };
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
      const lander = yield* makeAutomaticLanding({ now: () => NOW.getTime() });
      for (let index = 0; index < times; index += 1) yield* lander.consider(SESSION);
    }).pipe(Effect.provide(layer)),
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

  it("says nothing for an empty change, and reads no intent for it", async () => {
    world.turns = [turn(0)];
    world.changed = new Map();
    await look();
    expect(world.lands).toEqual([]);
    expect(world.reads).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);
  });

  it("says nothing when nothing changed since the last landing", async () => {
    world.turns = [turn(0)];
    world.landings = [landed("landing-0")];
    world.changed = new Map([[BASE, [file("src/login.ts")]]]);
    await look();
    expect(world.lands).toEqual([]);
    expect(decisions()).toEqual([[0, "skipped"]]);

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
