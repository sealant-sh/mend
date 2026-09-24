import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  BudgetExceeded,
  ConnectedAccount,
  NotFound,
  SessionNotSteerable,
  StoreFailure,
  type LaunchRequest,
} from "@mend/api-contracts";
import {
  AgentConversationRepo,
  AuditEventsRepo,
  SessionControlEventsRepo,
  SessionNotFoundError,
  SessionProcessesRepo,
  SessionsRepo,
  SlackDefaultsRepo,
  SlackEventClaimsRepo,
  SlackInstallsRepo,
  SlackLinksRepo,
  SlackThreadsRepo,
  type NewAuditEvent,
  type SealedSlackInstall,
  type SlackLink,
  type SlackOwnedSession,
  type SlackThreadSession,
} from "@mend/db";
import {
  AgentRequestId,
  AgentTurnId,
  ChangeId,
  ChangeLandingId,
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentRequest,
  AgentTurn,
  ChangeLanding,
  Project,
  Session,
  SessionProcess,
  type AgentInputQuestion,
  type AgentTurnStatus,
  type RequestIntentReading,
  type SessionStatus,
  type SlackLinkedMentionJob,
  type SlackPendingMention,
} from "@mend/domain/workbench";
import {
  InferenceError,
  InferenceProvider,
  ThreadProjectReaderLive,
  type InferenceRequest,
} from "@mend/inference";
import { LandingNotStartedError } from "@mend/landing";
import { SealantClients, SealantPrincipal } from "@mend/sealant";
import { ProtocolHostNotLiveError, SessionEngine } from "@mend/sessions";
import {
  channelDefaultActionId,
  channelSettingsBlockId,
  projectPickerBlockId,
  SLACK_ACTIONS,
  type SlackThreadFile,
  type SlackThreadMessage,
} from "@mend/slack";
import { makeFakeSlack, type FakeSlackWorkspace } from "@mend/slack/client";
import type { SlackEnvelope } from "@mend/slack/socket";
import { harnessHomePathOf, SecretCipher, Store } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { OwnerLanding, type OwnerLandingInput } from "./owner-landing.ts";
import { SessionStart, type CreateSessionInput } from "./session-start.ts";
import { SessionSteering } from "./session-steering.ts";
import {
  chooseProject,
  followUpWhenNotLive,
  intentOfRequest,
  makeSlackRunner,
  mentionOf,
  ownerOnly,
  parsePickerRequestKey,
  pickerRequestKey,
  type SlackRunner,
} from "./slack-runner.ts";

const ACME = OrganizationId.make("org-acme");
const NOW = new Date("2026-09-23T10:00:00.000Z");

const project = (
  id: string,
  name: string,
  visibility: "private" | "shared",
  originUrl: string | null,
) =>
  new Project({
    ...makeProject({
      id: ProjectId.make(id),
      organizationId: ACME,
      visibility,
      createdByUserId: "alice",
      storePath: `/store/${id}`,
    }),
    name,
    originUrl,
  });

const billing = project(
  "p-billing",
  "billing-api",
  "shared",
  "git@github.com:acme/billing-api.git",
);
const web = project("p-web", "web", "shared", "https://github.com/acme/web.git");
const notes = project("p-notes", "notes", "private", "https://github.com/alice/notes");

const install: SealedSlackInstall = {
  organizationId: ACME,
  teamId: "T-acme",
  teamName: "Acme HQ",
  botUserId: "U-bot",
  appId: "A-acme",
  sealedAppToken: "sealed:xapp-acme",
  sealedBotToken: "sealed:xoxb-acme",
  webOrigin: "https://mend.acme.test",
  settings: {
    defaultHarness: "claude",
    showAgentMessages: true,
    showDiffs: false,
    externalChannels: false,
    landAutomatically: true,
  },
  installedByUserId: "alice",
  createdAt: NOW,
  updatedAt: NOW,
};

const person = (id: string, displayName: string) => ({
  id,
  teamId: "T-acme",
  name: displayName.toLowerCase(),
  displayName,
  realName: null,
  isBot: false,
  deleted: false,
});

const message = (ts: string, userId: string | null, text: string): SlackThreadMessage => ({
  ts,
  userId,
  teamId: userId === null ? null : "T-acme",
  isBot: userId === null,
  displayName: null,
  text,
  files: [],
});

/** A thread about billing-api: its pull request is linked, then Alice mentions Mend. */
const THREAD = "1700000100.000100";
const MENTION = "1700000100.000300";
const threads: Record<string, ReadonlyArray<SlackThreadMessage>> = {
  [`C-general:${THREAD}`]: [
    message(THREAD, "U-bob", "login test flakes on CI"),
    message(
      "1700000100.000200",
      "U-bob",
      "started in <https://github.com/acme/billing-api/pull/42|#42>",
    ),
    message(MENTION, "U-alice", "<@U-bot> fix the flaky login test effort=high"),
  ],
  ["C-general:1700000200.000100"]: [
    message("1700000200.000100", "U-bob", "anyone seen the retry storm?"),
    message("1700000200.000200", "U-alice", "<@U-bot> look into it"),
  ],
  ["C-general:1700000300.000100"]: [message("1700000300.000100", "U-alice", "<@U-bot> tidy up")],
};

const slackWorkspace: FakeSlackWorkspace = {
  teamId: "T-acme",
  teamName: "Acme HQ",
  appId: "A-acme",
  botId: "B-acme",
  botUserId: "U-bot",
  botToken: "xoxb-acme",
  appToken: "xapp-acme",
  users: [person("U-alice", "Alice"), person("U-bob", "Bob"), person("U-bot", "Mend")],
  threads,
};

const account = (provider: "claude" | "codex", status: "active" | "invalid" = "active") =>
  new ConnectedAccount({
    id: `acct-${provider}`,
    provider,
    name: "default",
    kind: "oauth-token",
    status,
    metadata: {},
    connectedAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
  });

interface WorldOptions {
  readonly eventsPerMinute?: number;
  readonly now?: number;
  readonly createFails?: NotFound | StoreFailure | BudgetExceeded;
  /** The first create `createFails` refuses, counting from 1; the ones before it succeed. */
  readonly createFailsFrom?: number;
  /** The engine cannot stop a session. */
  readonly stopFails?: boolean;
  /** SessionStart dies: a failure nothing expected. */
  readonly createDies?: boolean;
  /** Alice has unlinked since. */
  readonly unlinked?: boolean;
  readonly launchFails?: StoreFailure;
  readonly accounts?: ReadonlyArray<ConnectedAccount>;
  readonly channelDefault?: ProjectId;
  /** Who set the channel default; Alice unless said. */
  readonly channelDefaultSetBy?: string;
  readonly personalDefault?: ProjectId;
  /** The thread's latest session, `session-earlier`. */
  readonly threadSession?: {
    readonly threadTs: string;
    readonly projectId: ProjectId;
    /** Its owner; Bob unless said. */
    readonly owner?: string;
    readonly status?: SessionStatus;
    /** Whether a protocol process of it takes turns here; true unless said. */
    readonly live?: boolean;
    /** Its latest agent process: by default a protocol one that exited with a provider id. */
    readonly agent?: "resumable" | "no-provider-id" | "live-terminal" | "none";
    /** A pending user-input request the agent made. */
    readonly questions?: ReadonlyArray<AgentInputQuestion>;
    /** The owner lets others steer it. */
    readonly sharedControl?: boolean;
  };
  /** Bob is linked too, and sees the shared projects. */
  readonly bobLinked?: boolean;
  /** What `@mend list` finds for Alice, newest first. */
  readonly owned?: ReadonlyArray<SlackOwnedSession>;
  /** The reporter moved the status message before the launch returned. */
  readonly reporterMovedFirst?: boolean;
  /**
   * What the inference provider answers for the thread's project, one per call; a call past the
   * end fails. Nothing given: no inference is expected.
   */
  readonly inference?: ReadonlyArray<unknown>;
  readonly inferencesPerHour?: number;
  /** The turns every session has, for "Switch project". */
  readonly turns?: ReadonlyArray<AgentTurnStatus>;
  /** Where the projects' stores are, so pasted images can be written; `/store` unless said. */
  readonly storeRoot?: string;
  /** More threads for the fake Slack, and the bytes of the files in them, by URL. */
  readonly threads?: Readonly<Record<string, ReadonlyArray<SlackThreadMessage>>>;
  readonly files?: Readonly<Record<string, Uint8Array>>;
  /** The landing "Push and open pull request" starts refuses to start. */
  readonly landRefused?: LandingNotStartedError;
}

const EARLIER = SessionId.make("session-earlier");

const agentTurn = (sessionId: SessionId, status: AgentTurnStatus, ordinal: number) =>
  new AgentTurn({
    id: AgentTurnId.make(`turn-${ordinal}`),
    sessionId,
    processId: SessionProcessId.make("agent-1"),
    ordinal,
    author: "alice",
    input: "tidy up",
    status,
    providerTurnId: null,
    error: null,
    usage: null,
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
  });

const agentProcess = (
  sessionId: SessionId,
  kind: "agent-protocol" | "agent-pty",
  providerSessionId: string | null,
  live: boolean,
) =>
  new SessionProcess({
    id: SessionProcessId.make("agent-1"),
    sessionId,
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
    sealantSessionId: "platform-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: "claude",
    providerSessionId,
    protocolOptions: null,
    label: "claude",
    argv: ["claude"],
    status: live ? "running" : "stopped",
    exitCode: live ? null : 0,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: NOW,
    exitedAt: live ? null : NOW,
    updatedAt: NOW,
  });

/** A thread that names no repository: only inference can tell which project it is about. */
const RETRY_THREAD = "1700000200.000100";
const RETRY_MENTION = "1700000200.000200";

const inferred = (
  projectId: string | null,
  likeliest: ReadonlyArray<string> = [],
  options = {},
) => ({
  projectId,
  likeliest,
  options: { harness: null, model: null, effort: null, branch: null, ...options },
});

/**
 * A runner over fakes: Slack is the in-memory fake, the repositories are maps, and SessionStart
 * records what it was asked. `effects` holds acks, claims and starts in order; Slack's writes are
 * in `slack.calls`. Alice is linked and sees every project; Bob is not linked.
 */
