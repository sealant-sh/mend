import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from "@slack/web-api";
import { Effect, Layer, Option, Schema } from "effect";
import * as Context from "effect/Context";

import type { SlackBlock } from "./blocks.ts";
import type { SlackThreadMessage } from "./thread.ts";

/**
 * The Slack Web API calls Mend makes (docs/adr/0006-slack.md), behind a service so the routes, the
 * runner and the reporter never hold an SDK client and tests never need a token. Every call takes
 * the token it runs as: one process serves every organization's install.
 *
 * The root export of `@mend/slack` stays pure; this module is its only side-effecting part.
 */

/**
 * A call Slack refused, or one that never reached it. `code` is Slack's own error string
 * (`invalid_auth`, `channel_not_found`, …) when Slack answered, `ratelimited`, `http_<status>`
 * or `request_failed` when it did not, and `not_slack_host` or `too_large` for a download Mend
 * refused itself. Never carries a token.
 */
export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()("SlackApiError", {
  method: Schema.String,
  code: Schema.String,
  message: Schema.String,
}) {}

/** Slack's answers that mean the token itself is no good, as opposed to the call. */
export const SLACK_TOKEN_REFUSALS: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "not_allowed_token_type",
  "invalid_token",
]);

/** Who a token is, from `auth.test`. */
export interface SlackAuthIdentity {
  readonly teamId: string;
  readonly teamName: string;
  /** The bot user for a bot token. */
  readonly userId: string;
  readonly botId: string | null;
  /** Present on some answers only; `botsInfo` has it otherwise. */
  readonly appId: string | null;
  readonly enterpriseId: string | null;
}

/** An app-level token's socket URL, from `apps.connections.open`, and the app it names. */
export interface SlackConnection {
  readonly url: string;
  /** The `app_id` query parameter Slack puts on the URL; null when it is absent. */
  readonly appId: string | null;
}

export interface SlackBotInfo {
  readonly botId: string;
  readonly appId: string | null;
  readonly name: string;
}

/** A Slack user as a person's name and workspace, from `users.info`. */
export interface SlackUserInfo {
  readonly id: string;
  readonly teamId: string | null;
  /** The handle (`name`). */
  readonly name: string;
  /** The display name, or the real name when there is none, or the handle. */
  readonly displayName: string;
  readonly realName: string | null;
  readonly isBot: boolean;
  readonly deleted: boolean;
}

export interface SlackPostInput {
  readonly channel: string;
  /** Reply in this thread; absent posts to the channel. */
  readonly threadTs?: string;
  readonly text: string;
  readonly blocks?: ReadonlyArray<SlackBlock>;
}

export interface SlackEphemeralInput extends SlackPostInput {
  /** The one user who sees it. */
  readonly user: string;
}

export interface SlackUpdateInput {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly blocks?: ReadonlyArray<SlackBlock>;
}

export interface SlackReactionInput {
  readonly channel: string;
  /** The message reacted to. */
  readonly timestamp: string;
  /** Without colons: `white_check_mark`. */
  readonly name: string;
}

export interface SlackRepliesInput {
  readonly channel: string;
  /** The thread's parent message. */
  readonly ts: string;
  /** Stop at this message, inclusive: the mention being read. */
  readonly latest?: string;
  /** The most messages read, across pages; defaults to `SLACK_REPLIES_MAX`. */
  readonly max?: number;
}

export interface SlackDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

/** Enough of any thread for the fifty messages the session receives. */
export const SLACK_REPLIES_MAX = 1_000;

