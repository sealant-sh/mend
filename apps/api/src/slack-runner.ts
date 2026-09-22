import {
  LaunchRequest,
  type BudgetExceeded,
  type NotFound,
  type StoreFailure,
} from "@mend/api-contracts";
import {
  AgentConversationRepo,
  AuditEventsRepo,
  SessionControlEventsRepo,
  SessionsRepo,
  SlackDefaultsRepo,
  SlackEventClaimsRepo,
  SlackInstallsRepo,
  SlackLinksRepo,
  SlackThreadsRepo,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import { ProjectId, SessionId, type OrganizationId } from "@mend/domain";
import type {
  Project,
  Session,
  SlackLinkedMentionJob,
  SlackProjectSource,
} from "@mend/domain/workbench";
import {
  NO_THREAD_PROJECT,
  THREAD_PROJECT_CANDIDATE_LIMIT,
  THREAD_PROJECT_ENTRY_LIMIT,
  ThreadProjectReader,
  type ThreadProjectOptions,
} from "@mend/inference";
import { makeWindowLimiter } from "@mend/network";
import { asSealantUser, SealantClients } from "@mend/sealant";
import { SessionEngine } from "@mend/sessions";
import {
  DEFAULT_MENTION_VOCABULARY,
  escapeSlack,
  helpMessage,
  isDirectMessage,
  linkPrompt,
  linkUrl,
  outsiderMessage,
  parseMention,
  projectPicker,
  projectsLinkedIn,
  projectsNamedBy,
  reactionFor,
  renderOpeningTurn,
  requestKeyOfPicker,
  sessionUrl,
  SLACK_ACTIONS,
  slackToPlain,
  statusMessage,
  switchOffered,
  threadContext,
  type ParsedMention,
  type SlackMessage,
  type SlackReaction,
  type SlackSessionState,
  type SlackThreadMessage,
  type ThreadContext,
} from "@mend/slack";
import { SlackApi, type SlackApiError } from "@mend/slack/client";
import type { SlackEnvelope } from "@mend/slack/socket";
import { SecretCipher, Store } from "@mend/store";
import { Cause, Config, Effect, FiberSet, Layer, Option, Schema, type Fiber } from "effect";
import * as Context from "effect/Context";

import { ProjectAccess } from "./access.ts";
import { SessionStart } from "./session-start.ts";
import { SessionSteering } from "./session-steering.ts";

/**
 * The Slack runner (docs/adr/0006-slack.md): what the worker does with each envelope a Slack
 * socket delivers. It acknowledges first, counts the envelope against its install's ceiling,
 * claims the event once in Postgres, and only then acts. A mention from a linked person starts a
 * session as that person, through `SessionStart`, the same path the web app takes. The sockets
 * themselves are opened by `slack-worker.ts`.
 *
 * A claimed event is done even if the work fails: the failure is posted in the thread, and the
 * event is never replayed.
 */

// ─── The mention, as the runner reads it ────────────────────────────────────

/** A mention, from a Slack event, a picked project, or a link that waited for it. */
export interface SlackMention {
  readonly teamId: string;
  readonly channelId: string;
  /** The mention itself: the message Mend reacts to. */
  readonly messageTs: string;
  /** The thread it sits in; null when the mention is the thread's first message. */
  readonly threadTs: string | null;
  /** Slack markup, as it arrived. */
  readonly text: string;
  readonly slackUserId: string;
  /** The author's own Slack workspace, when Slack names it; another one is Slack Connect. */
  readonly userTeamId: string | null;
  /**
   * Whether the channel is a Slack Connect channel, as the event said; null when nothing said.
   * The thread reporter shows an external channel only status and links, unless the owner opened
   * it, and treats null as external.
   */
  readonly external: boolean | null;
}

/** Where Mend answers a mention: its thread, or the thread the mention starts. */
const replyThreadOf = (mention: SlackMention): string => mention.threadTs ?? mention.messageTs;

/** The request a session answers, as a mention the requester made: for its thread's replies. */
const requestOf = (thread: SlackThreadSession, slackUserId: string): SlackMention => ({
  teamId: thread.teamId,
  channelId: thread.channelId,
  messageTs: thread.requestTs,
  threadTs: thread.threadTs === thread.requestTs ? null : thread.threadTs,
  text: "",
  slackUserId,
  userTeamId: null,
  external: thread.external,
});

const EventCallback = Schema.Struct({
  team_id: Schema.String,
  event_id: Schema.String,
  is_ext_shared_channel: Schema.optional(Schema.Boolean),
  event: Schema.Struct({
    type: Schema.String,
    user: Schema.optional(Schema.String),
    bot_id: Schema.optional(Schema.NullOr(Schema.String)),
    subtype: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    ts: Schema.optional(Schema.String),
    channel: Schema.optional(Schema.String),
    channel_type: Schema.optional(Schema.String),
    thread_ts: Schema.optional(Schema.String),
    team: Schema.optional(Schema.String),
    user_team: Schema.optional(Schema.String),
  }),
});
type SlackEvent = (typeof EventCallback.Type)["event"];

const BlockActions = Schema.Struct({
  type: Schema.Literal("block_actions"),
  team: Schema.Struct({ id: Schema.String }),
  user: Schema.Struct({ id: Schema.String }),
  channel: Schema.optional(Schema.Struct({ id: Schema.String })),
  container: Schema.optional(Schema.Struct({ channel_id: Schema.optional(Schema.String) })),
  actions: Schema.Array(
    Schema.Struct({
      action_id: Schema.String,
      block_id: Schema.optional(Schema.String),
      value: Schema.optional(Schema.String),
      selected_option: Schema.optional(Schema.Struct({ value: Schema.String })),
    }),
  ),
});

const decodeEventCallback = Schema.decodeUnknownOption(EventCallback);
const decodeBlockActions = Schema.decodeUnknownOption(BlockActions);

/**
 * The mention an event carries, or null for one Mend ignores: anything but a mention or a direct
 * message to the app, an edit or a join, a bot's message, Mend's own.
 */
export const mentionOf = (
  install: Pick<SealedSlackInstall, "teamId" | "botUserId">,
  event: SlackEvent,
  external: boolean | null = null,
): SlackMention | null => {
  const direct = event.type === "message" && event.channel_type === "im";
  if (event.type !== "app_mention" && !direct) return null;
  // A message with a subtype is an edit, a join, a bot's post; a shared file is still a message.
  if (event.subtype !== undefined && event.subtype !== "file_share") return null;
  if (event.bot_id !== undefined && event.bot_id !== null) return null;
  if (event.user === undefined || event.user === install.botUserId) return null;
  if (event.ts === undefined || event.channel === undefined) return null;
  return {
    teamId: install.teamId,
    channelId: event.channel,
    messageTs: event.ts,
    threadTs:
      event.thread_ts === undefined || event.thread_ts === event.ts ? null : event.thread_ts,
    text: event.text ?? "",
    slackUserId: event.user,
    userTeamId: event.user_team ?? event.team ?? null,
    external,
  };
};

/**
 * The picker's request key: the thread's first message and the mention, so a click on any worker
 * reads the mention back from Slack instead of from memory. A trailing `/e` marks a channel that
 * is, or may be, a Slack Connect channel: a click does not say. A picker from "Switch project"
 * also names the session the pick stops, as `/s:<session id>`.
 */
export const pickerRequestKey = (
  mention: Pick<SlackMention, "threadTs" | "messageTs" | "external">,
  switchFrom: SessionId | null = null,
): string =>
  `${mention.threadTs ?? mention.messageTs}/${mention.messageTs}${mention.external === false ? "" : "/e"}${switchFrom === null ? "" : `/s:${switchFrom}`}`;

export const parsePickerRequestKey = (
  key: string,
): {
  readonly parentTs: string;
  readonly messageTs: string;
  readonly external: boolean;
  readonly switchFrom: SessionId | null;
} | null => {
  const match = /^(\d+\.\d+)\/(\d+\.\d+)(\/e)?(?:\/s:([A-Za-z0-9_-]{1,64}))?$/.exec(key);
  return match === null || match[1] === undefined || match[2] === undefined
    ? null
    : {
        parentTs: match[1],
        messageTs: match[2],
        external: match[3] !== undefined,
        switchFrom: match[4] === undefined ? null : SessionId.make(match[4]),
      };
};

// ─── Which project a mention runs in ────────────────────────────────────────

type Candidate = Pick<Project, "id" | "name" | "originUrl">;

/** What inference read from the thread: one candidate or none, and the likeliest for the picker. */
export interface InferredProject {
  readonly projectId: ProjectId | null;
  readonly likeliest: ReadonlyArray<ProjectId>;
}

export type ProjectChoice<P extends Candidate> =
  | { readonly kind: "chosen"; readonly project: P; readonly source: SlackProjectSource }
  /** The rules before inference did not answer: ask inference, then choose again with its answer. */
  | { readonly kind: "infer" }
  /** Nothing answered, or several projects did: Mend asks with buttons, and never guesses. */
  | {
      readonly kind: "ask";
      readonly reason: "none" | "several";
      readonly likeliest: ReadonlyArray<P>;
    }
  /** The request named a project, or the person picked one, that is not a candidate here. */
  | { readonly kind: "unknown"; readonly value: string; readonly picked: boolean };

export interface ProjectChoiceInput<P extends Candidate> {
  /** The projects the person may start in here: shared ones only, outside a direct message. */
  readonly candidates: ReadonlyArray<P>;
  /** A project picked from Mend's buttons. */
  readonly picked: ProjectId | null;
  /** `project=` or `in <project>`, as written. */
  readonly named: string | null;
  /** The project of the thread's most recent session. */
  readonly threadSession: ProjectId | null;
  /** The thread's text, the mention included, as plain text. */
  readonly threadText: string;
  /**
   * What inference read from the thread; null when it was not run or could not answer, and
   * `not-asked` before the runner has asked it.
   */
  readonly inferred: InferredProject | null | "not-asked";
  readonly channelDefault: ProjectId | null;
  readonly personalDefault: ProjectId | null;
}

/**
 * The project, from the first rule that answers (docs/adr/0006-slack.md, "Which project a mention
 * runs in"): the message, the thread's session, the repositories the thread links, inference over
 * the thread, the channel default, then the person's default. Every answer is a candidate.
 * Inference costs a model call, so the rules before it are tried first: until the runner has
 * asked (`inferred: "not-asked"`), reaching that step answers `infer`. When nothing answers,
 * Mend asks, with the projects inference found likeliest first.
 */
export const chooseProject = <P extends Candidate>(
  input: ProjectChoiceInput<P>,
): ProjectChoice<P> => {
  const candidate = (id: ProjectId | null): P | null =>
    id === null ? null : (input.candidates.find((project) => project.id === id) ?? null);

  if (input.picked !== null) {
    const picked = candidate(input.picked);
    return picked === null
      ? { kind: "unknown", value: input.picked, picked: true }
      : { kind: "chosen", project: picked, source: "picked" };
  }
  if (input.named !== null) {
    const named = projectsNamedBy(input.named, input.candidates);
    const [only] = named;
    if (named.length === 1 && only !== undefined) {
      return { kind: "chosen", project: only, source: "message" };
    }
    return named.length === 0
      ? { kind: "unknown", value: input.named, picked: false }
      : { kind: "ask", reason: "several", likeliest: named };
  }
  const threadSession = candidate(input.threadSession);
  if (threadSession !== null) {
    return { kind: "chosen", project: threadSession, source: "thread-session" };
  }
  const linked = projectsLinkedIn(input.threadText, input.candidates);
  const [onlyLinked] = linked;
  if (linked.length === 1 && onlyLinked !== undefined) {
    return { kind: "chosen", project: onlyLinked, source: "thread-link" };
  }
  if (linked.length > 1) return { kind: "ask", reason: "several", likeliest: linked };
  if (input.inferred === "not-asked") return { kind: "infer" };
  const inferred = candidate(input.inferred?.projectId ?? null);
  if (inferred !== null) {
    return { kind: "chosen", project: inferred, source: "thread-inference" };
  }
  const channelDefault = candidate(input.channelDefault);
  if (channelDefault !== null) {
    return { kind: "chosen", project: channelDefault, source: "channel-default" };
  }
  const personalDefault = candidate(input.personalDefault);
  if (personalDefault !== null) {
    return { kind: "chosen", project: personalDefault, source: "personal-default" };
  }
  const likeliest = (input.inferred?.likeliest ?? []).flatMap((id) => {
    const project = candidate(id);
    return project === null ? [] : [project];
  });
  return { kind: "ask", reason: "none", likeliest };
};

// ─── What Mend says ─────────────────────────────────────────────────────────

const section = (text: string): SlackMessage => ({
  text,
  blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
});

/** A request Mend did not act on, in the refusal's own words. */
export const notStarted = (reason: string): SlackMessage =>
  section(escapeSlack(`not started · ${reason}`));

export const launchFailed = (reason: string): SlackMessage =>
  section(escapeSlack(`launch failed · ${reason}`));

type StartRefusal = NotFound | StoreFailure | BudgetExceeded;

/**
 * A refusal from `SessionStart`, as the thread reads it. A budget's words are the budget's own. A
 * store failure's message can carry git's stderr and server paths, so the thread reads `stored`,
 * what the step could not do, and the message itself goes only to the requester
 * (`refusalDetail`).
 */
export const refusalWords = (
  error: StartRefusal,
  stored = "Mend could not prepare the session",
): string => {
  switch (error._tag) {
    case "NotFound":
      return "the project is not available to you";
    case "StoreFailure":
      return stored;
    case "BudgetExceeded":
      return error.message;
  }
};

/** What only the requester reads about a refusal, or null when the thread already says it all. */
export const refusalDetail = (error: StartRefusal): string | null =>
  error._tag === "StoreFailure" ? error.message : null;

/**
 * A claimed request whose handling failed unexpectedly: the event is never replayed. It may have
 * failed before or after a session started, so the line says neither.
 */
export const handlingFailed: SlackMessage = section(
  "failed · Mend could not finish handling this request · see the Mend logs",
);

/** The person who clicked a project is no longer linked; nothing was claimed for their click. */
const pickNotLinked = section(
  "not started · this Slack account is no longer linked to Mend · mention Mend again to link it",
);

const unknownProject = (
  choice: { readonly value: string; readonly picked: boolean },
  direct: boolean,
) =>
  `${choice.picked ? "the picked project is not one you can start in here" : `no project you can start in here is named ${choice.value}`}${direct ? "" : " · a channel offers shared projects only"}`;

const notYet = (command: "settings" | "list"): SlackMessage =>
  section(
    command === "settings"
      ? "`settings` is not in this version of Mend yet. Your own default project is in Mend under Settings → Slack."
      : "`list` is not in this version of Mend yet. Your sessions are listed in Mend.",
  );

const emptyRequest = section(
  "The mention has no request, and there is no thread to read. `help` lists what Mend reads.",
);

const onlyRequester = section("Only the person who made the request picks its project.");

const onlySwitcher = section("Only the person who made the request switches its project.");

/** "Switch project" refused, in the reason's own words. */
export const notSwitched = (reason: string): SlackMessage =>
  section(escapeSlack(`not switched · ${reason} · mention Mend again to start another session`));

/** The new session started, and the one it replaces could not be stopped. */
export const earlierNotStopped = section(
  "switched · the earlier session could not be stopped · stop it in Mend",
);

const requestGone = section("The request is no longer in the thread.");

/** A session "Switch project" replaces, checked and still running until its replacement exists. */
interface SwitchedSession {
  readonly thread: SlackThreadSession;
  readonly session: Session;
}

/** The session's state, as the status message words it until the reporter takes over. */
export const slackStateOf = (session: Pick<Session, "status">): SlackSessionState => {
  switch (session.status) {
    case "idle":
      // Right after launch; the reporter reads the turns and the process (slackSessionState).
      return "running";
    default:
      return session.status;
  }
};

/** A Slack write whose failure is logged, never raised: the next step does not depend on it. */
const quietly = <A>(what: string, effect: Effect.Effect<A, SlackApiError>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning(`slack runner: ${what} failed`).pipe(
        Effect.annotateLogs({ method: error.method, code: error.code }),
      ),
    ),
  );