const world = (options: WorldOptions = {}) => {
  const effects: Array<string> = [];
  const note = (entry: string) => Effect.sync(() => void effects.push(entry));
  const slack = makeFakeSlack([
    {
      ...slackWorkspace,
      threads: { ...threads, ...options.threads },
      ...(options.files === undefined ? {} : { files: options.files }),
    },
  ]);
  const claimed = new Set<string>();
  const links: Array<SlackLink> = [
    ...(options.unlinked === true
      ? []
      : [
          {
            organizationId: ACME,
            teamId: "T-acme",
            slackUserId: "U-alice",
            userId: "alice",
            createdAt: NOW,
          },
        ]),
    ...(options.bobLinked === true
      ? [
          {
            organizationId: ACME,
            teamId: "T-acme",
            slackUserId: "U-bob",
            userId: "bob",
            createdAt: NOW,
          },
        ]
      : []),
  ];
  const minted: Array<{ readonly slackUserId: string; readonly request: SlackPendingMention }> = [];
  const recorded: Array<SlackThreadSession> = [];
  /** The status line each session's message shows, as `slack_threads.reported_status`. */
  const reported = new Map<string, string>();
  const audited: Array<NewAuditEvent> = [];
  const launches: Array<LaunchRequest> = [];
  /** What each create was asked, beyond what `effects` notes. */
  const creates: Array<CreateSessionInput> = [];
  /** The opening turn each launch submitted, by session. */
  const opened = new Map<string, AgentTurn>();
  /** Each intent recorded on a turn. */
  const intents: Array<{ readonly turnId: string; readonly reading: RequestIntentReading }> = [];
  /** Each landing "Push and open pull request" started. */
  const lands: Array<OwnerLandingInput> = [];
  const inferences: Array<InferenceRequest> = [];
  /** Who each inference ran as. */
  const principals: Array<string> = [];
  const answers = [...(options.inference ?? [])];
  /** The state and status message each session shows, as `slack_threads` holds them. */
  const shownState = new Map<string, string>();
  const statusTs = new Map<string, string>();
  const sessionsCreated = new Map<string, Session>();
  let createCount = 0;
  const storeRoot = options.storeRoot;
  const visible = [billing, web, notes].map((candidate) =>
    storeRoot === undefined
      ? candidate
      : new Project({ ...candidate, storePath: path.join(storeRoot, candidate.id) }),
  );
  /** Alice sees every project; a linked Bob sees the shared ones. */
  const visibleTo = (userId: string) =>
    userId === "alice"
      ? visible
      : userId === "bob" && options.bobLinked === true
        ? visible.filter((candidate) => candidate.visibility === "shared")
        : [];
  let channelDefault = options.channelDefault ?? null;
  const earlier = options.threadSession;
  const earlierSession =
    earlier === undefined
      ? null
      : new Session({
          ...makeSession(
            EARLIER,
            earlier.projectId,
            WorktreeId.make("wt-0"),
            earlier.owner ?? "bob",
          ),
          harness: "claude",
          status: earlier.status ?? "running",
          origin: "slack",
          sharedControlEnabledByUserId: earlier.sharedControl === true ? "alice" : null,
          sharedControlEnabledAt: earlier.sharedControl === true ? NOW : null,
        });
  const question =
    earlier?.questions === undefined
      ? null
      : new AgentRequest({
          id: AgentRequestId.make("request-1"),
          sessionId: EARLIER,
          processId: SessionProcessId.make("agent-1"),
          turnId: AgentTurnId.make("turn-1"),
          kind: "user-input",
          providerRequestId: "provider-request-1",
          providerItemId: null,
          title: null,
          detail: null,
          questions: earlier.questions,
          status: "pending",
          decision: null,
          decidedBy: null,
          answers: null,
          createdAt: NOW,
          decidedAt: null,
        });
  const created = (projectId: ProjectId, owner: string) =>
    new Session({
      ...makeSession(
        SessionId.make(`session-${recorded.length + 1}`),
        projectId,
        WorktreeId.make(`wt-${recorded.length + 1}`),
        owner,
      ),
      harness: "claude",
      label: null,
      status: "starting",
      origin: "slack",
    });
  const threadRow = (row: SlackThreadSession): SlackThreadSession => {
    const state = shownState.get(row.sessionId);
    return {
      ...row,
      statusTs: statusTs.get(row.sessionId) ?? null,
      reportedStatus: reported.get(row.sessionId) ?? null,
      reportedState:
        state === "starting" || state === "running" || state === "failed" || state === "stopped"
          ? state
          : null,
    };
  };

  const layer = Layer.mergeAll(
    slack.layer,
    Layer.mock(SlackInstallsRepo, {
      byOrganization: (id) => Effect.succeed(id === ACME ? install : null),
      byTeam: (teamId) => Effect.succeed(teamId === install.teamId ? install : null),
    }),
    Layer.mock(SlackLinksRepo, {
      bySlackUser: (teamId, slackUserId) =>
        Effect.succeed(
          links.find((link) => link.teamId === teamId && link.slackUserId === slackUserId) ?? null,
        ),
      listForUser: (userId) => Effect.succeed(links.filter((link) => link.userId === userId)),
      mintCode: ({ slackUserId, request }) =>
        note(`links.mintCode:${slackUserId}`).pipe(
          Effect.andThen(Effect.sync(() => minted.push({ slackUserId, request }))),
          Effect.as({ code: "msl_code", expiresAt: NOW }),
        ),
    }),
    Layer.mock(SlackDefaultsRepo, {
      channelDefault: (teamId, channelId) =>
        Effect.sync(() =>
          channelDefault === null
            ? null
            : {
                teamId,
                channelId,
                projectId: channelDefault,
                setByUserId: options.channelDefaultSetBy ?? "alice",
                updatedAt: NOW,
              },
        ),
      setChannelDefault: (input) =>
        note(
          `defaults.setChannelDefault:${input.channelId}:${input.projectId}:${input.setByUserId}`,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              channelDefault = input.projectId;
              return { ...input, updatedAt: NOW };
            }),
          ),
        ),
      clearChannelDefault: (_teamId, channelId) =>
        note(`defaults.clearChannelDefault:${channelId}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              const had = channelDefault !== null;
              channelDefault = null;
              return had;
            }),
          ),
        ),
      personalDefault: () => Effect.succeed(options.personalDefault ?? null),
    }),
    Layer.mock(SlackThreadsRepo, {
      record: (input) =>
        Effect.sync(() => {
          const row = {
            ...input,
            statusTs: null,
            reportedState: null,
            reportedStatus: null,
            createdAt: NOW,
          };
          recorded.push(row);
          return row;
        }),
      latestInThread: (thread) =>
        Effect.succeed(
          options.threadSession?.threadTs === thread.threadTs
            ? {
                sessionId: EARLIER,
                teamId: thread.teamId,
                channelId: thread.channelId,
                threadTs: thread.threadTs,
                requestTs: thread.threadTs,
                statusTs: null,
                slackUserId: "U-bob",
                projectSource: "picked",
                external: false,
                reportedState: null,
                reportedStatus: null,
                createdAt: NOW,
              }
            : null,
        ),
      forSession: (sessionId) =>
        Effect.sync(() => {
          const row = recorded.find((candidate) => candidate.sessionId === sessionId);
          return row === undefined ? null : threadRow(row);
        }),
      setStatusTs: (sessionId, ts, shown) =>
        note(`threads.setStatusTs:${sessionId}:${ts}`).pipe(
          Effect.andThen(
            Effect.sync(() => {
              statusTs.set(sessionId, ts);
              shownState.set(sessionId, shown.state);
              reported.set(sessionId, options.reporterMovedFirst === true ? "moved" : shown.line);
            }),
          ),
        ),
      listForOwner: (input) =>
        note(`threads.listForOwner:${input.teamId}:${input.ownerUserId}:${input.limit}`).pipe(
          Effect.as((options.owned ?? []).slice(0, input.limit)),
        ),
      claimStatus: (sessionId, from, to) =>
        Effect.sync(() => {
          if (reported.get(sessionId) !== from) return false;
          reported.set(sessionId, to.line);
          shownState.set(sessionId, to.state);
          return true;
        }),
    }),
    Layer.mock(SlackEventClaimsRepo, {
      claim: ({ eventId }) =>
        note(`claim:${eventId}`).pipe(
          Effect.as(!claimed.has(eventId)),
          Effect.tap(() => Effect.sync(() => void claimed.add(eventId))),
        ),
    }),
    Layer.mock(SessionsRepo, {
      byId: (id) => {
        const made = sessionsCreated.get(id);
        if (made !== undefined) return Effect.succeed(made);
        return earlierSession !== null && id === EARLIER
          ? Effect.succeed(earlierSession)
          : Effect.fail(new SessionNotFoundError({ sessionId: id }));
      },
      listForWorktree: (worktreeId) =>
        Effect.sync(() =>
          [
            ...sessionsCreated.values(),
            ...(earlierSession === null ? [] : [earlierSession]),
          ].filter((made) => made.worktreeId === worktreeId),
        ),
    }),
    Layer.mock(AgentConversationRepo, {
      listTurns: (sessionId) =>
        Effect.sync(() => {
          if (options.turns !== undefined) {
            return options.turns.map((status, index) => agentTurn(sessionId, status, index + 1));
          }
          const opening = opened.get(sessionId);
          return opening === undefined ? [] : [opening];
        }),
      setTurnIntent: (turnId, reading) =>
        Effect.sync(() => {
          intents.push({ turnId, reading });
          return new AgentTurn({
            ...agentTurn(SessionId.make("unused"), "running", 1),
            id: turnId,
            intent: reading.intent,
            intentSource: reading.source,
          });
        }),
      listRequests: (sessionId, pendingOnly) =>
        Effect.succeed(question !== null && sessionId === EARLIER && pendingOnly ? [question] : []),
    }),
    Layer.mock(SessionProcessesRepo, {
      listForSession: (sessionId) => {
        if (sessionId !== EARLIER) return Effect.succeed([]);
        switch (earlier?.agent ?? "resumable") {
          case "resumable":
            return Effect.succeed([agentProcess(sessionId, "agent-protocol", "claude-1", false)]);
          case "no-provider-id":
            return Effect.succeed([agentProcess(sessionId, "agent-protocol", null, false)]);
          case "live-terminal":
            return Effect.succeed([agentProcess(sessionId, "agent-pty", "claude-1", true)]);
          case "none":
            return Effect.succeed([]);
        }
      },
    }),
    Layer.mock(SessionControlEventsRepo, {
      record: (event) =>
        note(`controls.record:${event.sessionId}:${event.kind}:${event.actorUserId}`),
    }),
    Layer.mock(SessionEngine, {
      stop: (sessionId) =>
        note(`engine.stop:${sessionId}`).pipe(
          Effect.andThen(
            options.stopFails === true
              ? Effect.fail(new SessionNotFoundError({ sessionId }))
              : Effect.void,
          ),
        ),
      submitTurn: (sessionId, input, author) =>
        note(`engine.submitTurn:${sessionId}:${author}:${input}`).pipe(
          Effect.andThen(
            earlier?.live === false
              ? Effect.fail(new ProtocolHostNotLiveError({ processId: sessionId }))
              : Effect.succeed(agentTurn(sessionId, "queued", 2)),
          ),
        ),
      respondRequest: (requestId, response, decidedBy) =>
        note(
          `engine.respondRequest:${requestId}:${decidedBy}:${JSON.stringify("answers" in response ? response.answers : response.decision)}`,
        ).pipe(
          Effect.andThen(
            question === null ? Effect.die("no question in this test") : Effect.succeed(question),
          ),
        ),
    }),
    Layer.mock(SessionSteering, {
      authorizeUser: (session, userId) =>
        session.ownerUserId === userId || session.sharedControlEnabledAt !== null
          ? Effect.succeed(session)
          : Effect.fail(
              new SessionNotSteerable({
                sessionId: session.id,
                message: "only the session owner can steer this session",
              }),
            ),
    }),
    Layer.mock(Store, {
      listTopLevel: (dir) =>
        dir.endsWith(billing.id)
          ? Effect.succeed({ files: ["README.md", "ledger/", "invoices/"], truncated: false })
          : Effect.succeed({ files: ["app/", "package.json"], truncated: false }),
    }),
    ThreadProjectReaderLive.pipe(
      Layer.provide(
        Layer.succeed(InferenceProvider, {
          respond: (request) =>
            Effect.gen(function* () {
              inferences.push(request);
              const principal = yield* SealantPrincipal;
              principals.push(principal.kind === "user" ? principal.userId : "none");
              const answer = answers.shift();
              if (answer === undefined) {
                return yield* new InferenceError({ message: "no answer scripted", cause: null });
              }
              return answer;
            }),
        }),
      ),
    ),
    Layer.mock(AuditEventsRepo, {
      record: (event) => Effect.sync(() => void audited.push(event)),
    }),
    Layer.succeed(SecretCipher, {
      encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext}`),
      decrypt: (sealed) => Effect.succeed(sealed.replace(/^sealed:/, "")),
    }),
    Layer.mock(ProjectAccess, {
      visibleProjectsOf: (userId) => Effect.succeed(visibleTo(userId)),
      projectAs: (userId, id) => {
        const found = visibleTo(userId).find((candidate) => candidate.id === id);
        return found === undefined ? Effect.fail(new NotFound({ id })) : Effect.succeed(found);
      },
    }),
    Layer.mock(SessionStart, {
      createAs: (userId, projectId, input) =>
        note(
          `start.createAs:${userId}:${projectId}:${input.harness}:${input.base}:${input.origin}`,
        ).pipe(
          Effect.andThen(Effect.sync(() => void creates.push(input))),
          Effect.andThen(
            options.createDies
              ? Effect.die(new Error("pg: connection reset at /srv/mend/store"))
              : options.createFails === undefined || ++createCount < (options.createFailsFrom ?? 1)
                ? Effect.sync(() => {
                    const session = created(projectId, userId);
                    sessionsCreated.set(session.id, session);
                    return session;
                  })
                : Effect.fail(options.createFails),
          ),
        ),
      launchAs: (userId, session, request) =>
        note(`start.launchAs:${userId}:${session.id}`).pipe(
          Effect.andThen(Effect.sync(() => launches.push(request))),
          Effect.andThen(
            options.launchFails === undefined
              ? Effect.sync(() => {
                  // A protocol launch submits its prompt as the opening turn.
                  opened.set(session.id, agentTurn(session.id, "queued", 1));
                  return new Session({ ...session, status: "running" });
                })
              : Effect.fail(options.launchFails),
          ),
        ),
    }),
    Layer.mock(OwnerLanding, {
      land: (input) =>
        Effect.suspend(() => {
          lands.push(input);
          if (options.landRefused !== undefined) return Effect.fail(options.landRefused);
          return Effect.succeed({
            landing: new ChangeLanding({
              id: ChangeLandingId.make(`landing-${lands.length}`),
              changeId: ChangeId.make("change-1"),
              sessionId: input.session.id,
              projectId: input.project.id,
              checkpointId: null,
              checkpointRef: null,
              checkpointSha: null,
              commitSha: null,
              remoteBranch: input.session.branch,
              pushedSha: Sha.make("3f2a1c0".padEnd(40, "0")),
              trigger: input.trigger,
              pullRequest: {
                number: 412,
                url: "https://github.com/acme/billing-api/pull/412",
                state: "open",
                observedAt: NOW,
              },
              outcome: "pull-request",
              message: null,
              userId: input.ownerUserId,
              createdAt: NOW,
            }),
            pullRequest: {
              _tag: "opened" as const,
              pullRequest: {
                number: 412,
                url: "https://github.com/acme/billing-api/pull/412",
                state: "open" as const,
                observedAt: NOW,
              },
            },
          });
        }),
    }),
    Layer.mock(SealantClients, {
      connectedAccounts: () => ({
        list: () => Effect.succeed(options.accounts ?? [account("claude"), account("codex")]),
        connect: () => Effect.die("not in this test"),
        disconnect: () => Effect.die("not in this test"),
      }),
      sshKeys: () => ({
        ensure: () => Effect.die("not in this test"),
        list: () => Effect.die("not in this test"),
      }),
    }),
  );

  const run = <A>(body: (runner: SlackRunner["Service"]) => Effect.Effect<A>) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* makeSlackRunner({
            eventsPerMinute: options.eventsPerMinute ?? 120,
            linkedRequestMaxAgeMs: 15 * 60_000,
            inferencesPerHour: options.inferencesPerHour ?? 60,
            now: () => options.now ?? NOW.getTime(),
          });
          const result = yield* body(runner);
          yield* runner.idle;
          return result;
        }),
      ).pipe(Effect.provide(layer)),
    );

  /** Deliver envelopes and wait for every one of them to be handled. */
  const deliver = (...envelopes: ReadonlyArray<SlackEnvelope>) =>
    run((runner) =>
      Effect.forEach(envelopes, (envelope) => runner.receive(ACME, envelope), { discard: true }),
    );

  const envelope = (type: string, envelopeId: string, body: unknown): SlackEnvelope => ({
    type,
    envelopeId,
    body,
    retryAttempt: null,
    ack: note(`ack:${envelopeId}`),
  });

  const mention = (
    eventId: string,
    event: Record<string, unknown>,
    teamId = "T-acme",
    outer: Record<string, unknown> = {},
  ): SlackEnvelope =>
    envelope("events_api", `env-${eventId}`, {
      team_id: teamId,
      event_id: eventId,
      ...outer,
      event: { type: "app_mention", channel: "C-general", ...event },
    });

  const pick = (input: {
    readonly user: string;
    readonly parentTs: string;
    readonly messageTs: string;
    readonly projectId: string;
    readonly envelopeId: string;
    /** The session a "Switch project" picker stops. */
    readonly switchFrom?: string;
  }) =>
    envelope("interactive", input.envelopeId, {
      type: "block_actions",
      team: { id: "T-acme" },
      user: { id: input.user },
      channel: { id: "C-general" },
      container: { channel_id: "C-general", is_ephemeral: true },
      actions: [
        {
          action_id: `${SLACK_ACTIONS.pickProject}_0`,
          block_id: projectPickerBlockId(
            `${input.parentTs}/${input.messageTs}${input.switchFrom === undefined ? "" : `/s:${input.switchFrom}`}`,
          ),
          value: input.projectId,
        },
      ],
    });

  /** A click on a status message's "Switch project". */
  const switchClick = (input: {
    readonly user: string;
    readonly sessionId: string;
    readonly envelopeId: string;
  }) =>
    envelope("interactive", input.envelopeId, {
      type: "block_actions",
      team: { id: "T-acme" },
      user: { id: input.user },
      channel: { id: "C-general" },
      container: { channel_id: "C-general", message_ts: "1700000000.000001" },
      actions: [{ action_id: SLACK_ACTIONS.switchProject, value: input.sessionId }],
    });

  /** A click on the `@mend settings` reply: a project, or Clear. */
  const settingsClick = (input: {
    readonly user: string;
    readonly envelopeId: string;
    readonly threadTs: string;
    /** A project id; null clicks Clear. */
    readonly projectId: string | null;
    readonly actionTs?: string;
    readonly channel?: string;
  }) =>
    envelope("interactive", input.envelopeId, {
      type: "block_actions",
      team: { id: "T-acme" },
      user: { id: input.user },
      channel: { id: input.channel ?? "C-general" },
      container: { channel_id: input.channel ?? "C-general", is_ephemeral: true },
      actions: [
        {
          action_id:
            input.projectId === null
              ? SLACK_ACTIONS.clearChannelDefault
              : channelDefaultActionId(0),
          block_id: channelSettingsBlockId(input.threadTs),
          ...(input.projectId === null ? { value: "clear" } : { value: input.projectId }),
          ...(input.actionTs === undefined ? {} : { action_ts: input.actionTs }),
        },
      ],
    });

  /** A press of "Push and open pull request" on a session's offer. */
  const landClick = (input: {
    readonly user: string;
    readonly sessionId: string;
    readonly envelopeId: string;
    readonly actionTs?: string;
  }) =>
    envelope("interactive", input.envelopeId, {
      type: "block_actions",
      team: { id: "T-acme" },
      user: { id: input.user },
      channel: { id: "C-general" },
      container: { channel_id: "C-general", message_ts: "1700000000.000009" },
      actions: [
        {
          action_id: SLACK_ACTIONS.landChange,
          value: input.sessionId,
          ...(input.actionTs === undefined ? {} : { action_ts: input.actionTs }),
        },
      ],
    });

  return {
    effects,
    slack,
    minted,
    recorded,
    audited,
    launches,
    creates,
    intents,
    lands,
    landClick,
    inferences,
    principals,
    run,
    deliver,
    envelope,
    mention,
    pick,
    switchClick,
    settingsClick,
  };
};