export class SlackApi extends Context.Service<
  SlackApi,
  {
    readonly authTest: (token: string) => Effect.Effect<SlackAuthIdentity, SlackApiError>;
    /** Checks an app-level token (`xapp-`). The URL is not opened. */
    readonly appsConnectionsOpen: (
      appToken: string,
    ) => Effect.Effect<SlackConnection, SlackApiError>;
    readonly botsInfo: (token: string, botId: string) => Effect.Effect<SlackBotInfo, SlackApiError>;
    readonly postMessage: (
      token: string,
      input: SlackPostInput,
    ) => Effect.Effect<{ readonly channel: string; readonly ts: string }, SlackApiError>;
    readonly postEphemeral: (
      token: string,
      input: SlackEphemeralInput,
    ) => Effect.Effect<{ readonly messageTs: string }, SlackApiError>;
    readonly update: (
      token: string,
      input: SlackUpdateInput,
    ) => Effect.Effect<{ readonly channel: string; readonly ts: string }, SlackApiError>;
    /** A reaction already there is not an error. */
    readonly reactionsAdd: (
      token: string,
      input: SlackReactionInput,
    ) => Effect.Effect<void, SlackApiError>;
    /** A reaction already gone is not an error. */
    readonly reactionsRemove: (
      token: string,
      input: SlackReactionInput,
    ) => Effect.Effect<void, SlackApiError>;
    /**
     * A thread's messages, oldest first, across pages. Names are not looked up: `displayName` is
     * null, for the caller to fill from `usersInfo`.
     */
    readonly conversationsReplies: (
      token: string,
      input: SlackRepliesInput,
    ) => Effect.Effect<ReadonlyArray<SlackThreadMessage>, SlackApiError>;
    readonly usersInfo: (
      token: string,
      user: string,
    ) => Effect.Effect<SlackUserInfo, SlackApiError>;
    /**
     * A file's bytes (`url_private`), fetched with the bot token. Only an `https` URL on a
     * `slack.com` host is fetched, so the token never goes anywhere else.
     */
    readonly filesDownload: (
      token: string,
      url: string,
      options: { readonly maxBytes: number },
    ) => Effect.Effect<SlackDownload, SlackApiError>;
  }
>()("@mend/slack/SlackApi") {}

// ─── Decoding what Slack answers ───────────────────────────────────────────

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const AuthTestResult = Schema.Struct({
  team_id: Schema.String,
  team: Schema.String,
  user_id: Schema.String,
  bot_id: OptionalString,
  app_id: OptionalString,
  enterprise_id: OptionalString,
});

const ConnectionsOpenResult = Schema.Struct({ url: Schema.String });

const BotsInfoResult = Schema.Struct({
  bot: Schema.Struct({ id: Schema.String, app_id: OptionalString, name: Schema.String }),
});

const PostResult = Schema.Struct({ channel: Schema.String, ts: Schema.String });

const EphemeralResult = Schema.Struct({ message_ts: Schema.String });

const RepliesResult = Schema.Struct({
  messages: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ts: Schema.String,
        user: OptionalString,
        user_team: OptionalString,
        team: OptionalString,
        bot_id: OptionalString,
        subtype: OptionalString,
        text: OptionalString,
        files: Schema.optional(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              name: OptionalString,
              mimetype: OptionalString,
              url_private: OptionalString,
            }),
          ),
        ),
      }),
    ),
  ),
  has_more: Schema.optional(Schema.Boolean),
  response_metadata: Schema.optional(Schema.Struct({ next_cursor: OptionalString })),
});

const UsersInfoResult = Schema.Struct({
  user: Schema.Struct({
    id: Schema.String,
    team_id: OptionalString,
    name: Schema.String,
    real_name: OptionalString,
    is_bot: Schema.optional(Schema.Boolean),
    deleted: Schema.optional(Schema.Boolean),
    profile: Schema.optional(
      Schema.Struct({ display_name: OptionalString, real_name: OptionalString }),
    ),
  }),
});

const present = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value === "" ? null : value;

/** An SDK failure as Mend reports it: Slack's code when it answered, never the request. */
export const slackApiError = (method: string, cause: unknown): SlackApiError => {
  if (cause instanceof WebAPIPlatformError) {
    return new SlackApiError({ method, code: cause.data.error, message: cause.message });
  }
  if (cause instanceof WebAPIRateLimitedError) {
    return new SlackApiError({ method, code: "ratelimited", message: cause.message });
  }
  if (cause instanceof WebAPIHTTPError) {
    return new SlackApiError({ method, code: `http_${cause.statusCode}`, message: cause.message });
  }
  if (cause instanceof WebAPIRequestError) {
    return new SlackApiError({ method, code: "request_failed", message: cause.original.message });
  }
  return new SlackApiError({
    method,
    code: "request_failed",
    message: cause instanceof Error ? cause.message : String(cause),
  });
};

/** The one host family the bot token is ever sent to. */
export const isSlackFileUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "slack.com" || parsed.hostname.endsWith(".slack.com"))
    );
  } catch {
    return false;
  }
};

/** Tolerate the one error that means the call's work is already done. */
const settled = (effect: Effect.Effect<unknown, SlackApiError>, done: string) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error) => error.code === done,
      () => Effect.void,
    ),
  );

/** A message's fields under Slack's names. */
const message = (input: SlackPostInput | SlackUpdateInput): Record<string, unknown> => ({
  channel: input.channel,
  text: input.text,
  ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
  ...("threadTs" in input && input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}),
});

