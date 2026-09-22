import {
  BudgetExceeded,
  ConnectedAccount,
  NotFound,
  StoreFailure,
  type LaunchRequest,
} from "@mend/api-contracts";
import {
  AuditEventsRepo,
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
import { OrganizationId, ProjectId, SessionId, WorktreeId } from "@mend/domain";
import {
  Project,
  Session,
  type SlackLinkedMentionJob,
  type SlackPendingMention,
} from "@mend/domain/workbench";
import { SealantClients } from "@mend/sealant";
import { projectPickerBlockId, SLACK_ACTIONS, type SlackThreadMessage } from "@mend/slack";
import { makeFakeSlack, type FakeSlackWorkspace } from "@mend/slack/client";
import type { SlackEnvelope } from "@mend/slack/socket";
import { SecretCipher } from "@mend/store";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { makeProject, makeSession } from "../test/support/tenancy-harness.ts";
import { ProjectAccess } from "./access.ts";
import { SessionStart } from "./session-start.ts";
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
  readonly launchFails?: StoreFailure;
  readonly accounts?: ReadonlyArray<ConnectedAccount>;
  readonly channelDefault?: ProjectId;
  readonly personalDefault?: ProjectId;
  readonly threadSession?: { readonly threadTs: string; readonly projectId: ProjectId };
}

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
  const links: Array<SlackLink> = [
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
  const audited: Array<NewAuditEvent> = [];
  const launches: Array<LaunchRequest> = [];
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
          const row = { ...input, statusTs: null, createdAt: NOW };
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
                createdAt: NOW,
              }
            : null,
        ),
      setStatusTs: (sessionId, statusTs) => note(`threads.setStatusTs:${sessionId}:${statusTs}`),
    }),
    Layer.mock(SlackEventClaimsRepo, {
      claim: ({ eventId }) =>
        note(`claim:${eventId}`).pipe(
          Effect.as(!claimed.has(eventId)),
          Effect.tap(() => Effect.sync(() => void claimed.add(eventId))),
        ),
    }),
    Layer.mock(SessionsRepo, {
      byId: (id) =>
        options.threadSession !== undefined && id === SessionId.make("session-earlier")
          ? Effect.succeed(
              makeSession(id, options.threadSession.projectId, WorktreeId.make("wt-0"), "bob"),
            )
          : Effect.fail(new SessionNotFoundError({ sessionId: id })),
    }),
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
            options.createFails === undefined
              ? Effect.succeed(created(projectId, userId))
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
  ): SlackEnvelope =>
    envelope("events_api", `env-${eventId}`, {
      team_id: teamId,
      event_id: eventId,
      event: { type: "app_mention", channel: "C-general", ...event },
    });

  const pick = (input: {
    readonly user: string;
    readonly parentTs: string;
    readonly messageTs: string;
    readonly projectId: string;
    readonly envelopeId: string;
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
          block_id: projectPickerBlockId(`${input.parentTs}/${input.messageTs}`),
          value: input.projectId,
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
    run,
    deliver,
    envelope,
    mention,
    pick,
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
    const channel = world({ personalDefault: notes.id });
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

    const direct = world({ personalDefault: notes.id });
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
    const w = world({ channelDefault: web.id, personalDefault: billing.id });
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

  it("reports a failed launch, swaps the reaction and marks the status failed", async () => {
    const w = world({ launchFails: new StoreFailure({ message: "workspace create refused" }) });
    await w.deliver(
      w.mention("Ev1", { user: "U-alice", text: "<@U-bot> in web tidy up", ts: "1.1" }),
    );

    expect(posts(w, "postMessage").map((post) => post.text)).toEqual([
      "web · named in the request · claude · starting · mend/wt-1",
      "launch failed · workspace create refused",
    ]);
    expect(w.slack.reactions.get("C-general:1.1")).toEqual(new Set(["x"]));
    const updates = w.slack.calls.flatMap((call) => (call.kind === "update" ? [call.input] : []));
    expect(updates.map((update) => update.text)).toEqual([
      "web · named in the request · claude · failed · mend/wt-1",
    ]);
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
    expect(pickerRequestKey({ threadTs: null, messageTs: "2.2" })).toBe("2.2/2.2");
    expect(parsePickerRequestKey("1.1/2.2")).toEqual({ parentTs: "1.1", messageTs: "2.2" });
    expect(parsePickerRequestKey("nope")).toBeNull();
  });
});