const posts = (w: ReturnType<typeof world>, kind: "postMessage" | "postEphemeral") =>
  w.slack.calls.flatMap((call) => (call.kind === kind ? [call.input] : []));

describe("the Slack runner, for a linked person's mention", () => {
  it("acknowledges, claims, picks the project the thread links, and starts the session as them", async () => {
    const w = world();
    await w.deliver(
      w.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> fix the flaky login test effort=high",
        ts: MENTION,
        thread_ts: THREAD,
      }),
    );

    expect(w.effects).toEqual([
      "ack:env-Ev1",
      "claim:Ev1",
      `claim:message:T-acme:C-general:${MENTION}`,
      `start.createAs:alice:${billing.id}:claude:null:slack`,
      "threads.setStatusTs:session-1:1700000000.000001",
      "start.launchAs:alice:session-1",
    ]);
    expect(w.recorded).toMatchObject([
      {
        sessionId: "session-1",
        teamId: "T-acme",
        channelId: "C-general",
        threadTs: THREAD,
        requestTs: MENTION,
        slackUserId: "U-alice",
        projectSource: "thread-link",
      },
    ]);
    expect(w.audited).toMatchObject([
      {
        organizationId: ACME,
        actorUserId: "alice",
        action: "slack.session_started",
        subjectType: "session",
        subjectId: "session-1",
        data: {
          teamId: "T-acme",
          channelId: "C-general",
          messageTs: MENTION,
          slackUserId: "U-alice",
          projectName: "billing-api",
          projectSource: "thread-link",
        },
      },
    ]);
    expect(w.slack.reactions.get(`C-general:${MENTION}`)).toEqual(
      new Set(["hourglass_flowing_sand"]),
    );
    const [status] = posts(w, "postMessage");
    expect(status?.threadTs).toBe(THREAD);
    expect(status?.text).toBe(
      "billing-api · from a link in the thread · claude · starting · mend/wt-1",
    );
    const updates = w.slack.calls.flatMap((call) => (call.kind === "update" ? [call.input] : []));
    expect(updates.map((update) => update.text)).toEqual([
      "billing-api · from a link in the thread · claude · running · mend/wt-1",
    ]);

    // The thread's link answered: no inference was asked.
    expect(w.inferences).toEqual([]);

    const [launch] = w.launches;
    expect(launch?.mode).toBe("protocol");
    expect(launch?.effort).toBe("high");
    expect(launch?.prompt).toContain("fix the flaky login test");
    expect(launch?.prompt).toContain("--- Slack thread context ---");
    expect(launch?.prompt).toContain("Bob wrote:\n> login test flakes on CI");
    // The mention itself is the request, not context; the option is not in the prompt.
    expect(launch?.prompt).not.toContain("effort=high");
  });

  it("acts once on an event Slack delivers twice, and once on a message sent as two events", async () => {
    const w = world();
    const event = {
      user: "U-alice",
      text: "<@U-bot> fix the flaky login test",
      ts: MENTION,
      thread_ts: THREAD,
    };
    await w.deliver(
      w.mention("Ev1", event),
      w.mention("Ev1", event),
      w.mention("Ev2", { ...event, type: "message", channel_type: "im" }),
    );

    expect(w.effects.filter((entry) => entry.startsWith("ack:"))).toHaveLength(3);
    expect(w.effects.filter((entry) => entry.startsWith("start.createAs"))).toHaveLength(1);
  });

  it("ignores bots, itself, edits and channel messages without a mention", async () => {
    const w = world();
    await w.deliver(
      w.mention("Ev1", { user: "U-bob", bot_id: "B-other", text: "<@U-bot> hi", ts: "1.1" }),
      w.mention("Ev2", { user: "U-bot", text: "<@U-bot> hi", ts: "1.2" }),
      w.mention("Ev3", { user: "U-alice", subtype: "message_changed", text: "hi", ts: "1.3" }),
      w.mention("Ev4", { type: "message", channel_type: "channel", user: "U-alice", ts: "1.4" }),
      w.mention("Ev5", { user: "U-alice", text: "<@U-bot> hi", ts: "1.5" }, "T-elsewhere"),
    );

    expect(w.effects.filter((entry) => entry.startsWith("start."))).toEqual([]);
    expect(w.slack.calls).toEqual([]);
  });

  it("drops what is over the install's events per minute, after acknowledging it", async () => {
    const w = world({ eventsPerMinute: 2 });
    await w.deliver(
      w.mention("Ev1", { user: "U-bob", bot_id: "B", ts: "1.1" }),
      w.mention("Ev2", { user: "U-bob", bot_id: "B", ts: "1.2" }),
      w.mention("Ev3", { user: "U-bob", bot_id: "B", ts: "1.3" }),
    );

    expect(w.effects.filter((entry) => entry.startsWith("ack:"))).toEqual([
      "ack:env-Ev1",
      "ack:env-Ev2",
      "ack:env-Ev3",
    ]);
    // The third is not even claimed: a busy channel costs the database nothing more.
    expect(w.effects.filter((entry) => entry.startsWith("claim:"))).toEqual([
      "claim:Ev1",
      "claim:Ev2",
    ]);
  });
});