export interface SlackApiOptions {
  /** The transport; `globalThis.fetch` by default. Tests pass a fake. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per request, in milliseconds. */
  readonly timeoutMs?: number;
}

/**
 * The live implementation over `@slack/web-api`: its transport, rate-limit waits and a short
 * retry. A request a person is waiting on (Settings → Slack) must not sit in the SDK's default
 * half-hour retry, so retries stay few.
 */
export const makeSlackApi = (options: SlackApiOptions = {}): SlackApi["Service"] => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const client = new WebClient(undefined, {
    logLevel: LogLevel.WARN,
    retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 2_000 },
    timeout: timeoutMs,
    rejectRateLimitedCalls: false,
    fetch: fetchFn,
  });

  const call = <S extends Schema.Top>(
    method: string,
    token: string,
    args: Record<string, unknown>,
    result: S,
  ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
    Effect.tryPromise({
      try: () => client.apiCall(method, { ...args, token }),
      catch: (cause) => slackApiError(method, cause),
    }).pipe(
      Effect.flatMap((answer) => Schema.decodeUnknownEffect(result)(answer)),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(
          new SlackApiError({ method, code: "unexpected_response", message: error.message }),
        ),
      ),
    );

  return {
    authTest: (token) =>
      call("auth.test", token, {}, AuthTestResult).pipe(
        Effect.map((answer) => ({
          teamId: answer.team_id,
          teamName: answer.team,
          userId: answer.user_id,
          botId: present(answer.bot_id),
          appId: present(answer.app_id),
          enterpriseId: present(answer.enterprise_id),
        })),
      ),
    appsConnectionsOpen: (appToken) =>
      call("apps.connections.open", appToken, {}, ConnectionsOpenResult).pipe(
        Effect.map((answer) => ({
          url: answer.url,
          appId: Option.getOrNull(
            Option.liftThrowable(() => new URL(answer.url).searchParams.get("app_id"))(),
          ),
        })),
      ),
    botsInfo: (token, botId) =>
      call("bots.info", token, { bot: botId }, BotsInfoResult).pipe(
        Effect.map((answer) => ({
          botId: answer.bot.id,
          appId: present(answer.bot.app_id),
          name: answer.bot.name,
        })),
      ),
    postMessage: (token, input) =>
      call(
        "chat.postMessage",
        token,
        // Mend's links are to itself; an unfurl would only repeat them.
        { ...message(input), unfurl_links: false, unfurl_media: false },
        PostResult,
      ),
    postEphemeral: (token, input) =>
      call(
        "chat.postEphemeral",
        token,
        { ...message(input), user: input.user },
        EphemeralResult,
      ).pipe(Effect.map((answer) => ({ messageTs: answer.message_ts }))),
    update: (token, input) =>
      call("chat.update", token, { ...message(input), ts: input.ts }, PostResult),
    reactionsAdd: (token, input) =>
      settled(call("reactions.add", token, { ...input }, Schema.Unknown), "already_reacted"),
    reactionsRemove: (token, input) =>
      settled(call("reactions.remove", token, { ...input }, Schema.Unknown), "no_reaction"),
    conversationsReplies: (token, input) =>
      Effect.gen(function* () {
        const max = input.max ?? SLACK_REPLIES_MAX;
        const messages: Array<SlackThreadMessage> = [];
        let cursor: string | null = null;
        do {
          const page: typeof RepliesResult.Type = yield* call(
            "conversations.replies",
            token,
            {
              channel: input.channel,
              ts: input.ts,
              limit: 200,
              ...(input.latest === undefined ? {} : { latest: input.latest, inclusive: true }),
              ...(cursor === null ? {} : { cursor }),
            },
            RepliesResult,
          );
          for (const entry of page.messages ?? []) {
            if (messages.length >= max) break;
            messages.push({
              ts: entry.ts,
              userId: present(entry.user),
              teamId: present(entry.user_team) ?? present(entry.team),
              isBot: present(entry.bot_id) !== null || entry.subtype === "bot_message",
              displayName: null,
              text: entry.text ?? "",
              files: (entry.files ?? []).map((file) => ({
                id: file.id,
                name: present(file.name),
                mimetype: present(file.mimetype),
                urlPrivate: present(file.url_private),
              })),
            });
          }
          cursor = present(page.response_metadata?.next_cursor);
        } while (cursor !== null && messages.length < max);
        return messages;
      }),
    usersInfo: (token, user) =>
      call("users.info", token, { user }, UsersInfoResult).pipe(
        Effect.map(({ user: found }) => ({
          id: found.id,
          teamId: present(found.team_id),
          name: found.name,
          displayName:
            present(found.profile?.display_name) ??
            present(found.profile?.real_name) ??
            present(found.real_name) ??
            found.name,
          realName: present(found.profile?.real_name) ?? present(found.real_name),
          isBot: found.is_bot === true,
          deleted: found.deleted === true,
        })),
      ),
    filesDownload: (token, url, { maxBytes }) =>
      Effect.gen(function* () {
        const method = "files.download";
        if (!isSlackFileUrl(url)) {
          return yield* new SlackApiError({
            method,
            code: "not_slack_host",
            message: "Mend fetches files only from Slack.",
          });
        }
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchFn(url, {
              headers: { authorization: `Bearer ${token}` },
              // A redirect off Slack would carry the token with it.
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs * 3)]),
            }),
          catch: (cause) => slackApiError(method, cause),
        });
        if (!response.ok) {
          return yield* new SlackApiError({
            method,
            code: `http_${response.status}`,
            message: `Slack answered ${response.status} for the file.`,
          });
        }
        const declared = Number(response.headers.get("content-length") ?? Number.NaN);
        if (declared > maxBytes) {
          return yield* new SlackApiError({
            method,
            code: "too_large",
            message: `The file is over ${maxBytes} bytes.`,
          });
        }
        const bytes = new Uint8Array(
          yield* Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: (cause) => slackApiError(method, cause),
          }),
        );
        if (bytes.byteLength > maxBytes) {
          return yield* new SlackApiError({
            method,
            code: "too_large",
            message: `The file is over ${maxBytes} bytes.`,
          });
        }
        return { bytes, contentType: response.headers.get("content-type") };
      }),
  };
};