const pickable = (list: ReadonlyArray<Project>) =>
  list.map((project) => ({ id: project.id, name: project.name }));

/** The harnesses Mend checks a connected account for; others run without one. */
const CREDENTIALED_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

// ─── The service ────────────────────────────────────────────────────────────

export class SlackRunner extends Context.Service<
  SlackRunner,
  {
    /**
     * Acknowledge the envelope, count it against its install's ceiling, and hand the work to a
     * fiber of its own; returns once acknowledged. Above the ceiling the envelope is dropped.
     */
    readonly receive: (
      organizationId: OrganizationId,
      envelope: SlackEnvelope,
    ) => Effect.Effect<Fiber.Fiber<void> | null>;
    /** The mention a person made before they linked, run now that they have. */
    readonly runLinked: (job: SlackLinkedMentionJob) => Effect.Effect<void>;
    /** Until every envelope handed off so far is done: for tests and shutdown. */
    readonly idle: Effect.Effect<void>;
  }
>()("@mend/api/SlackRunner") {}

export interface SlackRunnerOptions {
  /** Envelopes one install may deliver per minute, per worker process; 0 turns it off. */
  readonly eventsPerMinute: number;
  /** A linked request older than this is left alone: the thread has moved on. */
  readonly linkedRequestMaxAgeMs: number;
  /**
   * Thread inferences one organization may run per hour, per worker process; 0 turns the ceiling
   * off. Past it, the choice goes on to the defaults and the picker without inference.
   */
  readonly inferencesPerHour: number;
  readonly now?: () => number;
}