describe("the Slack runner, before anything starts", () => {
  it("tells someone from another Slack workspace that only members can use Mend", async () => {
    const w = world();
    await w.deliver(
      w.mention("Ev1", { user: "U-guest", user_team: "T-guest", text: "<@U-bot> hi", ts: "1.1" }),
    );

    expect(posts(w, "postEphemeral")).toMatchObject([
      { user: "U-guest", text: "Only members of Acme HQ can use Mend here." },
    ]);
    expect(w.minted).toEqual([]);
  });

  it("gives an unlinked person a link that carries their request", async () => {
    const w = world();
    await w.deliver(
      w.mention("Ev1", {
        user: "U-bob",
        text: "<@U-bot> fix it",
        ts: "1700000200.000200",
        thread_ts: "1700000200.000100",
      }),
    );

    expect(w.minted).toEqual([
      {
        slackUserId: "U-bob",
        request: {
          channelId: "C-general",
          messageTs: "1700000200.000200",
          threadTs: "1700000200.000100",
          text: "<@U-bot> fix it",
        },
      },
    ]);
    const [prompt] = posts(w, "postEphemeral");
    expect(prompt).toMatchObject({ user: "U-bob", threadTs: "1700000200.000100" });
    expect(JSON.stringify(prompt?.blocks)).toContain("https://mend.acme.test/slack/link/msl_code");
    expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
  });

  it("answers help for anyone, linked or not", async () => {
    const w = world();
    await w.deliver(w.mention("Ev1", { user: "U-bob", text: "<@U-bot> help", ts: "1.1" }));

    const [help] = posts(w, "postEphemeral");
    expect(help?.text).toBe("@mend help");
    expect(w.minted).toEqual([]);
  });

  it("refuses an option it cannot use, only to the requester", async () => {
    const w = world();
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> effort=extreme fix it", ts: "1.1" }),
    );

    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([
      "not started · effort=extreme · not one of low, medium, high, xhigh, max",
    ]);
    expect(w.slack.reactions.get("C-general:1.1")).toEqual(new Set(["x"]));
    expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
  });

  it("says so in the thread when the owner has no account for the harness, and starts nothing", async () => {
    const w = world({ accounts: [account("claude", "invalid")] });
    await w.deliver(
      w.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> fix the flaky login test",
        ts: MENTION,
        thread_ts: THREAD,
      }),
    );

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "not started · no active claude account is connected to your Mend account · connect one in Mend under Settings → Connected accounts",
    ]);
    expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
  });
});

describe("the Slack runner, choosing a project", () => {
  it("takes the project the message names, with the harness and base it names", async () => {
    const w = world();
    await w.deliver(
      w.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> in web with codex from release/2.3 tidy the header",
        ts: "1700000300.000100",
      }),
    );

    expect(w.effects).toContain(`start.createAs:alice:${web.id}:codex:release/2.3:slack`);
    expect(w.recorded[0]?.projectSource).toBe("message");
  });

  it("starts another session in the thread's project on `new`", async () => {
    const w = world({ threadSession: { threadTs: "1700000200.000100", projectId: web.id } });
    await w.deliver(
      w.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> new look into it",
        ts: "1700000200.000200",
        thread_ts: "1700000200.000100",
      }),
    );

    expect(w.recorded[0]).toMatchObject({ projectSource: "thread-session" });
    expect(w.effects).toContain(`start.createAs:alice:${web.id}:claude:null:slack`);
    expect(w.effects.some((entry) => entry.startsWith("engine.submitTurn"))).toBe(false);
    expect(w.launches[0]?.prompt?.startsWith("look into it")).toBe(true);
  });

  it("offers only shared projects in a channel, and private ones in a direct message", async () => {
    const channel = world({ personalDefault: notes.id, inference: [inferred(null)] });
    await channel.deliver(
      channel.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> tidy up",
        ts: "1700000300.000100",
      }),
    );
    // The private default is not a candidate in a channel: Mend asks instead.
    const [picker] = posts(channel, "postEphemeral");
    expect(picker?.text).toBe(
      "No project named in the request or the thread, and no default set. Pick one to start the session.",
    );
    expect(JSON.stringify(picker?.blocks)).not.toContain("notes");
    expect(channel.effects.some((entry) => entry.startsWith("start."))).toBe(false);

    const direct = world({ personalDefault: notes.id, inference: [inferred(null)] });
    await direct.deliver(
      direct.mention("Ev1", {
        type: "message",
        channel_type: "im",
        channel: "D-alice",
        user: "U-alice",
        text: "tidy up",
        ts: "1700000400.000100",
      }),
    );
    expect(direct.effects).toContain(`start.createAs:alice:${notes.id}:claude:null:slack`);
    expect(direct.recorded[0]).toMatchObject({ projectSource: "personal-default" });
  });

  it("uses the channel default before the person's own", async () => {
    const w = world({
      channelDefault: web.id,
      personalDefault: billing.id,
      inference: [inferred(null)],
    });
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> tidy up", ts: "1700000300.000100" }),
    );

    expect(w.recorded[0]).toMatchObject({ projectSource: "channel-default" });
  });

  it("continues from a picked project, for the requester only and once", async () => {
    const w = world();
    const key = { parentTs: "1700000300.000100", messageTs: "1700000300.000100" };
    await w.deliver(
      w.pick({ ...key, user: "U-bob", projectId: web.id, envelopeId: "i0" }),
      w.pick({ ...key, user: "U-alice", projectId: web.id, envelopeId: "i1" }),
      w.pick({ ...key, user: "U-alice", projectId: billing.id, envelopeId: "i2" }),
    );

    expect(posts(w, "postEphemeral")).toMatchObject([
      { user: "U-bob", text: "Only the person who made the request picks its project." },
    ]);
    expect(w.effects.filter((entry) => entry.startsWith("start.createAs"))).toEqual([
      `start.createAs:alice:${web.id}:claude:null:slack`,
    ]);
    expect(w.recorded[0]).toMatchObject({ projectSource: "picked", requestTs: key.messageTs });
    expect(w.launches[0]?.prompt).toBe("tidy up");
  });

  it("checks the clicker's link before claiming the pick, so an unlinked click spends nothing", async () => {
    const w = world({ unlinked: true });
    const key = { parentTs: "1700000300.000100", messageTs: "1700000300.000100" };
    await w.deliver(w.pick({ ...key, user: "U-alice", projectId: web.id, envelopeId: "i1" }));

    expect(posts(w, "postEphemeral")).toMatchObject([
      {
        user: "U-alice",
        text: "not started · this Slack account is no longer linked to Mend · mention Mend again to link it",
      },
    ]);
    expect(w.effects.some((entry) => entry.startsWith("claim:pick:"))).toBe(false);
    expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
  });
});

describe("the Slack runner, reading the thread with inference", () => {
  const retryMention = (w: ReturnType<typeof world>, eventId: string, text: string) =>
    w.mention(eventId, {
      user: "U-alice",
      text,
      ts: RETRY_MENTION,
      thread_ts: RETRY_THREAD,
    });

  it("starts in the project inference reads from the thread, as the requester, and says so", async () => {
    const w = world({ inference: [inferred(web.id, [web.id, billing.id])] });
    await w.deliver(retryMention(w, "Ev1", "<@U-bot> look into it"));

    expect(w.effects).toContain(`start.createAs:alice:${web.id}:claude:null:slack`);
    expect(w.recorded[0]).toMatchObject({ projectSource: "thread-inference" });
    expect(w.audited[0]?.data).toMatchObject({ projectSource: "thread-inference" });
    expect(posts(w, "postMessage")[0]?.text).toBe(
      "web · from the thread · claude · starting · mend/wt-1",
    );

    expect(w.principals).toEqual(["alice"]);
    const [request] = w.inferences;
    expect(request?.context).toBe("slack-project");
    // Channel candidates only: the private project is not shown to inference either.
    expect(request?.prompt).toContain(`id: ${billing.id}`);
    expect(request?.prompt).toContain(`id: ${web.id}`);
    expect(request?.prompt).not.toContain(notes.id);
    expect(request?.prompt).toContain("root: README.md, ledger/, invoices/");
    expect(request?.prompt).toContain("Bob: anyone seen the retry storm?");
    expect(request?.prompt).toContain("The request:\nlook into it");
  });

  it("asks inference before the channel default, and uses the default when inference cannot choose", async () => {
    const first = world({ channelDefault: web.id, inference: [inferred(billing.id)] });
    await first.deliver(retryMention(first, "Ev1", "<@U-bot> look into it"));
    expect(first.recorded[0]).toMatchObject({
      projectSource: "thread-inference",
      sessionId: "session-1",
    });
    expect(first.effects).toContain(`start.createAs:alice:${billing.id}:claude:null:slack`);

    const second = world({ channelDefault: web.id, inference: [inferred(null, [billing.id])] });
    await second.deliver(retryMention(second, "Ev1", "<@U-bot> look into it"));
    expect(second.recorded[0]).toMatchObject({ projectSource: "channel-default" });
  });

  it("asks with the likeliest projects first when nothing answers, and never offers a non-candidate", async () => {
    const w = world({ inference: [inferred(notes.id, [notes.id, web.id])] });
    await w.deliver(retryMention(w, "Ev1", "<@U-bot> look into it"));

    expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
    const [picker] = posts(w, "postEphemeral");
    expect(picker?.text).toBe(
      "No project named in the request or the thread, and no default set. Pick one to start the session.",
    );
    const actions = picker?.blocks?.[1];
    if (actions?.type !== "actions") throw new Error("expected the picker's actions");
    const [button, select] = actions.elements;
    expect(button).toMatchObject({ value: web.id });
    expect(actions.elements).toHaveLength(2);
    expect(select?.type === "static_select" ? select.options.map((o) => o.value) : []).toEqual([
      web.id,
      billing.id,
    ]);
  });

  it("takes the options the requester wrote, never over theirs and never from the thread", async () => {
    const w = world({
      inference: [
        inferred(web.id, [], { harness: "codex", effort: "high", branch: "main" }),
        inferred(web.id, [], { harness: "codex", effort: "high" }),
      ],
    });
    await w.deliver(
      retryMention(w, "Ev1", "<@U-bot> use codex for this and go high effort, look into it"),
    );
    // `main` is not in the request: dropped. The rest are the requester's own words.
    expect(w.effects).toContain(`start.createAs:alice:${web.id}:codex:null:slack`);
    expect(w.launches[0]?.effort).toBe("high");

    await w.deliver(
      w.mention("Ev2", {
        user: "U-alice",
        text: "<@U-bot> harness=claude use codex for this and go high effort",
        ts: "1700000200.000300",
        thread_ts: RETRY_THREAD,
      }),
    );
    expect(w.effects).toContain(`start.createAs:alice:${web.id}:claude:null:slack`);
  });

  it("goes on without inference when it fails or the organization is over its hourly ceiling", async () => {
    const failing = world({ personalDefault: web.id, inference: [] });
    await failing.deliver(retryMention(failing, "Ev1", "<@U-bot> look into it"));
    expect(failing.recorded[0]).toMatchObject({ projectSource: "personal-default" });

    const capped = world({
      personalDefault: web.id,
      inferencesPerHour: 1,
      inference: [inferred(billing.id), inferred(billing.id)],
    });
    await capped.deliver(
      retryMention(capped, "Ev1", "<@U-bot> look into it"),
      capped.mention("Ev2", {
        user: "U-alice",
        text: "<@U-bot> and again",
        ts: "1700000200.000300",
        thread_ts: RETRY_THREAD,
      }),
    );
    expect(capped.inferences).toHaveLength(1);
    expect(capped.recorded.map((row) => row.projectSource).toSorted()).toEqual([
      "personal-default",
      "thread-inference",
    ]);
  });
});

