import {
  AgentConversationRepo,
  AuditEventsRepo,
  ProjectsRepo,
  SessionNotFoundError,
  SessionsRepo,
  SlackInstallsRepo,
  SlackThreadsRepo,
  type NewAuditEvent,
} from "@mend/db";
import {
  AgentTurnId,
  ChangeId,
  ChangeLandingId,
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  ChangeLanding,
  Project,
  Session,
  type AgentTurnStatus,
} from "@mend/domain/workbench";
import { Landing, LandingNotStartedError, type LandInput } from "@mend/landing";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { WorkspaceGitHooks, WorkspaceGitHooksLive } from "@mend/sessions";
import { AgentBridge, makeSourcePolicy, MendKeys, SourcePolicy } from "@mend/store";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { OwnerLandingLive } from "./owner-landing.ts";
import { WorkspaceLandingLive } from "./workspace-landing.ts";

/**
 * `mend land` inside a workspace (docs/adr/0007-landing.md, "Surfaces"), from the engine's hook to
 * the landing: only the change's owner's request lands, as their own landing, audited; anything
 * else says why and lands nothing.
 */

const ACME = OrganizationId.make("org-acme");
const PROJECT = ProjectId.make("project-api");
const SESSION = SessionId.make("session-1");
const WORKTREE = WorktreeId.make("worktree-1");
const NOW = new Date("2026-09-27T12:00:00.000Z");
const APP_URL = "https://mend.acme.test";

interface World {
  sessionOwner: string | null;
  /** The worktree's first session, when a teammate's session joined it. */
  first: Session | null;
  turns: Array<AgentTurn>;
  lands: Array<LandInput>;
  refusal: LandingNotStartedError | null;
  audited: Array<NewAuditEvent>;
}

const blankWorld = (): World => ({
  sessionOwner: "alice",
  first: null,
  turns: [],
  lands: [],
  refusal: null,
  audited: [],
});

let world: World = blankWorld();

const session = () => makeSession(SESSION, PROJECT, WORKTREE, world.sessionOwner);

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
  });

const turn = (status: AgentTurnStatus, author: string | null) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${world.turns.length}`),
    sessionId: SESSION,
    processId: SessionProcessId.make("process-1"),
    ordinal: world.turns.length,
    author,
    input: "ok land it",
    status,
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  });

const pullRequest = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "open" as const,
  observedAt: NOW,
};

const layer = Layer.mergeAll(
  WorkspaceGitHooksLive,
  Layer.mock(SessionsRepo, {
    byId: (id) =>
      id === SESSION
        ? Effect.sync(session)
        : Effect.fail(new SessionNotFoundError({ sessionId: id })),
    listForWorktree: () =>
      Effect.sync(() => (world.first === null ? [session()] : [world.first, session()])),
  }),
  Layer.mock(ProjectsRepo, { byId: () => Effect.sync(project) }),
  Layer.mock(AgentConversationRepo, { listTurns: () => Effect.sync(() => [...world.turns]) }),
  Layer.mock(SlackThreadsRepo, { forSession: () => Effect.succeed(null) }),
  Layer.mock(SlackInstallsRepo, {}),
  Layer.mock(Landing, {
    land: (input) =>
      Effect.suspend(() => {
        world.lands.push(input);
        if (world.refusal !== null) return Effect.fail(world.refusal);
        return Effect.succeed({
          landing: new ChangeLanding({
            id: ChangeLandingId.make("landing-1"),
            changeId: ChangeId.make("change-1"),
            sessionId: SESSION,
            projectId: PROJECT,
            checkpointId: null,
            checkpointRef: null,
            checkpointSha: null,
            commitSha: null,
            remoteBranch: "mend/fix-login",
            pushedSha: Sha.make("3f2a1c0".padEnd(40, "0")),
            trigger: input.trigger,
            pullRequest,
            outcome: "pull-request",
            message: null,
            userId: "alice",
            createdAt: NOW,
          }),
          pullRequest: { _tag: "opened" as const, pullRequest },
        });
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
  Layer.succeed(
    SourcePolicy,
    makeSourcePolicy({ profile: "operator", allowedHosts: [], resolve: async () => [] }),
  ),
  Layer.mock(MendKeys, {}),
  Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
);

/** What the helper would hear: the engine's hook, after the worker registered its answer. */
const askToLand = (register = true) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const hooks = yield* WorkspaceGitHooks;
      return yield* hooks.landRequested(SESSION);
    }).pipe(
      Effect.provide(
        register
          ? WorkspaceLandingLive.pipe(
              Layer.provideMerge(OwnerLandingLive.pipe(Layer.provideMerge(layer))),
            )
          : layer,
      ),
    ),
  );

beforeEach(() => {
  world = blankWorld();
});

describe("mend land in a workspace (docs/adr/0007, Surfaces)", () => {
  it("lands the owner's request as their own landing, audits it, and prints what it observed", async () => {
    world.turns = [turn("running", "alice")];
    const outcome = await askToLand();
    expect(outcome).toEqual({
      landed: true,
      lines: [
        "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · open · observed",
        "https://github.com/acme/api/pull/412",
      ],
    });
    expect(world.lands).toEqual([
      expect.objectContaining({
        sessionId: SESSION,
        actorUserId: "alice",
        trigger: "manual",
        remoteBranch: null,
        pullRequest: true,
        webOrigin: APP_URL,
      }),
    ]);
    expect(world.audited).toEqual([
      expect.objectContaining({
        actorUserId: "alice",
        action: "change.landed",
        data: expect.objectContaining({ trigger: "manual", landingId: "landing-1" }),
      }),
    ]);
  });

  it("lands nothing for a turn someone else sent under shared control", async () => {
    world.turns = [turn("running", "bob")];
    expect(await askToLand()).toEqual({
      landed: false,
      lines: ["not landed · only the change's owner lands it · someone else sent this turn"],
    });
    expect(world.lands).toEqual([]);
  });

  it("lands nothing from a teammate's session in the owner's worktree", async () => {
    world.sessionOwner = "bob";
    world.first = new Session({
      ...makeSession(SessionId.make("session-0"), PROJECT, WORKTREE, "alice"),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    world.turns = [turn("running", "bob")];
    expect(await askToLand()).toEqual({
      landed: false,
      lines: ["not landed · only the change's owner lands it · this session is not theirs"],
    });
    expect(world.lands).toEqual([]);
  });

  it("says why a landing did not start, in the landing's words", async () => {
    world.turns = [turn("running", "alice")];
    world.refusal = new LandingNotStartedError({
      reason: "nothing-new",
      message: "landing not started · nothing new since the last landing",
    });
    expect(await askToLand()).toEqual({
      landed: false,
      lines: ["landing not started · nothing new since the last landing"],
    });
  });

  it("says so when nothing on the server answers it", async () => {
    expect(await askToLand(false)).toEqual({
      landed: false,
      lines: ["not landed · this Mend server does not land from a workspace"],
    });
  });
});