export const SLACK_EVENTS_PER_MINUTE = 120;
export const SLACK_INFERENCES_PER_HOUR = 60;
/** A link code lives ten minutes; a request waiting on it is stale a little after. */
export const SLACK_LINKED_REQUEST_MAX_AGE_MS = 15 * 60_000;

export const makeSlackRunner = (options: SlackRunnerOptions) =>
  Effect.gen(function* () {
    const installs = yield* SlackInstallsRepo;
    const links = yield* SlackLinksRepo;
    const defaults = yield* SlackDefaultsRepo;
    const threads = yield* SlackThreadsRepo;
    const claims = yield* SlackEventClaimsRepo;
    const sessions = yield* SessionsRepo;
    const audit = yield* AuditEventsRepo;
    const cipher = yield* SecretCipher;
    const slack = yield* SlackApi;
    const access = yield* ProjectAccess;
    const start = yield* SessionStart;
    const sealant = yield* SealantClients;
    const reader = yield* ThreadProjectReader;
    const store = yield* Store;
    const engine = yield* SessionEngine;
    const steering = yield* SessionSteering;
    const conversations = yield* AgentConversationRepo;
    const controls = yield* SessionControlEventsRepo;
    const now = options.now ?? Date.now;
    const ceiling = makeWindowLimiter();
    const inferenceCeiling = makeWindowLimiter(60 * 60_000);
    const work = yield* FiberSet.make<void>();

    /** The bot token, or null (logged) when it cannot be unsealed. */
    const botTokenOf = (install: SealedSlackInstall) =>
      cipher
        .decrypt(install.sealedBotToken)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("slack runner: bot token not unsealed").pipe(
              Effect.annotateLogs({ organizationId: install.organizationId, cause: error.message }),
              Effect.as(null),
            ),
          ),
        );

    /** A reply only the requester sees, in the mention's thread. */
    const whisper = (token: string, mention: SlackMention, message: SlackMessage) =>
      quietly(
        "chat.postEphemeral",
        slack.postEphemeral(token, {
          channel: mention.channelId,
          user: mention.slackUserId,
          threadTs: replyThreadOf(mention),
          text: message.text,
          blocks: message.blocks,
        }),
      );

    /** A reply in the mention's thread, which everyone in it reads. */
    const say = (token: string, mention: SlackMention, message: SlackMessage) =>
      slack.postMessage(token, {
        channel: mention.channelId,
        threadTs: replyThreadOf(mention),
        text: message.text,
        blocks: message.blocks,
      });

    /** Put `reaction` on the request, and take off the one it replaces. */
    const react = (
      token: string,
      mention: SlackMention,
      reaction: SlackReaction | null,
      replacing: SlackReaction | null = null,
    ) =>
      Effect.gen(function* () {
        const at = { channel: mention.channelId, timestamp: mention.messageTs };
        if (reaction !== null) {
          yield* quietly("reactions.add", slack.reactionsAdd(token, { ...at, name: reaction }));
        }
        if (replacing !== null && replacing !== reaction) {
          yield* quietly(
            "reactions.remove",
            slack.reactionsRemove(token, { ...at, name: replacing }),
          );
        }
      });

    const refuse = (token: string, mention: SlackMention, message: SlackMessage, loud: boolean) =>
      Effect.gen(function* () {
        if (loud) yield* quietly("chat.postMessage", say(token, mention, message));
        else yield* whisper(token, mention, message);
        yield* react(token, mention, reactionFor("refused"));
      });

    /**
     * A refusal from `SessionStart`, in the thread in words that name no path or stderr, and in
     * full only to the requester.
     */
    const refuseStart = (
      token: string,
      mention: SlackMention,
      wording: (reason: string) => SlackMessage,
      error: StartRefusal,
      stored: string,
    ) =>
      Effect.gen(function* () {
        yield* refuse(token, mention, wording(refusalWords(error, stored)), true);
        const detail = refusalDetail(error);
        if (detail !== null) yield* whisper(token, mention, wording(detail));
      });

    /**
     * Past its claim, a request that fails unexpectedly is reported in its thread, as a line that
     * names nothing internal, with ❌ on the request; the cause goes to the log. Best effort: a
     * Slack write that fails here is dropped. An interruption (shutdown) posts nothing.
     */
    const reportingFailure =
      (install: SealedSlackInstall, mention: SlackMention) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | undefined, never, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("slack runner: request handling failed").pipe(
                Effect.annotateLogs({
                  organizationId: install.organizationId,
                  channelId: mention.channelId,
                  messageTs: mention.messageTs,
                  cause: Cause.pretty(cause),
                }),
              );
              if (Cause.hasInterruptsOnly(cause)) return undefined;
              const token = yield* botTokenOf(install);
              if (token === null) return undefined;
              yield* quietly("chat.postMessage", say(token, mention, handlingFailed));
              yield* react(token, mention, reactionFor("failed"), reactionFor("starting"));
              return undefined;
            }).pipe(Effect.catchCause(() => Effect.succeed(undefined))),
          ),
        );

    /**
     * The thread up to the mention, with each author's display name looked up. A name Slack will
     * not give stays null, and the message is quoted under the user id.
     */
    const readThread = (token: string, channel: string, parentTs: string, latest: string) =>
      Effect.gen(function* () {
        const messages = yield* slack.conversationsReplies(token, {
          channel,
          ts: parentTs,
          latest,
        });
        const authors = [
          ...new Set(
            messages.flatMap((message) =>
              message.userId === null || message.isBot ? [] : [message.userId],
            ),
          ),
        ].slice(0, 50);
        const names = new Map<string, string>();
        yield* Effect.forEach(
          authors,
          (userId) =>
            slack.usersInfo(token, userId).pipe(
              Effect.map((user) => void names.set(userId, user.displayName)),
              Effect.ignore,
            ),
          { concurrency: 4, discard: true },
        );
        return messages.map(
          (message): SlackThreadMessage =>
            message.userId !== null && names.has(message.userId)
              ? { ...message, displayName: names.get(message.userId) ?? null }
              : message,
        );
      });

    /**
     * Why the owner cannot run this harness, or null. A harness needs the owner's own connected
     * account named `default`, as the engine asks for it; a platform that does not answer is left
     * to the launch, which reports its own failure.
     */
    const credentialProblem = (userId: string, harness: string) =>
      CREDENTIALED_HARNESSES.has(harness)
        ? sealant
            .connectedAccounts(userId)
            .list()
            .pipe(
              Effect.map((accounts) =>
                accounts.some(
                  (account) =>
                    account.provider === harness &&
                    account.name === "default" &&
                    account.status === "active",
                )
                  ? null
                  : `no active ${harness} account is connected to your Mend account · connect one in Mend under Settings → Connected accounts`,
              ),
              Effect.catch(() => Effect.succeed(null)),
            )
        : Effect.succeed(null);

    /**
     * The projects a person may start in here (docs/adr/0006-slack.md): the ones they can see,
     * and in a channel only the shared ones, since everyone in it reads what Mend posts.
     */
    const candidatesFor = (userId: string, channelId: string) =>
      access
        .visibleProjectsOf(userId)
        .pipe(
          Effect.map((visible) =>
            isDirectMessage(channelId)
              ? visible
              : visible.filter((project) => project.visibility === "shared"),
          ),
        );

    /**
     * Ask inference which candidate the thread is about, as the requester, on their subscription
     * and within their organization's hourly ceiling. Each candidate is described by its name,
     * origin, default branch and the root of that branch's tree; no code is sent. A failure is
     * logged and answers nothing, so the choice goes on to the defaults and the picker.
     */
    const inferProject = (
      install: SealedSlackInstall,
      userId: string,
      candidates: ReadonlyArray<Project>,
      parsed: ParsedMention,
      context: ThreadContext,
    ) =>
      Effect.gen(function* () {
        if (candidates.length === 0) return NO_THREAD_PROJECT;
        const over = inferenceCeiling.take(
          install.organizationId,
          options.inferencesPerHour,
          now(),
        );
        if (over !== null) {
          yield* Effect.logWarning(
            "slack runner: over the organization's thread inferences per hour, skipped",
          ).pipe(Effect.annotateLogs({ organizationId: install.organizationId }));
          return NO_THREAD_PROJECT;
        }
        const shown = candidates
          .toSorted((a, b) => a.name.localeCompare(b.name))
          .slice(0, THREAD_PROJECT_CANDIDATE_LIMIT);
        const described = yield* Effect.forEach(
          shown,
          (project) =>
            store
              .listTopLevel(project.storePath, project.defaultBranch, THREAD_PROJECT_ENTRY_LIMIT)
              .pipe(
                Effect.map((listing) => listing.files),
                Effect.catch(() => Effect.succeed([])),
                Effect.map((topLevel) => ({
                  id: project.id,
                  name: project.name,
                  originUrl: project.originUrl,
                  defaultBranch: project.defaultBranch,
                  topLevel,
                })),
              ),
          { concurrency: 4 },
        );
        const { harness, model, effort, branch } = parsed.options;
        return yield* reader
          .read({
            request: parsed.prompt,
            thread: context.messages.map((message) => ({
              author: message.author,
              text: message.text,
            })),
            candidates: described,
            settled: {
              // A model the request named belongs to the harness the session runs.
              harness: harness?.value ?? (model === null ? null : install.settings.defaultHarness),
              model: model !== null,
              effort: effort !== null,
              branch: branch !== null,
            },
            harnesses: Object.fromEntries(
              DEFAULT_MENTION_VOCABULARY.harnesses.map((name) => [
                name,
                DEFAULT_MENTION_VOCABULARY.models[name] ?? [],
              ]),
            ),
          })
          .pipe(
            asSealantUser(userId),
            Effect.catch((error) =>
              Effect.logWarning("slack runner: thread inference failed").pipe(
                Effect.annotateLogs({
                  organizationId: install.organizationId,
                  cause: error.message,
                }),
                Effect.as(NO_THREAD_PROJECT),
              ),
            ),
          );
      });

    /**
     * Why "Switch project" is no longer offered for a session, or null while it is: only until
     * its first turn completes, and not once it is stopped.
     */
    const switchRefusal = (thread: SlackThreadSession) =>
      Effect.gen(function* () {
        if (thread.reportedState === "stopped") return "the session is stopped";
        const turns = yield* conversations.listTurns(thread.sessionId);
        return switchOffered(thread.reportedState ?? "starting", turns)
          ? null
          : "the session's first turn has completed";
      });

    /**
     * "Switch project" on a status message: the requester gets a picker of the other projects
     * they can start in here. The pick stops the session and restarts the request (`onInteraction`).
     */
    const offerSwitch = Effect.fn("SlackRunner.offerSwitch")(function* (
      install: SealedSlackInstall,
      token: string,
      channel: string,
      slackUserId: string,
      sessionId: SessionId,
    ) {
      const thread = yield* threads.forSession(sessionId);
      if (thread === null || thread.teamId !== install.teamId || thread.channelId !== channel) {
        return;
      }
      const request = requestOf(thread, slackUserId);
      if (thread.slackUserId !== slackUserId) return yield* whisper(token, request, onlySwitcher);
      const refusal = yield* switchRefusal(thread);
      if (refusal !== null) return yield* whisper(token, request, notSwitched(refusal));
      const link = yield* links.bySlackUser(install.teamId, slackUserId);
      if (link === null) return;
      const session = yield* sessions
        .byId(sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (session === null) return;
      const others = (yield* candidatesFor(link.userId, channel)).filter(
        (project) => project.id !== session.projectId,
      );
      yield* whisper(
        token,
        request,
        projectPicker({
          requestKey: pickerRequestKey(request, sessionId),
          reason: "switch",
          likeliest: pickable(others),
          all: pickable(others),
        }),
      );
    });

    /**
     * The session a switch replaces, when the requester may still switch it: the same thread and
     * request, before its first turn completes, and through the same steering check as the web
     * app. Null, after saying why, when not. Nothing is stopped here: the session keeps running
     * until its replacement has been created (`stopSwitched`).
     */
    const switchable = Effect.fn("SlackRunner.switchable")(function* (
      install: SealedSlackInstall,
      token: string,
      mention: SlackMention,
      userId: string,
      sessionId: SessionId,
    ) {
      const thread = yield* threads.forSession(sessionId);
      if (
        thread === null ||
        thread.teamId !== install.teamId ||
        thread.channelId !== mention.channelId ||
        thread.requestTs !== mention.messageTs ||
        thread.slackUserId !== mention.slackUserId
      ) {
        yield* whisper(token, mention, requestGone);
        return null;
      }
      const refusal = yield* switchRefusal(thread);
      if (refusal !== null) {
        yield* whisper(token, mention, notSwitched(refusal));
        return null;
      }
      const session = yield* sessions
        .byId(sessionId)
        .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)));
      if (session === null) {
        yield* whisper(token, mention, requestGone);
        return null;
      }
      const allowed = yield* steering.authorizeUser(session, userId).pipe(Effect.result);
      if (allowed._tag === "Failure") {
        yield* whisper(
          token,
          mention,
          notSwitched(
            allowed.failure._tag === "NotFound"
              ? "the session is not available to you"
              : allowed.failure.message,
          ),
        );
        return null;
      }
      return { thread, session } satisfies SwitchedSession;
    });

    /**
     * Stop the session a switch replaced, once its replacement exists, as the requester, and show
     * it stopped. The stop is recorded as a control event only when the engine stopped it; when it
     * could not, the requester is told, and the thread is left as it reads. The status message
     * moves by the reporter's own compare-and-set, so the reporter finds `stopped` already shown
     * and leaves the request's reaction to the session that replaces it.
     */
    const stopSwitched = Effect.fn("SlackRunner.stopSwitched")(function* (
      install: SealedSlackInstall,
      token: string,
      mention: SlackMention,
      userId: string,
      { thread, session }: SwitchedSession,
    ) {
      const stoppedByEngine = yield* engine.stop(session.id).pipe(Effect.exit);
      if (stoppedByEngine._tag === "Failure") {
        yield* Effect.logWarning("slack runner: the switched session was not stopped").pipe(
          Effect.annotateLogs({ sessionId: session.id, cause: String(stoppedByEngine.cause) }),
        );
        return yield* whisper(token, mention, earlierNotStopped);
      }
      yield* controls.record({
        sessionId: session.id,
        actorUserId: userId,
        kind: "stop",
        refId: null,
      });

      const project = yield* access
        .projectAs(userId, session.projectId)
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));
      const stopped = statusMessage({
        project: project?.name ?? session.projectId,
        source: thread.projectSource,
        harness: session.harness,
        branch: session.branch,
        state: "stopped",
        recorded: session.sealantRunId !== null,
        change: null,
        url: sessionUrl(install.webOrigin, session.id),
      });
      // The reporter may be moving the message too: claim from what it shows, a few times over.
      let shown = (yield* threads.forSession(session.id)) ?? thread;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (shown.statusTs === null || shown.reportedState === "stopped") break;
        const moved = yield* threads.claimStatus(session.id, shown.reportedStatus, {
          state: "stopped",
          line: stopped.text,
        });
        if (moved) {
          yield* quietly(
            "chat.update",
            slack.update(token, { channel: thread.channelId, ts: shown.statusTs, ...stopped }),
          );
          yield* react(token, mention, null, reactionFor(shown.reportedState ?? "starting"));
          break;
        }
        const again = yield* threads.forSession(session.id);
        if (again === null) break;
        shown = again;
      }
    });

    /** Start a session for a linked person, or say why not. */
    const startFor = Effect.fn("SlackRunner.startFor")(function* (
      install: SealedSlackInstall,
      token: string,
      mention: SlackMention,
      userId: string,
      picked: ProjectId | null,
      /**
       * The session this one replaces, when the requester switched its project. It is stopped
       * only once this one is created: every check before that leaves it running.
       */
      replacing: SwitchedSession | null = null,
    ) {
      const direct = isDirectMessage(mention.channelId);
      const candidates = yield* candidatesFor(userId, mention.channelId);
      const parsed = parseMention(mention.text, install.botUserId, {
        ...DEFAULT_MENTION_VOCABULARY,
        projects: candidates,
      });
      if (parsed.rejected.length > 0) {
        const reasons = parsed.rejected.map(
          (rejected) => `${rejected.option}=${rejected.value} · ${rejected.reason}`,
        );
        return yield* refuse(token, mention, notStarted(reasons.join("; ")), false);
      }

      const thread =
        mention.threadTs === null
          ? Option.some<ReadonlyArray<SlackThreadMessage>>([])
          : yield* readThread(token, mention.channelId, mention.threadTs, mention.messageTs).pipe(
              Effect.map(Option.some),
              Effect.catch((error) =>
                refuse(
                  token,
                  mention,
                  notStarted(`the thread could not be read · ${error.code}`),
                  true,
                ).pipe(Effect.as(Option.none())),
              ),
            );
      if (Option.isNone(thread)) return;
      const context = threadContext(thread.value, {
        teamId: install.teamId,
        botUserId: install.botUserId,
        mentionTs: mention.messageTs,
      });
      if (parsed.prompt === "" && context.messages.length === 0) {
        return yield* whisper(token, mention, emptyRequest);
      }

      const threadSession =
        mention.threadTs === null
          ? null
          : yield* threads.latestInThread({
              teamId: install.teamId,
              channelId: mention.channelId,
              threadTs: mention.threadTs,
            });
      const threadSessionProject =
        threadSession === null
          ? null
          : yield* sessions.byId(threadSession.sessionId).pipe(
              Effect.map((session) => session.projectId),
              Effect.catchTag("SessionNotFoundError", () => Effect.succeed(null)),
            );
      const names = (id: string) => (id === install.botUserId ? "mend" : undefined);
      const choiceInput = {
        candidates,
        picked,
        named: parsed.options.project?.value ?? null,
        threadSession: threadSessionProject,
        threadText: [...thread.value.map((message) => message.text), mention.text]
          .map((text) => slackToPlain(text, names))
          .join("\n"),
        channelDefault:
          (yield* defaults.channelDefault(install.teamId, mention.channelId))?.projectId ?? null,
        personalDefault: yield* defaults.personalDefault(userId),
      };
      const first = chooseProject({ ...choiceInput, inferred: "not-asked" });
      // Inference runs only when the message, the thread's session and its links left the
      // choice open, and it also reads the natural options the parser left in the request.
      const inference =
        first.kind === "infer"
          ? yield* inferProject(install, userId, candidates, parsed, context)
          : NO_THREAD_PROJECT;
      const choice =
        first.kind === "infer"
          ? chooseProject({
              ...choiceInput,
              inferred: {
                projectId:
                  inference.projectId === null ? null : ProjectId.make(inference.projectId),
                likeliest: inference.likeliest.map((id) => ProjectId.make(id)),
              },
            })
          : first;
      if (choice.kind === "unknown") {
        return yield* refuse(token, mention, notStarted(unknownProject(choice, direct)), false);
      }
      if (choice.kind === "ask" || choice.kind === "infer") {
        const likeliest = choice.kind === "ask" ? choice.likeliest : [];
        const rest = candidates.filter((project) => !likeliest.includes(project));
        return yield* whisper(
          token,
          mention,
          projectPicker({
            requestKey: pickerRequestKey(mention),
            reason: choice.kind === "ask" ? choice.reason : "none",
            likeliest: pickable(likeliest.length > 0 ? likeliest : candidates),
            all: pickable([...likeliest, ...rest]),
          }),
        );
      }

      // What the request said wins over what inference read in it.
      const chosen: ThreadProjectOptions = {
        harness: parsed.options.harness?.value ?? inference.options.harness,
        model: parsed.options.model?.value ?? inference.options.model,
        effort: parsed.options.effort?.value ?? inference.options.effort,
        branch: parsed.options.branch?.value ?? inference.options.branch,
      };
      const harness = chosen.harness ?? install.settings.defaultHarness;
      const noCredential = yield* credentialProblem(userId, harness);
      if (noCredential !== null) {
        return yield* refuse(token, mention, notStarted(noCredential), true);
      }

      // Provision first, then launch: the thread hears about the session while its workspace
      // builds, which takes minutes. Both halves are SessionStart's, with its checks.
      const created = yield* start
        .createAs(userId, choice.project.id, {
          harness,
          label: null,
          name: null,
          base: chosen.branch,
          origin: "slack",
        })
        .pipe(Effect.result);
      if (created._tag === "Failure") {
        return yield* refuseStart(
          token,
          mention,
          notStarted,
          created.failure,
          "the worktree could not be created",
        );
      }
      const session = created.success;
      if (replacing !== null) yield* stopSwitched(install, token, mention, userId, replacing);
      yield* threads.record({
        sessionId: session.id,
        teamId: install.teamId,
        channelId: mention.channelId,
        threadTs: replyThreadOf(mention),
        requestTs: mention.messageTs,
        slackUserId: mention.slackUserId,
        projectSource: choice.source,
        external: mention.external !== false,
      });
      yield* audit.record({
        organizationId: choice.project.organizationId,
        actorUserId: userId,
        action: "slack.session_started",
        subjectType: "session",
        subjectId: session.id,
        data: {
          teamId: install.teamId,
          channelId: mention.channelId,
          messageTs: mention.messageTs,
          slackUserId: mention.slackUserId,
          projectId: choice.project.id,
          projectName: choice.project.name,
          projectSource: choice.source,
          ...(replacing === null ? {} : { switchedFrom: replacing.session.id }),
        },
      });
      yield* react(token, mention, reactionFor("starting"));
      // The status message is the reporter's once posted: every move after the first goes
      // through the same compare-and-set, so a launch that ends here and the reporter's next
      // event cannot both write it.
      const status = (state: SlackSessionState, current: Session) =>
        statusMessage({
          project: choice.project.name,
          source: choice.source,
          harness,
          branch: current.branch,
          state,
          recorded: current.sealantRunId !== null,
          change: null,
          url: sessionUrl(install.webOrigin, current.id),
          switchSession: switchOffered(state, []) ? current.id : null,
        });
      const shown = status("starting", session);
      const posted = yield* say(token, mention, shown).pipe(
        Effect.map((message) => message.ts),
        Effect.catch((error) =>
          Effect.logWarning("slack runner: status message not posted").pipe(
            Effect.annotateLogs({ code: error.code }),
            Effect.as(null),
          ),
        ),
      );
      if (posted !== null) {
        yield* threads.setStatusTs(session.id, posted, { state: "starting", line: shown.text });
      }
      /** Move the status message on from `starting`, unless the reporter already has. */
      const updateStatus = (state: SlackSessionState, current: Session) =>
        Effect.gen(function* () {
          if (posted === null) return false;
          const next = status(state, current);
          const moved = yield* threads.claimStatus(session.id, shown.text, {
            state,
            line: next.text,
          });
          if (moved) {
            yield* quietly(
              "chat.update",
              slack.update(token, { channel: mention.channelId, ts: posted, ...next }),
            );
          }
          return moved;
        });

      const opening = renderOpeningTurn({
        prompt: parsed.prompt,
        context,
        requesterUserId: mention.slackUserId,
      });
      const launched = yield* start
        .launchAs(
          userId,
          session,
          new LaunchRequest({
            mode: "protocol",
            prompt: opening,
            ...(chosen.model === null ? {} : { model: chosen.model }),
            ...(chosen.effort === null ? {} : { effort: chosen.effort }),
          }),
        )
        .pipe(Effect.result);
      if (launched._tag === "Failure") {
        yield* quietly(
          "chat.postMessage",
          say(
            token,
            mention,
            launchFailed(refusalWords(launched.failure, "the session could not be launched")),
          ),
        );
        const detail = refusalDetail(launched.failure);
        if (detail !== null) yield* whisper(token, mention, launchFailed(detail));
        yield* react(token, mention, reactionFor("failed"), reactionFor("starting"));
        yield* updateStatus("failed", session);
        return;
      }
      yield* updateStatus(slackStateOf(launched.success), launched.success);
    });

    /**
     * A mention, read from the top: an outsider is refused, `help` is answered for anyone, an
     * unlinked person gets a link, and a linked one gets a session. `linkedUserId` is set when
     * the mention waited for a link, and it must still be that person's link.
     */
    const runMention = Effect.fn("SlackRunner.runMention")(function* (
      install: SealedSlackInstall,
      mention: SlackMention,
      linkedUserId: string | null,
    ) {
      const token = yield* botTokenOf(install);
      if (token === null) return;
      if (mention.userTeamId !== null && mention.userTeamId !== install.teamId) {
        return yield* whisper(token, mention, outsiderMessage(install.teamName));
      }
      const { command } = parseMention(mention.text, install.botUserId);
      if (command === "help") {
        const bot = yield* slack.usersInfo(token, install.botUserId).pipe(Effect.option);
        return yield* whisper(
          token,
          mention,
          helpMessage({
            botName: Option.isSome(bot) ? bot.value.name : "mend",
            harnesses: DEFAULT_MENTION_VOCABULARY.harnesses,
          }),
        );
      }
      const link = yield* links.bySlackUser(install.teamId, mention.slackUserId);
      if (linkedUserId !== null && link?.userId !== linkedUserId) return;
      if (link === null) {
        const { code } = yield* links.mintCode({
          teamId: install.teamId,
          slackUserId: mention.slackUserId,
          request: {
            channelId: mention.channelId,
            messageTs: mention.messageTs,
            threadTs: mention.threadTs,
            text: mention.text,
            ...(mention.external === null ? {} : { external: mention.external }),
          },
        });
        return yield* whisper(token, mention, linkPrompt(linkUrl(install.webOrigin, code)));
      }
      // Follow-ups to the thread's session, answers and resume arrive in PR 9. Until then a
      // mention in a thread with a session starts another one in the same project.
      if (command === "settings" || command === "list") {
        return yield* whisper(token, mention, notYet(command));
      }
      yield* startFor(install, token, mention, link.userId, null);
    });

    /** Past the claim, or the redeemed link code, a failure is the thread's to hear about. */
    const runClaimed = (
      install: SealedSlackInstall,
      mention: SlackMention,
      linkedUserId: string | null,
    ) => runMention(install, mention, linkedUserId).pipe(reportingFailure(install, mention));

    const onEvent = Effect.fn("SlackRunner.onEvent")(function* (
      install: SealedSlackInstall,
      body: unknown,
    ) {
      const callback = decodeEventCallback(body);
      if (Option.isNone(callback) || callback.value.team_id !== install.teamId) return;
      const claimed = yield* claims.claim({
        eventId: callback.value.event_id,
        teamId: install.teamId,
      });
      if (!claimed) return;
      const mention = mentionOf(
        install,
        callback.value.event,
        callback.value.is_ext_shared_channel ?? null,
      );
      if (mention === null) return;
      // A message can arrive as two events (a mention and a direct message); one of them acts.
      const first = yield* claims.claim({
        eventId: `message:${install.teamId}:${mention.channelId}:${mention.messageTs}`,
        teamId: install.teamId,
      });
      if (!first) return;
      yield* runClaimed(install, mention, null);
    });

    const onInteraction = Effect.fn("SlackRunner.onInteraction")(function* (
      install: SealedSlackInstall,
      body: unknown,
    ) {
      const decoded = decodeBlockActions(body);
      if (Option.isNone(decoded) || decoded.value.team.id !== install.teamId) return;
      const payload = decoded.value;
      const [action] = payload.actions;
      // "Open in Mend", "Review in Mend" and "Link your Mend account" are links: the
      // acknowledgement is all.
      if (action === undefined) return;
      const channel = payload.channel?.id ?? payload.container?.channel_id;
      if (action.action_id === SLACK_ACTIONS.switchProject) {
        if (action.value === undefined || channel === undefined) return;
        const token = yield* botTokenOf(install);
        if (token === null) return;
        return yield* offerSwitch(
          install,
          token,
          channel,
          payload.user.id,
          SessionId.make(action.value),
        );
      }
      const picking =
        action.action_id === SLACK_ACTIONS.otherProject ||
        action.action_id.startsWith(SLACK_ACTIONS.pickProject);
      if (!picking) return;
      const key = parsePickerRequestKey(requestKeyOfPicker(action.block_id ?? "") ?? "");
      const projectId = action.value ?? action.selected_option?.value;
      if (key === null || projectId === undefined || channel === undefined) return;
      const token = yield* botTokenOf(install);
      if (token === null) return;
      const clicker: SlackMention = {
        teamId: install.teamId,
        channelId: channel,
        messageTs: key.messageTs,
        threadTs: key.parentTs === key.messageTs ? null : key.parentTs,
        text: "",
        slackUserId: payload.user.id,
        userTeamId: null,
        external: key.external,
      };
      const request = yield* slack
        .conversationsReplies(token, { channel, ts: key.parentTs, latest: key.messageTs })
        .pipe(
          Effect.map((messages) => messages.find((message) => message.ts === key.messageTs)),
          Effect.catch(() => Effect.succeed(undefined)),
        );
      if (request === undefined || request.userId === null) {
        return yield* whisper(token, clicker, requestGone);
      }
      if (request.userId !== payload.user.id) return yield* whisper(token, clicker, onlyRequester);
      // The link before the claim: a click from someone unlinked since leaves the pick open.
      const link = yield* links.bySlackUser(install.teamId, payload.user.id);
      if (link === null) return yield* whisper(token, clicker, pickNotLinked);
      // One pick per request, and one switch per session, however many clicks or workers.
      const first = yield* claims.claim({
        eventId:
          key.switchFrom === null
            ? `pick:${install.teamId}:${channel}:${key.messageTs}`
            : `switch:${install.teamId}:${key.switchFrom}`,
        teamId: install.teamId,
      });
      if (!first) return;
      const mention = { ...clicker, text: request.text, userTeamId: request.teamId };
      yield* Effect.gen(function* () {
        // A switch checks the session it replaces first; it is stopped only once the new one
        // exists, so a refusal on the way leaves the requester with the session they had.
        const replacing =
          key.switchFrom === null
            ? null
            : yield* switchable(install, token, mention, link.userId, key.switchFrom);
        if (key.switchFrom !== null && replacing === null) return;
        yield* startFor(install, token, mention, link.userId, ProjectId.make(projectId), replacing);
      }).pipe(reportingFailure(install, mention));
    });

    const handle = (organizationId: OrganizationId, envelope: SlackEnvelope) =>
      Effect.gen(function* () {
        const install = yield* installs.byOrganization(organizationId);
        if (install === null) return;
        if (envelope.type === "events_api") return yield* onEvent(install, envelope.body);
        if (envelope.type === "interactive") return yield* onInteraction(install, envelope.body);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("slack runner: envelope handling failed").pipe(
            Effect.annotateLogs({
              organizationId,
              envelopeId: envelope.envelopeId,
              cause: String(cause),
            }),
          ),
        ),
      );

    const receive = Effect.fn("SlackRunner.receive")(function* (
      organizationId: OrganizationId,
      envelope: SlackEnvelope,
    ) {
      // Before anything else: an envelope Slack does not hear back about is delivered again.
      yield* envelope.ack;
      const wait = ceiling.take(organizationId, options.eventsPerMinute, now());
      if (wait !== null) {
        yield* Effect.logWarning(
          "slack runner: over the install's events per minute, dropped",
        ).pipe(Effect.annotateLogs({ organizationId, envelopeId: envelope.envelopeId }));
        return null;
      }
      return yield* FiberSet.run(work, handle(organizationId, envelope));
    });

    const runLinked = Effect.fn("SlackRunner.runLinked")(function* (job: SlackLinkedMentionJob) {
      const age = now() - Date.parse(job.linkedAt);
      if (!(age <= options.linkedRequestMaxAgeMs)) {
        return yield* Effect.logInfo("slack runner: linked request is stale, left alone").pipe(
          Effect.annotateLogs({ teamId: job.teamId, messageTs: job.request.messageTs }),
        );
      }
      const install = yield* installs.byTeam(job.teamId);
      if (install === null || install.organizationId !== job.organizationId) return;
      yield* runClaimed(
        install,
        {
          teamId: job.teamId,
          channelId: job.request.channelId,
          messageTs: job.request.messageTs,
          threadTs: job.request.threadTs,
          text: job.request.text,
          slackUserId: job.slackUserId,
          // The outsider check ran before the code was minted.
          userTeamId: null,
          external: job.request.external ?? null,
        },
        job.userId,
      );
    });

    return { receive, runLinked, idle: FiberSet.awaitEmpty(work) };
  });