/** The requester picks `projectId` from the switch picker of session-1. */
const switchTo = (w: ReturnType<typeof world>, projectId: string) =>
  w.deliver(
    w.pick({
      user: "U-alice",
      parentTs: "1700000300.000100",
      messageTs: "1700000300.000100",
      projectId,
      envelopeId: "i2",
      switchFrom: "session-1",
    }),
  );

describe("the Slack runner, switching a session's project", () => {
  /** Alice asks in web; the status message offers Switch project. */
  const started = (options: WorldOptions = {}) => {
    const w = world(options);
    return {
      w,
      start: () =>
        w.deliver(
          w.mention("Ev1", {
            user: "U-alice",
            text: "<@U-bot> in web tidy up",
            ts: "1700000300.000100",
          }),
        ),
    };
  };

  it("offers Switch project on the status message until the first turn completes", async () => {
    const { w, start } = started();
    await start();
    const [status] = posts(w, "postMessage");
    expect(JSON.stringify(status?.blocks)).toContain(SLACK_ACTIONS.switchProject);
    expect(JSON.stringify(status?.blocks)).toContain('"value":"session-1"');
  });

  it("gives the requester a picker of the other projects, and stops and restarts on a pick", async () => {
    const { w, start } = started();
    await start();
    await w.deliver(w.switchClick({ user: "U-alice", sessionId: "session-1", envelopeId: "i1" }));

    const picker = posts(w, "postEphemeral").at(-1);
    expect(picker?.text).toBe(
      "Pick the project to restart this request in. The session already started for it is stopped once the new one is created.",
    );
    const blocks = JSON.stringify(picker?.blocks);
    expect(blocks).toContain(billing.id);
    expect(blocks).not.toContain(`"value":"${web.id}"`);
    expect(blocks).toContain(
      projectPickerBlockId("1700000300.000100/1700000300.000100/e/s:session-1"),
    );

    await w.deliver(
      w.pick({
        user: "U-alice",
        parentTs: "1700000300.000100",
        messageTs: "1700000300.000100",
        projectId: billing.id,
        envelopeId: "i2",
        switchFrom: "session-1",
      }),
      // A second click on the same switch does nothing.
      w.pick({
        user: "U-alice",
        parentTs: "1700000300.000100",
        messageTs: "1700000300.000100",
        projectId: web.id,
        envelopeId: "i3",
        switchFrom: "session-1",
      }),
    );

    const after = w.effects.slice(w.effects.indexOf("claim:switch:T-acme:session-1"));
    expect(
      after.filter((entry) => !entry.startsWith("ack:") && !entry.startsWith("claim:")),
    ).toEqual([
      // The new session first; the one it replaces is stopped only once it exists.
      `start.createAs:alice:${billing.id}:claude:null:slack`,
      "engine.stop:session-1",
      "controls.record:session-1:stop:alice",
      "threads.setStatusTs:session-2:1700000000.000003",
      "start.launchAs:alice:session-2",
    ]);
    const updates = w.slack.calls.flatMap((call) => (call.kind === "update" ? [call.input] : []));
    expect(updates.map((update) => update.text)).toContain(
      "web · named in the request · claude · stopped · mend/wt-1",
    );
    const stopped = updates.find((update) => update.text.includes("stopped"));
    expect(JSON.stringify(stopped?.blocks)).not.toContain(SLACK_ACTIONS.switchProject);
    expect(w.recorded[1]).toMatchObject({ sessionId: "session-2", projectSource: "picked" });
    expect(w.audited[1]?.data).toMatchObject({
      switchedFrom: "session-1",
      projectName: "billing-api",
    });
    // The request carries the new session's reaction only.
    expect(w.slack.reactions.get("C-general:1700000300.000100")).toEqual(
      new Set(["hourglass_flowing_sand"]),
    );
  });

  it("leaves the session running when the new one is refused", async () => {
    const refusal = new BudgetExceeded({
      budget: "accountLiveSessions",
      limit: 1,
      retryAfterSeconds: null,
      message: "budget reached · 1 unsettled session for one account · nothing running was stopped",
    });
    const { w, start } = started({ createFails: refusal, createFailsFrom: 2 });
    await start();
    await switchTo(w, billing.id);

    expect(w.effects.some((entry) => entry.startsWith("engine.stop"))).toBe(false);
    expect(w.effects.some((entry) => entry.startsWith("controls.record"))).toBe(false);
    expect(posts(w, "postMessage").at(-1)?.text).toBe(
      "not started · budget reached · 1 unsettled session for one account · nothing running was stopped",
    );
    const updates = w.slack.calls.flatMap((call) => (call.kind === "update" ? [call.input] : []));
    expect(updates.some((update) => update.text.includes("stopped"))).toBe(false);
  });

  it("records no stop when the engine could not stop the session, and tells the requester", async () => {
    const { w, start } = started({ stopFails: true });
    await start();
    await switchTo(w, billing.id);

    expect(w.effects).toContain("engine.stop:session-1");
    expect(w.effects.some((entry) => entry.startsWith("controls.record"))).toBe(false);
    expect(posts(w, "postEphemeral").at(-1)?.text).toBe(
      "switched · the earlier session could not be stopped · stop it in Mend",
    );
    // The new session still starts: the requester asked for it.
    expect(w.effects).toContain("start.launchAs:alice:session-2");
  });

  it("switches only for the requester, and not once the first turn has completed", async () => {
    const { w, start } = started({ turns: ["completed"] });
    await start();
    await w.deliver(
      w.switchClick({ user: "U-bob", sessionId: "session-1", envelopeId: "i1" }),
      w.switchClick({ user: "U-alice", sessionId: "session-1", envelopeId: "i2" }),
      w.pick({
        user: "U-alice",
        parentTs: "1700000300.000100",
        messageTs: "1700000300.000100",
        projectId: billing.id,
        envelopeId: "i3",
        switchFrom: "session-1",
      }),
    );

    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([
      "Only the person who made the request switches its project.",
      "not switched · the session's first turn has completed · mention Mend again to start another session",
      "not switched · the session's first turn has completed · mention Mend again to start another session",
    ]);
    expect(w.effects.some((entry) => entry.startsWith("engine.stop"))).toBe(false);
    expect(w.effects.filter((entry) => entry.startsWith("start.createAs"))).toHaveLength(1);
  });
});

describe("the Slack runner, following up a thread's session", () => {
  const followUp = (w: ReturnType<typeof world>, text: string, user = "U-alice") =>
    w.mention("Ev9", {
      user,
      text: `<@U-bot> ${text}`,
      ts: "1700000200.000900",
      thread_ts: RETRY_THREAD,
    });
  const alices = (overrides: Partial<NonNullable<WorldOptions["threadSession"]>> = {}) =>
    world({
      threadSession: { threadTs: RETRY_THREAD, projectId: web.id, owner: "alice", ...overrides },
    });

  it("sends the mention as a turn to the thread's latest session, as the person who sent it", async () => {
    const w = alices();
    await w.deliver(followUp(w, "also cover the logout test effort=high"));

    expect(
      w.effects.filter((entry) => !entry.startsWith("ack:") && !entry.startsWith("claim:")),
    ).toEqual([`engine.submitTurn:session-earlier:alice:also cover the logout test`]);
    // The session keeps its effort: only the requester hears that `effort=` was not applied.
    expect(posts(w, "postMessage")).toEqual([]);
    expect(posts(w, "postEphemeral")).toMatchObject([
      {
        user: "U-alice",
        text: "model and effort not applied · they apply when a session starts · use `@mend new …`",
      },
    ]);
    expect(w.inferences).toEqual([]);

    const plain = alices();
    await plain.deliver(followUp(plain, "also cover the logout test"));
    expect(plain.slack.calls).toEqual([]);
  });

  it("refuses a follow-up from someone who may not steer the session, only to them", async () => {
    const w = world({ threadSession: { threadTs: RETRY_THREAD, projectId: web.id } });
    await w.deliver(followUp(w, "also cover the logout test"));

    expect(posts(w, "postEphemeral")).toMatchObject([
      {
        user: "U-alice",
        threadTs: RETRY_THREAD,
        text: "not sent · only the session owner can steer this session",
      },
    ]);
    expect(posts(w, "postMessage")).toEqual([]);
    expect(w.slack.reactions.get("C-general:1700000200.000900")).toEqual(new Set(["x"]));
    expect(w.effects.some((entry) => entry.startsWith("engine."))).toBe(false);
    expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
  });

  it("starts a new session instead when the mention names another project", async () => {
    const w = alices();
    await w.deliver(followUp(w, "in billing-api check the ledger too"));

    expect(w.effects.some((entry) => entry.startsWith("engine.submitTurn"))).toBe(false);
    expect(w.effects).toContain(`start.createAs:alice:${billing.id}:claude:null:slack`);
    expect(w.recorded[0]).toMatchObject({ projectSource: "message" });
  });

  it("answers the agent's question with the owner's mention, instead of a turn", async () => {
    const questions: ReadonlyArray<AgentInputQuestion> = [
      {
        id: "q-retries",
        header: null,
        question: "Keep the retry limit?",
        options: [
          { label: "Keep 3", description: null },
          { label: "Make it configurable", description: null },
        ],
        multiSelect: false,
      },
    ];
    const w = alices({ questions });
    await w.deliver(followUp(w, "2"));

    expect(w.effects).toContain(
      'engine.respondRequest:request-1:alice:{"q-retries":["Make it configurable"]}',
    );
    expect(w.effects.some((entry) => entry.startsWith("engine.submitTurn"))).toBe(false);

    // Two questions, one line: refused, to the owner only.
    const twice = alices({
      questions: [...questions, { ...questions[0]!, id: "q-branch", question: "Which base?" }],
    });
    await twice.deliver(followUp(twice, "2"));
    expect(posts(twice, "postEphemeral").map((post) => post.text)).toEqual([
      "not answered · the agent asked 2 questions · answer one per line, in order",
    ]);
    expect(twice.effects.some((entry) => entry.startsWith("engine."))).toBe(false);
  });

  it("leaves the question to the owner: someone steering under shared control sends a turn", async () => {
    const w = world({
      bobLinked: true,
      threadSession: {
        threadTs: RETRY_THREAD,
        projectId: web.id,
        owner: "alice",
        sharedControl: true,
        questions: [
          { id: "q", header: null, question: "Keep it?", options: [], multiSelect: false },
        ],
      },
    });
    await w.deliver(followUp(w, "keep it", "U-bob"));

    expect(w.effects.filter((entry) => entry.startsWith("engine."))).toEqual([
      "engine.submitTurn:session-earlier:bob:keep it",
    ]);
  });

  it("resumes a session that is no longer live, with the follow-up as its opening turn", async () => {
    const w = alices({ live: false, status: "completed" });
    await w.deliver(followUp(w, "also cover the logout test"));

    expect(
      w.effects.filter((entry) => entry.startsWith("engine.") || entry.startsWith("start.")),
    ).toEqual([
      "engine.submitTurn:session-earlier:alice:also cover the logout test",
      "start.launchAs:alice:session-earlier",
    ]);
    expect(w.launches).toMatchObject([{ mode: "protocol", prompt: "also cover the logout test" }]);
    expect(w.slack.calls).toEqual([]);
  });

  it("keeps a resume's store failure out of the channel, and tells only the requester", async () => {
    const stderr = "fatal: '/srv/mend/store/p-web/worktrees/wt-0' is locked";
    const w = world({
      launchFails: new StoreFailure({ message: stderr }),
      threadSession: {
        threadTs: RETRY_THREAD,
        projectId: web.id,
        owner: "alice",
        live: false,
        status: "completed",
      },
    });
    await w.deliver(followUp(w, "also cover the logout test"));

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "not resumed · the session could not be resumed",
    ]);
    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([`not resumed · ${stderr}`]);
  });

  it("says so, and starts a new session in the thread, when the session cannot be resumed", async () => {
    const w = alices({ live: false, status: "failed", agent: "no-provider-id" });
    await w.deliver(followUp(w, "try again"));

    const [said] = posts(w, "postMessage");
    expect(said).toMatchObject({
      threadTs: RETRY_THREAD,
      text: "The thread's session is no longer live and cannot be resumed. Mend starts a new session in this thread, with the thread as context.",
    });
    expect(w.effects).toContain(`start.createAs:alice:${web.id}:claude:null:slack`);
    expect(w.recorded[0]).toMatchObject({
      projectSource: "thread-session",
      threadTs: RETRY_THREAD,
    });
    expect(w.launches[0]?.prompt).toContain("--- Slack thread context ---");
    expect(w.launches[0]?.prompt).toContain("anyone seen the retry storm?");
  });

  it("leaves a session that is still starting, or live out of Slack's reach, alone", async () => {
    const starting = alices({ live: false, status: "starting", agent: "none" });
    await starting.deliver(followUp(starting, "also this"));
    const terminal = alices({ live: false, agent: "live-terminal" });
    await terminal.deliver(followUp(terminal, "also this"));

    expect(posts(starting, "postEphemeral").map((post) => post.text)).toEqual([
      "not sent · the session is still starting · mention Mend again once it runs",
    ]);
    expect(posts(terminal, "postEphemeral").map((post) => post.text)).toEqual([
      "not sent · the session's agent runs where Slack cannot reach it · send it from Mend",
    ]);
    for (const w of [starting, terminal]) {
      expect(w.effects.some((entry) => entry.startsWith("start."))).toBe(false);
    }
  });

  it("decides what a follow-up does when nothing takes its turn", () => {
    const session = { status: "completed" as const, harness: "claude" };
    expect(
      followUpWhenNotLive(session, agentProcess(EARLIER, "agent-protocol", "c-1", false)),
    ).toBe("resume");
    expect(followUpWhenNotLive(session, agentProcess(EARLIER, "agent-protocol", null, false))).toBe(
      "start-new",
    );
    expect(followUpWhenNotLive(session, agentProcess(EARLIER, "agent-pty", "c-1", false))).toBe(
      "start-new",
    );
    expect(followUpWhenNotLive(session, agentProcess(EARLIER, "agent-pty", "c-1", true))).toBe(
      "out-of-reach",
    );
    expect(
      followUpWhenNotLive(
        { ...session, harness: "codex" },
        agentProcess(EARLIER, "agent-protocol", "c-1", false),
      ),
    ).toBe("start-new");
    expect(followUpWhenNotLive(session, null)).toBe("start-new");
    expect(followUpWhenNotLive({ ...session, status: "starting" }, null)).toBe("starting");
  });
});

