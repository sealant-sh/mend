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
  SessionsRepo,
  SlackDefaultsRepo,
  SlackEventClaimsRepo,
  SlackInstallsRepo,
  SlackLinksRepo,
  SlackThreadsRepo,
  type NewAuditEvent,
  type SealedSlackInstall,
  type SlackLink,
  type SlackThreadSession,
} from "@mend/db";
import {
  AgentTurnId,
  OrganizationId,
  ProjectId,
  SessionId,
  SessionProcessId,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  Project,
  Session,
  type AgentTurnStatus,
  type SlackLinkedMentionJob,
  type SlackPendingMention,
} from "@mend/domain/workbench";
import {
  InferenceError,
  InferenceProvider,
  ThreadProjectReaderLive,
  type InferenceRequest,
} from "@mend/inference";
import { SealantClients, SealantPrincipal } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import { projectPickerBlockId, SLACK_ACTIONS, type SlackThreadMessage } from "@mend/slack";
import { makeFakeSlack, type FakeSlackWorkspace } from "@mend/slack/client";
import type { SlackEnvelope } from "@mend/slack/socket";
import { SecretCipher, Store } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { SessionStart } from "./session-start.ts";
import { SessionSteering } from "./session-steering.ts";
import {
  chooseProject,
  makeSlackRunner,
  mentionOf,
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
  readonly personalDefault?: ProjectId;
  readonly threadSession?: { readonly threadTs: string; readonly projectId: ProjectId };
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
}

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
  const slack = makeFakeSlack([slackWorkspace]);
  const claimed = new Set<string>();
  const links: Array<SlackLink> = options.unlinked
    ? []
    : [
        {
          organizationId: ACME,
          teamId: "T-acme",
          slackUserId: "U-alice",
          userId: "alice",
          createdAt: NOW,
        },
      ];
  const minted: Array<{ readonly slackUserId: string; readonly request: SlackPendingMention }> = [];
  const recorded: Array<SlackThreadSession> = [];
  /** The status line each session's message shows, as `slack_threads.reported_status`. */
  const reported = new Map<string, string>();
  const audited: Array<NewAuditEvent> = [];
  const launches: Array<LaunchRequest> = [];
  const inferences: Array<InferenceRequest> = [];
  /** Who each inference ran as. */
  const principals: Array<string> = [];
  const answers = [...(options.inference ?? [])];
  /** The state and status message each session shows, as `slack_threads` holds them. */
  const shownState = new Map<string, string>();
  const statusTs = new Map<string, string>();
  const sessionsCreated = new Map<string, Session>();
  let creates = 0;
  const visible = [billing, web, notes];
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
      mintCode: ({ slackUserId, request }) =>
        note(`links.mintCode:${slackUserId}`).pipe(
          Effect.andThen(Effect.sync(() => minted.push({ slackUserId, request }))),
          Effect.as({ code: "msl_code", expiresAt: NOW }),
        ),
    }),
    Layer.mock(SlackDefaultsRepo, {
      channelDefault: (teamId, channelId) =>
        Effect.succeed(
          options.channelDefault === undefined
            ? null
            : {
                teamId,
                channelId,
                projectId: options.channelDefault,
                setByUserId: "alice",
                updatedAt: NOW,
              },
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
                sessionId: SessionId.make("session-earlier"),
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
        return options.threadSession !== undefined && id === SessionId.make("session-earlier")
          ? Effect.succeed(
              makeSession(id, options.threadSession.projectId, WorktreeId.make("wt-0"), "bob"),
            )
          : Effect.fail(new SessionNotFoundError({ sessionId: id }));
      },
    }),
    Layer.mock(AgentConversationRepo, {
      listTurns: (sessionId) =>
        Effect.succeed(
          (options.turns ?? []).map(
            (status, index) =>
              new AgentTurn({
                id: AgentTurnId.make(`turn-${index + 1}`),
                sessionId,
                processId: SessionProcessId.make("agent-1"),
                ordinal: index + 1,
                author: "alice",
                input: "tidy up",
                status,
                providerTurnId: null,
                error: null,
                usage: null,
                createdAt: NOW,
                startedAt: NOW,
                endedAt: null,
              }),
          ),
        ),
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
    }),
    Layer.mock(SessionSteering, {
      authorizeUser: (session, userId) =>
        session.ownerUserId === userId
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
        dir === billing.storePath
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
      visibleProjectsOf: (userId) => Effect.succeed(userId === "alice" ? visible : []),
      projectAs: (userId, id) => {
        const found = visible.find((candidate) => candidate.id === id);
        return userId === "alice" && found !== undefined
          ? Effect.succeed(found)
          : Effect.fail(new NotFound({ id }));
      },
    }),
    Layer.mock(SessionStart, {
      createAs: (userId, projectId, input) =>
        note(
          `start.createAs:${userId}:${projectId}:${input.harness}:${input.base}:${input.origin}`,
        ).pipe(
          Effect.andThen(
            options.createDies
              ? Effect.die(new Error("pg: connection reset at /srv/mend/store"))
              : options.createFails === undefined || ++creates < (options.createFailsFrom ?? 1)
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
              ? Effect.succeed(new Session({ ...session, status: "running" }))
              : Effect.fail(options.launchFails),
          ),
        ),
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

  return {
    effects,
    slack,
    minted,
    recorded,
    audited,
    launches,
    inferences,
    principals,
    run,
    deliver,
    envelope,
    mention,
    pick,
    switchClick,
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

  it("follows the thread's earlier session into its project", async () => {
    const w = world({ threadSession: { threadTs: "1700000200.000100", projectId: web.id } });
    await w.deliver(
      w.mention("Ev1", {
        user: "U-alice",
        text: "<@U-bot> look into it",
        ts: "1700000200.000200",
        thread_ts: "1700000200.000100",
      }),
    );

    expect(w.recorded[0]).toMatchObject({ projectSource: "thread-session" });
    expect(w.effects).toContain(`start.createAs:alice:${web.id}:claude:null:slack`);
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