const runnerOptions = Config.all({
  eventsPerMinute: Config.int("MEND_SLACK_EVENTS_PER_MINUTE").pipe(
    Config.withDefault(SLACK_EVENTS_PER_MINUTE),
  ),
  linkedRequestMaxAgeMs: Config.succeed(SLACK_LINKED_REQUEST_MAX_AGE_MS),
  inferencesPerHour: Config.int("MEND_SLACK_INFERENCES_PER_HOUR").pipe(
    Config.withDefault(SLACK_INFERENCES_PER_HOUR),
  ),
});

export const SlackRunnerLive: Layer.Layer<
  SlackRunner,
  Config.ConfigError,
  | AgentConversationRepo
  | AuditEventsRepo
  | ProjectAccess
  | SealantClients
  | SecretCipher
  | SessionControlEventsRepo
  | SessionEngine
  | SessionStart
  | SessionSteering
  | SessionsRepo
  | SlackApi
  | SlackDefaultsRepo
  | SlackEventClaimsRepo
  | SlackInstallsRepo
  | SlackLinksRepo
  | SlackThreadsRepo
  | Store
  | ThreadProjectReader
> = Layer.effect(
  SlackRunner,
  Effect.gen(function* () {
    return yield* makeSlackRunner(yield* runnerOptions);
  }),
);