/** Alice's mention of a command, in a channel or in her direct message with Mend. */
const command = (w: ReturnType<typeof world>, text: string, channel = "C-general") =>
  w.mention("Ev1", {
    user: "U-alice",
    text: `<@U-bot> ${text}`,
    ts: "1700000500.000100",
    channel,
    ...(channel.startsWith("D") ? { type: "message", channel_type: "im" } : {}),
  });

describe("the Slack runner, for `settings` and `list`", () => {
  it("shows the channel default and the shared projects the member can pick, only to them", async () => {
    const w = world({ channelDefault: web.id, channelDefaultSetBy: "alice" });
    await w.deliver(command(w, "settings"));

    const [reply] = posts(w, "postEphemeral");
    expect(reply).toMatchObject({ user: "U-alice" });
    expect(reply?.text).toBe("channel default · web · set by you on 2026-09-23");
    const blocks = JSON.stringify(reply?.blocks);
    expect(blocks).toContain(`"value":"${billing.id}"`);
    expect(blocks).not.toContain(notes.id);
    expect(blocks).toContain(SLACK_ACTIONS.clearChannelDefault);
    expect(blocks).toContain(channelSettingsBlockId("1700000500.000100"));
  });

  it("sets the channel default on a click, audits it, and does it once per click", async () => {
    const w = world();
    const click = {
      user: "U-alice",
      threadTs: "1700000500.000100",
      projectId: billing.id,
      actionTs: "1700000600.000001",
    };
    await w.deliver(
      w.settingsClick({ ...click, envelopeId: "i1" }),
      w.settingsClick({ ...click, envelopeId: "i2" }),
    );

    expect(w.effects.filter((entry) => entry.startsWith("defaults."))).toEqual([
      `defaults.setChannelDefault:C-general:${billing.id}:alice`,
    ]);
    expect(w.audited).toMatchObject([
      {
        organizationId: ACME,
        actorUserId: "alice",
        action: "slack.channel_default_set",
        subjectType: "project",
        subjectId: billing.id,
        data: {
          teamId: "T-acme",
          channelId: "C-general",
          slackUserId: "U-alice",
          projectName: "billing-api",
          previousProjectId: null,
        },
      },
    ]);
    expect(posts(w, "postEphemeral")).toMatchObject([
      {
        user: "U-alice",
        threadTs: "1700000500.000100",
        text: "channel default · billing-api · set by you",
      },
    ]);
  });

  it("clears it, refuses a private project in a channel, and asks the unlinked to link", async () => {
    const w = world({ channelDefault: web.id });
    await w.deliver(
      w.settingsClick({ user: "U-alice", envelopeId: "i1", threadTs: "1.1", projectId: null }),
      w.settingsClick({ user: "U-alice", envelopeId: "i2", threadTs: "1.1", projectId: notes.id }),
      w.settingsClick({ user: "U-bob", envelopeId: "i3", threadTs: "1.1", projectId: web.id }),
    );

    expect(w.effects.filter((entry) => entry.startsWith("defaults."))).toEqual([
      "defaults.clearChannelDefault:C-general",
    ]);
    expect(w.audited).toMatchObject([
      {
        action: "slack.channel_default_cleared",
        subjectId: web.id,
        data: { channelId: "C-general", projectName: "web" },
      },
    ]);
    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([
      "channel default · cleared by you",
      "not set · the project is not one you can pick here · a channel offers shared projects only",
      "Mend acts only for a linked Mend account. Mention Mend to get a link only you see.",
    ]);
  });

  it("points a direct message's `settings` at Mend's own settings", async () => {
    const w = world();
    await w.deliver(command(w, "settings", "D-alice"));
    const [reply] = posts(w, "postEphemeral");
    expect(reply?.text).toContain("https://mend.acme.test/settings#slack");
    expect(w.effects.some((entry) => entry.startsWith("defaults."))).toBe(false);
  });

  it("lists the person's Slack sessions with state and links, leaving out projects they cannot see", async () => {
    const row = (
      sessionId: string,
      projectId: ProjectId,
      state: SlackOwnedSession["reportedState"],
    ): SlackOwnedSession => ({
      sessionId: SessionId.make(sessionId),
      teamId: "T-acme",
      channelId: "C-general",
      threadTs: "1.1",
      requestTs: "1.1",
      statusTs: "1.2",
      slackUserId: "U-alice",
      projectSource: "picked",
      external: false,
      reportedState: state,
      reportedStatus: null,
      createdAt: NOW,
      projectId,
      label: null,
      harness: "claude",
      branch: `mend/${sessionId}`,
      status: "running",
    });
    const w = world({
      owned: [
        row("s3", billing.id, "completed"),
        row("s2", ProjectId.make("p-gone"), "running"),
        row("s1", web.id, null),
      ],
    });
    await w.deliver(command(w, "list"));

    expect(w.effects).toContain("threads.listForOwner:T-acme:alice:11");
    const [reply] = posts(w, "postEphemeral");
    expect(reply).toMatchObject({ user: "U-alice" });
    const body = JSON.stringify(reply?.blocks);
    expect(body).toContain(
      "• <https://mend.acme.test/sessions/s3|mend/s3> · billing-api · completed · <#C-general>",
    );
    expect(body).toContain("• <https://mend.acme.test/sessions/s1|mend/s1> · web · running");
    expect(body).not.toContain("s2");
  });
});

describe("the Slack runner, when a start is refused", () => {
  it("posts the budget's own words in the thread and marks the request", async () => {
    const refusal = new BudgetExceeded({
      budget: "accountLiveSessions",
      limit: 24,
      retryAfterSeconds: null,
      message:
        "budget reached · 24 unsettled sessions for one account · nothing running was stopped",
    });
    const w = world({ createFails: refusal });
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> in web tidy up", ts: "1.1" }),
    );

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "not started · budget reached · 24 unsettled sessions for one account · nothing running was stopped",
    ]);
    expect(w.slack.reactions.get("C-general:1.1")).toEqual(new Set(["x"]));
    expect(w.recorded).toEqual([]);
  });

  it("keeps a store failure's own words out of the channel, and tells only the requester", async () => {
    const stderr = "fatal: '/srv/mend/store/p-web/worktrees/wt-1' already exists";
    const w = world({ createFails: new StoreFailure({ message: stderr }) });
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> in web tidy up", ts: "1.1" }),
    );

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "not started · the worktree could not be created",
    ]);
    expect(posts(w, "postEphemeral")).toMatchObject([
      { user: "U-alice", text: `not started · ${stderr}` },
    ]);
    expect(w.slack.reactions.get("C-general:1.1")).toEqual(new Set(["x"]));
  });

  it("reports a failure nothing expected in the thread, without its internals", async () => {
    const w = world({ createDies: true });
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> in web tidy up", ts: "1.1" }),
    );

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "failed · Mend could not finish handling this request · see the Mend logs",
    ]);
    expect(JSON.stringify(w.slack.calls)).not.toContain("/srv/mend");
    expect(w.slack.reactions.get("C-general:1.1")).toEqual(new Set(["x"]));
  });

  it("reports a failed launch, swaps the reaction and marks the status failed", async () => {
    const w = world({ launchFails: new StoreFailure({ message: "workspace create refused" }) });
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> in web tidy up", ts: "1.1" }),
    );

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "web · named in the request · claude · starting · mend/wt-1",
      "launch failed · the session could not be launched",
    ]);
    expect(posts(w, "postEphemeral")).toMatchObject([
      { user: "U-alice", text: "launch failed · workspace create refused" },
    ]);
    expect(w.slack.reactions.get("C-general:1.1")).toEqual(new Set(["x"]));
    const updates = w.slack.calls.flatMap((call) => (call.kind === "update" ? [call.input] : []));
    expect(updates.map((update) => update.text)).toEqual([
      "web · named in the request · claude · failed · mend/wt-1",
    ]);
  });
});

/** A mention of "in web tidy up", with what the envelope says about the channel. */
const sharedMention = (
  w: ReturnType<typeof world>,
  eventId: string,
  ts: string,
  user: string,
  external?: boolean,
) =>
  w.mention(
    eventId,
    { user, text: "<@U-bot> in web tidy up", ts },
    "T-acme",
    external === undefined ? {} : { is_ext_shared_channel: external },
  );

describe("the Slack runner, for the thread reporter", () => {
  it("records whether the channel is Slack Connect, and reads an unsaid one as external", async () => {
    const w = world();
    await w.deliver(
      sharedMention(w, "Ev1", "1.1", "U-alice", false),
      sharedMention(w, "Ev2", "1.2", "U-alice", true),
      sharedMention(w, "Ev3", "1.3", "U-alice"),
    );
    expect(w.recorded.map((row) => [row.requestTs, row.external])).toEqual([
      ["1.1", false],
      ["1.2", true],
      ["1.3", true],
    ]);
  });

  it("carries the channel's kind through a link code", async () => {
    const w = world();
    await w.deliver(sharedMention(w, "Ev1", "1.1", "U-bob", false));
    expect(w.minted[0]?.request).toMatchObject({ messageTs: "1.1", external: false });
  });

  it("leaves the status message alone once the reporter has moved it", async () => {
    const w = world({ reporterMovedFirst: true });
    await w.deliver(sharedMention(w, "Ev1", "1.1", "U-alice", false));
    expect(w.effects).toContain("start.launchAs:alice:session-1");
    expect(w.slack.calls.filter((call) => call.kind === "update")).toEqual([]);
  });
});