/** Slack over the network, for the API and the worker. */
export const SlackApiLive: Layer.Layer<SlackApi> = Layer.sync(SlackApi, () => makeSlackApi());

// ─── A fake Slack for tests ─────────────────────────────────────────────────

/** One Slack workspace with one installed app, as the fake answers for it. */
export interface FakeSlackWorkspace {
  readonly teamId: string;
  readonly teamName: string;
  readonly appId: string;
  readonly botId: string;
  readonly botUserId: string;
  readonly botToken: string;
  readonly appToken: string;
  readonly users?: ReadonlyArray<SlackUserInfo>;
  /** Threads by `<channel>:<parent ts>`, oldest first. */
  readonly threads?: Readonly<Record<string, ReadonlyArray<SlackThreadMessage>>>;
  /** File bytes by URL. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
}

/** Everything the fake was asked to change, in order. */
export type FakeSlackCall =
  | { readonly kind: "postMessage"; readonly teamId: string; readonly input: SlackPostInput }
  | { readonly kind: "postEphemeral"; readonly teamId: string; readonly input: SlackEphemeralInput }
  | { readonly kind: "update"; readonly teamId: string; readonly input: SlackUpdateInput }
  | { readonly kind: "reactionsAdd"; readonly teamId: string; readonly input: SlackReactionInput }
  | {
      readonly kind: "reactionsRemove";
      readonly teamId: string;
      readonly input: SlackReactionInput;
    };

export interface FakeSlack {
  readonly service: SlackApi["Service"];
  readonly layer: Layer.Layer<SlackApi>;
  /** Writes, in the order they were made. Reads are not recorded. */
  readonly calls: ReadonlyArray<FakeSlackCall>;
  /** Reactions on each `<channel>:<ts>` right now. */
  readonly reactions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * An in-memory Slack: tokens a workspace lists are good, anything else is `invalid_auth`, and a
 * bot token cannot open a socket (`not_allowed_token_type`), as in Slack.
 */
export const makeFakeSlack = (workspaces: ReadonlyArray<FakeSlackWorkspace>): FakeSlack => {
  const calls: Array<FakeSlackCall> = [];
  const reactions = new Map<string, Set<string>>();
  let sequence = 0;
  const nextTs = () => {
    sequence += 1;
    return `1700000000.${String(sequence).padStart(6, "0")}`;
  };
  const refuse = (method: string, code: string): Effect.Effect<never, SlackApiError> =>
    Effect.fail(new SlackApiError({ method, code, message: `An API error occurred: ${code}` }));
  const byBot = (
    method: string,
    token: string,
  ): Effect.Effect<FakeSlackWorkspace, SlackApiError> => {
    const found = workspaces.find((workspace) => workspace.botToken === token);
    if (found !== undefined) return Effect.succeed(found);
    return workspaces.some((workspace) => workspace.appToken === token)
      ? refuse(method, "not_allowed_token_type")
      : refuse(method, "invalid_auth");
  };

  const service: SlackApi["Service"] = {
    authTest: (token) =>
      byBot("auth.test", token).pipe(
        Effect.map((workspace) => ({
          teamId: workspace.teamId,
          teamName: workspace.teamName,
          userId: workspace.botUserId,
          botId: workspace.botId,
          appId: null,
          enterpriseId: null,
        })),
      ),
    appsConnectionsOpen: (appToken) => {
      const found = workspaces.find((workspace) => workspace.appToken === appToken);
      if (found !== undefined) {
        return Effect.succeed({
          url: `wss://wss.slack.invalid/link/?ticket=t&app_id=${found.appId}`,
          appId: found.appId,
        });
      }
      return workspaces.some((workspace) => workspace.botToken === appToken)
        ? refuse("apps.connections.open", "not_allowed_token_type")
        : refuse("apps.connections.open", "invalid_auth");
    },
    botsInfo: (token, botId) =>
      byBot("bots.info", token).pipe(
        Effect.flatMap((workspace) =>
          workspace.botId === botId
            ? Effect.succeed({ botId, appId: workspace.appId, name: "mend" })
            : refuse("bots.info", "bot_not_found"),
        ),
      ),
    postMessage: (token, input) =>
      byBot("chat.postMessage", token).pipe(
        Effect.map((workspace) => {
          calls.push({ kind: "postMessage", teamId: workspace.teamId, input });
          return { channel: input.channel, ts: nextTs() };
        }),
      ),
    postEphemeral: (token, input) =>
      byBot("chat.postEphemeral", token).pipe(
        Effect.map((workspace) => {
          calls.push({ kind: "postEphemeral", teamId: workspace.teamId, input });
          return { messageTs: nextTs() };
        }),
      ),
    update: (token, input) =>
      byBot("chat.update", token).pipe(
        Effect.map((workspace) => {
          calls.push({ kind: "update", teamId: workspace.teamId, input });
          return { channel: input.channel, ts: input.ts };
        }),
      ),
    reactionsAdd: (token, input) =>
      byBot("reactions.add", token).pipe(
        Effect.map((workspace) => {
          calls.push({ kind: "reactionsAdd", teamId: workspace.teamId, input });
          const key = `${input.channel}:${input.timestamp}`;
          reactions.set(key, new Set([...(reactions.get(key) ?? []), input.name]));
        }),
      ),
    reactionsRemove: (token, input) =>
      byBot("reactions.remove", token).pipe(
        Effect.map((workspace) => {
          calls.push({ kind: "reactionsRemove", teamId: workspace.teamId, input });
          reactions.get(`${input.channel}:${input.timestamp}`)?.delete(input.name);
        }),
      ),
    conversationsReplies: (token, input) =>
      byBot("conversations.replies", token).pipe(
        Effect.flatMap((workspace) => {
          const thread = workspace.threads?.[`${input.channel}:${input.ts}`];
          if (thread === undefined) return refuse("conversations.replies", "thread_not_found");
          const latest = input.latest;
          return Effect.succeed(
            thread
              .filter((entry) => latest === undefined || Number(entry.ts) <= Number(latest))
              .slice(0, input.max ?? SLACK_REPLIES_MAX),
          );
        }),
      ),
    usersInfo: (token, user) =>
      byBot("users.info", token).pipe(
        Effect.flatMap((workspace) => {
          const found = workspace.users?.find((entry) => entry.id === user);
          return found === undefined
            ? refuse("users.info", "user_not_found")
            : Effect.succeed(found);
        }),
      ),
    filesDownload: (token, url, { maxBytes }) =>
      byBot("files.download", token).pipe(
        Effect.flatMap((workspace) => {
          if (!isSlackFileUrl(url)) return refuse("files.download", "not_slack_host");
          const bytes = workspace.files?.[url];
          if (bytes === undefined) return refuse("files.download", "http_404");
          if (bytes.byteLength > maxBytes) return refuse("files.download", "too_large");
          return Effect.succeed({ bytes, contentType: null });
        }),
      ),
  };

  return { service, layer: Layer.succeed(SlackApi, service), calls, reactions };
};