describe("the Slack runner, after a link is confirmed", () => {
  const job = (overrides: Partial<SlackLinkedMentionJob> = {}): SlackLinkedMentionJob => ({
    organizationId: ACME,
    teamId: "T-acme",
    slackUserId: "U-alice",
    userId: "alice",
    request: {
      channelId: "C-general",
      messageTs: MENTION,
      threadTs: THREAD,
      text: "<@U-bot> fix the flaky login test",
    },
    linkedAt: NOW.toISOString(),
    ...overrides,
  });

  it("runs the request the person made before they linked", async () => {
    const w = world();
    await w.run((runner) => runner.runLinked(job()));

    expect(w.effects).toContain(`start.createAs:alice:${billing.id}:claude:null:slack`);
    // The original event was claimed when it arrived; the job claims nothing.
    expect(w.effects.some((entry) => entry.startsWith("claim:"))).toBe(false);
  });

  it("leaves a stale request, or one whose link has changed, alone", async () => {
    const stale = world({ now: NOW.getTime() + 16 * 60_000 });
    await stale.run((runner) => runner.runLinked(job()));
    const relinked = world();
    await relinked.run((runner) => runner.runLinked(job({ userId: "carol" })));

    expect(stale.slack.calls).toEqual([]);
    expect(relinked.slack.calls).toEqual([]);
  });
});

/** Screenshots in a thread: the files, their bytes, and the store they are pasted into. */
const SHOTS_THREAD = "1700000400.000100";
const SHOTS_MENTION = "1700000400.000300";
const MB = 1024 * 1024;
const png = (bytes = 64) => {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data;
};
const url = (id: string) => `https://files.slack.com/files-pri/T-acme-${id}/${id}`;
const shot = (
  id: string,
  name: string,
  overrides: Partial<SlackThreadFile> = {},
): SlackThreadFile => ({
  id,
  name,
  mimetype: "image/png",
  urlPrivate: url(id),
  size: 64,
  ...overrides,
});
/** A mention's files as the event carries them, in Slack's own field names. */
const onTheWire = (files: ReadonlyArray<SlackThreadFile>) =>
  files.map((file) => ({
    id: file.id,
    name: file.name,
    mimetype: file.mimetype,
    url_private: file.urlPrivate,
    size: file.size,
  }));

const withStore = async <A>(body: (storeRoot: string) => Promise<A>) => {
  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mend-slack-shots-"));
  try {
    return await body(storeRoot);
  } finally {
    await fs.rm(storeRoot, { recursive: true, force: true });
  }
};
const pasted = async (storeRoot: string, projectId: string, sessionId: string) => {
  const directory = path.join(
    harnessHomePathOf(path.join(storeRoot, projectId), sessionId),
    "paste",
  );
  const names = await fs.readdir(directory).catch(() => []);
  return Promise.all(
    names.toSorted().map(async (name) => ({
      name,
      bytes: (await fs.readFile(path.join(directory, name))).byteLength,
    })),
  );
};

describe("the Slack runner, attaching screenshots from the thread", () => {
  it("attaches the request's and the thread's images to the opening turn, and names what it skipped", async () => {
    await withStore(async (storeRoot) => {
      const requestFiles = [
        shot("F-alice", "layout.png"),
        shot("F-heic", "photo.heic", { mimetype: "image/heic" }),
        shot("F-huge", "huge.png", { size: 9 * MB }),
        shot("F-fake", "fake.png"),
      ];
      const w = world({
        storeRoot,
        threads: {
          [`C-general:${SHOTS_THREAD}`]: [
            {
              ...message(SHOTS_THREAD, "U-bob", "the login page renders like this"),
              files: [shot("F-bob", "bob.png", { size: 128 })],
            },
            {
              ...message(SHOTS_MENTION, "U-alice", "<@U-bot> project=billing-api fix the layout"),
              files: requestFiles,
            },
          ],
        },
        files: {
          [url("F-alice")]: png(),
          [url("F-bob")]: png(128),
          [url("F-fake")]: new TextEncoder().encode("<html>sign in</html>"),
        },
      });
      await w.deliver(
        w.mention("Ev1", {
          user: "U-alice",
          text: "<@U-bot> project=billing-api fix the layout",
          ts: SHOTS_MENTION,
          thread_ts: SHOTS_THREAD,
          files: onTheWire(requestFiles),
        }),
      );

      // Both images are pasted into the new session's harness home before it launches.
      const stored = await pasted(storeRoot, billing.id, "session-1");
      expect(stored.every((file) => file.name.endsWith(".png"))).toBe(true);
      expect(stored.map((file) => file.bytes).toSorted((a, b) => a - b)).toEqual([64, 128]);
      const [launch] = w.launches;
      const prompt = launch?.prompt ?? "";
      expect(prompt).toMatch(
        /^fix the layout\n\nAttached to the request:\n\[image: layout\.png · \/workspace\/harness-home\/paste\/[\w-]+\.png\]\n/,
      );
      expect(prompt).toContain(
        "[image: photo.heic · not attached · not a PNG, JPEG, GIF or WebP image]",
      );
      expect(prompt).toContain("[image: huge.png · not attached · over the 8 MB an image may be]");
      expect(prompt).toContain(
        "[image: fake.png · not attached · not a PNG, JPEG, GIF or WebP image]",
      );
      expect(prompt).toContain("Open a path to see the image.");
      expect(prompt).toMatch(
        /Bob wrote:\n> the login page renders like this\n> \[image: bob\.png · \/workspace\/harness-home\/paste\/[\w-]+\.png\]/,
      );
      expect(posts(w, "postEphemeral")).toMatchObject([
        {
          user: "U-alice",
          threadTs: SHOTS_THREAD,
          text: "not attached · photo.heic · not a PNG, JPEG, GIF or WebP image; huge.png · over the 8 MB an image may be; fake.png · not a PNG, JPEG, GIF or WebP image",
        },
      ]);
    });
  });

  it("stops at the turn's image count and bytes, newest first after the request's own", async () => {
    await withStore(async (storeRoot) => {
      // Eleven images over two messages, each under the paste's limit, most with no size said.
      const older = Array.from({ length: 6 }, (_, index) =>
        shot(`F-old${index}`, `old${index}.png`, { size: null }),
      );
      const newer = Array.from({ length: 5 }, (_, index) =>
        shot(`F-new${index}`, `new${index}.png`, { size: null }),
      );
      const files = Object.fromEntries(
        [...older, ...newer].map((file) => [file.urlPrivate, png(1024)]),
      );
      const w = world({
        storeRoot,
        threads: {
          [`C-general:${SHOTS_THREAD}`]: [
            { ...message(SHOTS_THREAD, "U-bob", "before"), files: older },
            { ...message("1700000400.000200", "U-bob", "after"), files: newer },
            message(SHOTS_MENTION, "U-alice", "<@U-bot> project=billing-api compare them"),
          ],
        },
        files,
      });
      await w.deliver(
        w.mention("Ev1", {
          user: "U-alice",
          text: "<@U-bot> project=billing-api compare them",
          ts: SHOTS_MENTION,
          thread_ts: SHOTS_THREAD,
        }),
      );

      expect(await pasted(storeRoot, billing.id, "session-1")).toHaveLength(10);
      const prompt = w.launches[0]?.prompt ?? "";
      // The newer message's five come first, then the older one's, in the order it lists them.
      for (const file of newer) expect(prompt).toContain(`[image: ${file.name} · /workspace/`);
      expect(prompt).toContain(
        "[image: old5.png · not attached · past the 10 images one turn carries]",
      );
      expect(posts(w, "postEphemeral")[0]?.text).toBe(
        "not attached · old5.png · past the 10 images one turn carries",
      );
    });
  });

  it("sends a follow-up's images with its turn, and a follow-up of images alone", async () => {
    await withStore(async (storeRoot) => {
      const w = world({
        storeRoot,
        threadSession: { threadTs: RETRY_THREAD, projectId: web.id, owner: "alice" },
        files: { [url("F-next")]: png() },
      });
      await w.deliver(
        w.mention("Ev9", {
          user: "U-alice",
          text: "<@U-bot>",
          ts: "1700000200.000900",
          thread_ts: RETRY_THREAD,
          files: onTheWire([shot("F-next", "next.png")]),
        }),
      );

      expect(await pasted(storeRoot, web.id, EARLIER)).toMatchObject([{ bytes: 64 }]);
      const turns = w.effects.filter((entry) => entry.startsWith("engine.submitTurn:"));
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatch(
        /^engine\.submitTurn:session-earlier:alice:The request is in the files attached to it\.\n\nAttached to the request:\n\[image: next\.png · \/workspace\/harness-home\/paste\/[\w-]+\.png\]/,
      );
      // Everything was attached: nothing to tell the requester.
      expect(w.slack.calls).toEqual([]);
    });
  });

  it("answers the agent's question with the words, and tells the owner the images stayed behind", async () => {
    const w = world({
      threadSession: {
        threadTs: RETRY_THREAD,
        projectId: web.id,
        owner: "alice",
        questions: [
          {
            id: "q-retries",
            header: null,
            question: "Keep the retry limit?",
            options: [{ label: "Keep 3", description: null }],
            multiSelect: false,
          },
        ],
      },
    });
    await w.deliver(
      w.mention("Ev9", {
        user: "U-alice",
        text: "<@U-bot> keep 3",
        ts: "1700000200.000900",
        thread_ts: RETRY_THREAD,
        files: onTheWire([shot("F-next", "next.png")]),
      }),
    );

    expect(w.effects).toContain('engine.respondRequest:request-1:alice:{"q-retries":["Keep 3"]}');
    expect(w.effects.some((entry) => entry.startsWith("engine.submitTurn"))).toBe(false);
    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([
      "not attached · the images · an answer to the agent's question carries text only · mention Mend again with them once it has the answer",
    ]);
  });

  it("keeps a mention's images through a link, and attaches them once the person has linked", async () => {
    await withStore(async (storeRoot) => {
      const files = [shot("F-first", "first.png")];
      const unlinked = world();
      await unlinked.deliver(
        unlinked.mention("Ev1", {
          user: "U-bob",
          text: "<@U-bot> fix it",
          ts: "1700000200.000200",
          thread_ts: "1700000200.000100",
          files: onTheWire(files),
        }),
      );
      expect(unlinked.minted[0]?.request.files).toEqual(files);

      const w = world({ storeRoot, files: { [url("F-first")]: png() } });
      await w.run((runner) =>
        runner.runLinked({
          organizationId: ACME,
          teamId: "T-acme",
          slackUserId: "U-alice",
          userId: "alice",
          request: {
            channelId: "C-general",
            messageTs: "1700000500.000100",
            threadTs: null,
            text: "<@U-bot> project=billing-api fix what the screenshot shows",
            files,
          },
          linkedAt: NOW.toISOString(),
        }),
      );
      expect(await pasted(storeRoot, billing.id, "session-1")).toHaveLength(1);
      expect(w.launches[0]?.prompt).toMatch(
        /^fix what the screenshot shows\n\nAttached to the request:\n\[image: first\.png · \/workspace\//,
      );
    });
  });
});

describe("chooseProject", () => {
  const base = {
    candidates: [billing, web],
    picked: null,
    named: null,
    threadSession: null,
    threadText: "",
    inferred: null,
    channelDefault: null,
    personalDefault: null,
  };

  it("answers in the ADR's order: message, thread session, thread links, channel, person", () => {
    const all = {
      ...base,
      named: "web",
      threadSession: billing.id,
      threadText: "see https://github.com/acme/web/issues/1",
      channelDefault: billing.id,
      personalDefault: web.id,
    };
    expect(chooseProject(all)).toMatchObject({ source: "message", project: { id: web.id } });
    expect(chooseProject({ ...all, named: null })).toMatchObject({
      source: "thread-session",
      project: { id: billing.id },
    });
    expect(chooseProject({ ...all, named: null, threadSession: null })).toMatchObject({
      source: "thread-link",
      project: { id: web.id },
    });
    expect(
      chooseProject({ ...all, named: null, threadSession: null, threadText: "" }),
    ).toMatchObject({ source: "channel-default", project: { id: billing.id } });
    expect(
      chooseProject({
        ...all,
        named: null,
        threadSession: null,
        threadText: "",
        channelDefault: null,
      }),
    ).toMatchObject({ source: "personal-default", project: { id: web.id } });
    expect(chooseProject(base)).toEqual({ kind: "ask", reason: "none", likeliest: [] });
  });

  it("asks inference after the thread's links and before the defaults, and checks its answer", () => {
    const open = { ...base, channelDefault: web.id };
    expect(chooseProject({ ...open, inferred: "not-asked" })).toEqual({ kind: "infer" });
    // A link answers first: inference is not asked.
    expect(
      chooseProject({
        ...open,
        inferred: "not-asked",
        threadText: "https://github.com/acme/billing-api/pull/1",
      }),
    ).toMatchObject({ source: "thread-link" });
    expect(
      chooseProject({ ...open, inferred: { projectId: billing.id, likeliest: [] } }),
    ).toMatchObject({ source: "thread-inference", project: { id: billing.id } });
    // Not a candidate: it answers nothing, and the channel default does.
    expect(
      chooseProject({ ...open, inferred: { projectId: notes.id, likeliest: [notes.id] } }),
    ).toMatchObject({ source: "channel-default" });
    expect(
      chooseProject({ ...base, inferred: { projectId: null, likeliest: [notes.id, web.id] } }),
    ).toEqual({ kind: "ask", reason: "none", likeliest: [web] });
  });

  it("asks when a thread links several projects, and never answers with a non-candidate", () => {
    expect(
      chooseProject({
        ...base,
        threadText: "https://github.com/acme/web and https://github.com/acme/billing-api",
      }),
    ).toMatchObject({ kind: "ask", reason: "several", likeliest: [web, billing] });
    expect(chooseProject({ ...base, named: "notes" })).toEqual({
      kind: "unknown",
      value: "notes",
      picked: false,
    });
    expect(chooseProject({ ...base, picked: notes.id })).toMatchObject({
      kind: "unknown",
      picked: true,
    });
    expect(chooseProject({ ...base, personalDefault: notes.id })).toMatchObject({ kind: "ask" });
  });
});

describe("mentions and picker keys", () => {
  it("reads a mention's thread, and a top-level mention as its own thread", () => {
    expect(
      mentionOf(install, {
        type: "app_mention",
        user: "U-alice",
        text: "hi",
        ts: "2.2",
        channel: "C",
        thread_ts: "2.2",
      }),
    ).toMatchObject({ threadTs: null, messageTs: "2.2" });
    expect(pickerRequestKey({ threadTs: null, messageTs: "2.2", external: false })).toBe("2.2/2.2");
    // A channel that is, or may be, Slack Connect is marked: a click does not say.
    expect(pickerRequestKey({ threadTs: "1.1", messageTs: "2.2", external: null })).toBe(
      "1.1/2.2/e",
    );
    expect(parsePickerRequestKey("1.1/2.2")).toEqual({
      parentTs: "1.1",
      messageTs: "2.2",
      external: false,
      switchFrom: null,
    });
    expect(parsePickerRequestKey("1.1/2.2/e")).toEqual({
      parentTs: "1.1",
      messageTs: "2.2",
      external: true,
      switchFrom: null,
    });
    // A "Switch project" picker names the session its pick stops.
    const switching = pickerRequestKey(
      { threadTs: "1.1", messageTs: "2.2", external: true },
      SessionId.make("session-1"),
    );
    expect(switching).toBe("1.1/2.2/e/s:session-1");
    expect(parsePickerRequestKey(switching)).toEqual({
      parentTs: "1.1",
      messageTs: "2.2",
      external: true,
      switchFrom: "session-1",
    });
    expect(parsePickerRequestKey("nope")).toBeNull();
  });
});

describe("the Slack runner, landing (docs/adr/0007-landing.md)", () => {
  const start = (w: ReturnType<typeof world>, text: string) =>
    w.mention("Ev1", { user: "U-alice", text, ts: MENTION, thread_ts: THREAD });

  it("takes autopr= as the session's own override and records it as the opening turn's intent", async () => {
    const question = world();
    await question.deliver(start(question, "<@U-bot> autopr=false why does the login test flake?"));
    expect(question.creates).toMatchObject([{ origin: "slack", autoLand: false }]);
    expect(question.intents).toEqual([
      { turnId: "turn-1", reading: { intent: "question", source: "option" } },
    ]);
    expect(question.launches[0]?.prompt).toContain("why does the login test flake?");
    expect(question.launches[0]?.prompt).not.toContain("autopr");

    const change = world();
    await change.deliver(start(change, "<@U-bot> fix the flaky login test autopr=true"));
    expect(change.creates).toMatchObject([{ autoLand: true }]);
    expect(change.intents).toEqual([
      { turnId: "turn-1", reading: { intent: "change", source: "option" } },
    ]);

    // Without the option the Slack app's setting decides, and automatic landing reads the intent.
    const plain = world();
    await plain.deliver(start(plain, "<@U-bot> fix the flaky login test"));
    expect(plain.creates).toMatchObject([{ autoLand: null }]);
    expect(plain.intents).toEqual([]);
  });

  it("refuses an autopr= it cannot read, and starts nothing", async () => {
    const w = world();
    await w.deliver(start(w, "<@U-bot> autopr=maybe fix it"));
    expect(w.creates).toEqual([]);
    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([
      "not started · autopr=maybe · not one of true, false",
    ]);
  });

  it("records the intent the thread reading answered, in the call that picked the project", async () => {
    const w = world({ inference: [{ ...inferred(web.id), intent: "question" }] });
    await w.deliver(
      w.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> look into it",
        ts: RETRY_MENTION,
        thread_ts: RETRY_THREAD,
      }),
    );
    expect(w.inferences).toHaveLength(1);
    expect(w.intents).toEqual([
      { turnId: "turn-1", reading: { intent: "question", source: "read" } },
    ]);

    // `autopr=` wins over what the call read.
    const option = world({ inference: [{ ...inferred(web.id), intent: "question" }] });
    await option.deliver(
      option.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> look into it autopr=true",
        ts: RETRY_MENTION,
        thread_ts: RETRY_THREAD,
      }),
    );
    expect(option.intents).toEqual([
      { turnId: "turn-1", reading: { intent: "change", source: "option" } },
    ]);
  });

  it("records a follow-up's autopr= on its own turn, and leaves an unmarked one to be read", async () => {
    const followUp = (w: ReturnType<typeof world>, text: string) =>
      w.mention("Ev9", {
        user: "U-alice",
        text: `<@U-bot> ${text}`,
        ts: "1700000200.000900",
        thread_ts: RETRY_THREAD,
      });
    const alices = (live = true) =>
      world({
        threadSession: {
          threadTs: RETRY_THREAD,
          projectId: web.id,
          owner: "alice",
          live,
          ...(live ? {} : { status: "completed" as const }),
        },
      });

    const marked = alices();
    await marked.deliver(followUp(marked, "autopr=true now make the fix"));
    expect(marked.effects).toContain("engine.submitTurn:session-earlier:alice:now make the fix");
    expect(marked.intents).toEqual([
      { turnId: "turn-2", reading: { intent: "change", source: "option" } },
    ]);

    const unmarked = alices();
    await unmarked.deliver(followUp(unmarked, "now make the fix"));
    expect(unmarked.intents).toEqual([]);

    // A follow-up that resumes the session marks the turn the resume submitted.
    const resumed = alices(false);
    await resumed.deliver(followUp(resumed, "autopr=false what did you change?"));
    expect(resumed.effects).toContain("start.launchAs:alice:session-earlier");
    expect(resumed.intents).toEqual([
      { turnId: "turn-1", reading: { intent: "question", source: "option" } },
    ]);
  });

  it("lands for the owner who presses Push and open pull request, as them, once per press", async () => {
    const w = world();
    await w.deliver(start(w, "<@U-bot> why does the login test flake?"));
    const press = w.landClick({
      user: "U-alice",
      sessionId: "session-1",
      envelopeId: "env-land",
      actionTs: "1700000400.000001",
    });
    await w.deliver(press, press);

    expect(w.lands).toHaveLength(1);
    expect(w.lands[0]).toMatchObject({
      ownerUserId: "alice",
      trigger: "manual",
      webOrigin: "https://mend.acme.test",
      session: { id: "session-1" },
      project: { id: billing.id },
    });
    expect(w.effects).toContain("claim:land:T-acme:session-1:1700000400.000001");
    const whispers = posts(w, "postEphemeral");
    expect(whispers).toMatchObject([{ user: "U-alice" }, { user: "U-alice" }]);
    expect(whispers.map((post) => post.text)).toEqual([
      "landing · pushing to origin as you · the status message shows how it ends",
      "pushed · mend/wt-1 · pull request #412 · opened",
    ]);
    expect(whispers[1]?.threadTs).toBe(THREAD);
    expect(JSON.stringify(whispers[1])).toContain("https://github.com/acme/billing-api/pull/412");
  });

  it("tells anyone but the owner that only the owner lands, where only they read it", async () => {
    const w = world({ bobLinked: true });
    await w.deliver(start(w, "<@U-bot> why does the login test flake?"));
    await w.deliver(
      w.landClick({ user: "U-bob", sessionId: "session-1", envelopeId: "env-bob" }),
      w.landClick({ user: "U-carol", sessionId: "session-1", envelopeId: "env-carol" }),
    );

    expect(w.lands).toEqual([]);
    expect(posts(w, "postEphemeral")).toMatchObject([
      {
        user: "U-bob",
        threadTs: THREAD,
        text: "not pushed · only the change's owner, <@U-alice>, lands it · it pushes with their key and speaks on GitHub as them",
      },
      {
        user: "U-carol",
        text: "Mend acts only for a linked Mend account. Mention Mend to get a link only you see.",
      },
    ]);
    // Nothing is said to the channel.
    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "billing-api · from a link in the thread · claude · starting · mend/wt-1",
    ]);
    // When the change is not the thread's requester's (a session in someone else's worktree),
    // nobody is named.
    expect(ownerOnly(null).text).toBe(
      "not pushed · only the change's owner lands it · it pushes with their key and speaks on GitHub as them",
    );
  });

  it("says why a landing did not start, in its own words, only to the owner", async () => {
    const w = world({
      landRefused: new LandingNotStartedError({
        reason: "no-change",
        message: "the session's change is empty against its base",
      }),
    });
    await w.deliver(start(w, "<@U-bot> why does the login test flake?"));
    await w.deliver(w.landClick({ user: "U-alice", sessionId: "session-1", envelopeId: "env-1" }));

    expect(posts(w, "postEphemeral").map((post) => post.text)).toEqual([
      "landing · pushing to origin as you · the status message shows how it ends",
      "not pushed · the session's change is empty against its base",
    ]);
  });

  it("ignores a press for a session that is not this thread's", async () => {
    const w = world();
    await w.deliver(w.landClick({ user: "U-alice", sessionId: "session-9", envelopeId: "env-1" }));
    expect(w.lands).toEqual([]);
    expect(w.slack.calls).toEqual([]);
  });
});

describe("a request's intent", () => {
  it("is autopr= when the request says it, else what the thread reading answered", () => {
    expect(intentOfRequest(true, "question")).toEqual({ intent: "change", source: "option" });
    expect(intentOfRequest(false, null)).toEqual({ intent: "question", source: "option" });
    expect(intentOfRequest(null, "change")).toEqual({ intent: "change", source: "read" });
    expect(intentOfRequest(null, null)).toBeNull();
  });
});
