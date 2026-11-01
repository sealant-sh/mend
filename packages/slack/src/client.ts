import type { Readable } from "node:stream";

import {
  LogLevel,
  WebAPIHTTPError,
  WebAPIPlatformError,
  WebAPIRateLimitedError,
  WebAPIRequestError,
  WebClient,
} from "@slack/web-api";
import { Effect, Layer, Schema } from "effect";
import * as Context from "effect/Context";

import type { SlackBlock } from "./blocks.ts";
import { SLACK_BOT_SCOPES } from "./manifest.ts";
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
export class SlackApiError extends Schema.TaggedError<SlackApiError>()("SlackApiError", {
  method: Schema.String,
  code: Schema.String,
  message: Schema.String,
  /** Slack's Retry-After on a `ratelimited` answer, once the client's own waits ran out. */
  retryAfterSeconds: Schema.optional(Schema.Number),
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
  /** Null when Slack did not return the granted scopes header. */
  readonly grantedScopes: ReadonlyArray<string> | null;
}

/** An app-level token's socket URL, from `apps.connections.open`, and the app it names. */
export interface SlackConnection {
  readonly url: string;
  /**
   * The app the token belongs to, as `auth.test` reports it for that token (`A0C4…`). The
   * `app_id` on the socket URL is a hash, not this id, so it is never read.
   */
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
  /** Stable UUID for a reply that must be reconciled after an uncertain response. */
  readonly clientMessageId?: string;
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
  /** The most messages kept, the newest; defaults to `SLACK_REPLIES_MAX`. */
  readonly max?: number;
}

export interface SlackDownload {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

/** The upload ticket returned before Mend sends bytes. */
export interface SlackUploadTicket {
  readonly uploadUrl: string;
  readonly fileId: string;
}

export interface SlackUploadInput {
  readonly filename: string;
  readonly length: number;
  readonly altText: string;
}

/** A fresh reader is needed on every upload attempt. */
export interface SlackUploadBody {
  readonly body: Uint8Array | Readable;
  readonly length: number;
}

export interface SlackCompleteUploadInput {
  readonly fileId: string;
  readonly title: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly initialComment: string;
}

export interface SlackFileShare {
  readonly ts: string;
  readonly threadTs: string | null;
}

/** Enough of any thread for the fifty messages the session receives. */
export const SLACK_REPLIES_MAX = 1_000;

/**
 * The most pages of 200 one read asks for. Slack pages a thread oldest first, so the newest
 * messages are on the last page: a thread longer than this many pages (10,000 messages) is read
 * only as far as its first 10,000, and the newest beyond them are left out.
 */
export const SLACK_REPLIES_MAX_PAGES = 50;

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
     * A thread's newest messages up to `latest`, oldest first, across pages. Slack pages a thread
     * from its start, so every page is read and only the newest `max` are kept. Names are not
     * looked up: `displayName` is null, for the caller to fill from `usersInfo`.
     */
    readonly conversationsReplies: (
      token: string,
      input: SlackRepliesInput,
    ) => Effect.Effect<ReadonlyArray<SlackThreadMessage>, SlackApiError>;
    readonly usersInfo: (
      token: string,
      user: string,
    ) => Effect.Effect<SlackUserInfo, SlackApiError>;
    readonly filesGetUploadUrl: (
      token: string,
      input: SlackUploadInput,
    ) => Effect.Effect<SlackUploadTicket, SlackApiError>;
    /** The ticket authorizes the upload; no bot token is sent with the bytes. */
    readonly filesUpload: (
      url: string,
      input: SlackUploadBody,
    ) => Effect.Effect<void, SlackApiError>;
    /** One file per call so its label and caption stay with that file. Never auto-retried. */
    readonly filesCompleteUpload: (
      token: string,
      input: SlackCompleteUploadInput,
    ) => Effect.Effect<void, SlackApiError>;
    /** Shares in this channel only, across public and private conversations. */
    readonly filesInfo: (
      token: string,
      fileId: string,
      channelId: string,
    ) => Effect.Effect<ReadonlyArray<SlackFileShare>, SlackApiError>;
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
  response_metadata: Schema.optional(
    Schema.Struct({ scopes: Schema.optional(Schema.Array(Schema.String)) }),
  ),
});

const UploadUrlResult = Schema.Struct({ upload_url: Schema.String, file_id: Schema.String });
const CompleteUploadResult = Schema.Struct({
  files: Schema.Array(Schema.Struct({ id: Schema.String })),
});
const FileShares = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Struct({ ts: Schema.String, thread_ts: OptionalString })),
);
const FileInfoResult = Schema.Struct({
  file: Schema.Struct({
    id: Schema.String,
    shares: Schema.optional(
      Schema.Struct({ public: Schema.optional(FileShares), private: Schema.optional(FileShares) }),
    ),
  }),
});

const ConnectionsOpenResult = Schema.Struct({ url: Schema.String });

/** `auth.test` for an app-level token names the app and no workspace: no team, no user. */
const AppAuthTestResult = Schema.Struct({ app_id: OptionalString });

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
        client_msg_id: OptionalString,
        blocks: Schema.optional(Schema.Array(Schema.Struct({ block_id: OptionalString }))),
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
              size: Schema.optional(Schema.NullOr(Schema.Number)),
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
  if (cause instanceof SlackApiError) return cause;
  if (cause instanceof Error && cause.cause instanceof SlackApiError) return cause.cause;
  if (cause instanceof WebAPIPlatformError) {
    return new SlackApiError({ method, code: cause.data.error, message: cause.message });
  }
  if (cause instanceof WebAPIRateLimitedError) {
    return new SlackApiError({
      method,
      code: "ratelimited",
      message: cause.message,
      retryAfterSeconds: cause.retryAfter,
    });
  }
  // The client waits out each Retry-After itself; when its retries run out it throws the last
  // wait's own error, which names the Retry-After only in its message.
  const exhausted =
    cause instanceof WebAPIRequestError
      ? /^A rate limit was exceeded \(url: [^,]*, retry-after: (\d+)\)$/u.exec(
          cause.original.message,
        )
      : null;
  if (exhausted !== null) {
    return new SlackApiError({
      method,
      code: "ratelimited",
      message: "rate limited",
      retryAfterSeconds: Number(exhausted[1]),
    });
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

const MESSAGE_GONE: ReadonlySet<string> = new Set(["message_not_found", "channel_not_found"]);

/**
 * `MessageGone`: never edited again. `Refused`: anything else, from a rate limit to a channel
 * archived for now or a token that stopped working; the edit waits `retryAfterMs` when Slack
 * named a Retry-After, and backs off otherwise.
 */
export type UpdateRefusal =
  | { readonly _tag: "MessageGone" }
  | { readonly _tag: "Refused"; readonly retryAfterMs: number | null };

export const updateRefusalOf = (error: SlackApiError): UpdateRefusal =>
  MESSAGE_GONE.has(error.code)
    ? { _tag: "MessageGone" }
    : {
        _tag: "Refused",
        retryAfterMs:
          error.retryAfterSeconds === undefined ? null : error.retryAfterSeconds * 1_000,
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
  ...("clientMessageId" in input && input.clientMessageId !== undefined
    ? { client_msg_id: input.clientMessageId }
    : {}),
  ...(input.blocks === undefined ? {} : { blocks: input.blocks }),
  ...("threadTs" in input && input.threadTs !== undefined ? { thread_ts: input.threadTs } : {}),
});

export interface SlackApiOptions {
  /** The transport; `globalThis.fetch` by default. Tests pass a fake. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per request, in milliseconds. */
  readonly timeoutMs?: number;
  /** Bytes and completion may take longer than a small Web API request. Defaults to 120 s. */
  readonly uploadTimeoutMs?: number;
}

const uploadStream = (body: Readable, length: number): ReadableStream<Uint8Array> => {
  const iterator: AsyncIterator<unknown> = body[Symbol.asyncIterator]();
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done === true) {
        if (sent !== length)
          throw new SlackApiError({
            method: "files.uploadBytes",
            code: "invalid_length",
            message: "The file length does not match the upload.",
          });
        controller.close();
        return;
      }
      const chunk =
        typeof next.value === "string" ? new TextEncoder().encode(next.value) : next.value;
      if (!(chunk instanceof Uint8Array))
        throw new SlackApiError({
          method: "files.uploadBytes",
          code: "invalid_bytes",
          message: "The upload reader did not return bytes.",
        });
      sent += chunk.byteLength;
      if (sent > length)
        throw new SlackApiError({
          method: "files.uploadBytes",
          code: "invalid_length",
          message: "The file length does not match the upload.",
        });
      controller.enqueue(chunk);
    },
    cancel() {
      body.destroy();
    },
  });
};

/**
 * The live implementation over `@slack/web-api`: its transport, rate-limit waits and a short
 * retry. A request a person is waiting on (Settings → Slack) must not sit in the SDK's default
 * half-hour retry, so retries stay few.
 */
export const makeSlackApi = (options: SlackApiOptions = {}): SlackApi["Service"] => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
  const completionClient = new WebClient(undefined, {
    logLevel: LogLevel.WARN,
    retryConfig: { retries: 0 },
    timeout: uploadTimeoutMs,
    rejectRateLimitedCalls: true,
    fetch: fetchFn,
  });
  const client = new WebClient(undefined, {
    logLevel: LogLevel.WARN,
    retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 2_000 },
    timeout: timeoutMs,
    rejectRateLimitedCalls: false,
    fetch: fetchFn,
  });

  const decode = <S extends Schema.Top>(
    method: string,
    result: S,
    request: Promise<unknown>,
  ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
    Effect.tryPromise({
      try: () => request,
      catch: (cause) => slackApiError(method, cause),
    }).pipe(
      Effect.flatMap((answer) => Schema.decodeUnknownEffect(result)(answer)),
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(
          new SlackApiError({ method, code: "unexpected_response", message: error.message }),
        ),
      ),
    );

  const call = <S extends Schema.Top>(
    method: string,
    token: string,
    args: Record<string, unknown>,
    result: S,
  ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
    Effect.suspend(() => decode(method, result, client.apiCall(method, { ...args, token })));

  /**
   * A call with an app-level token (`xapp-`). `apiCall`'s `token` argument rides in the form body
   * as well as the `Authorization` header, and Slack refuses an app-level token in a body with
   * `invalid_auth`, so the token goes on a client of its own as a header only, exactly as the SDK's
   * Socket Mode client does before it calls `apps.connections.open`.
   */
  const appLevelCall = <S extends Schema.Top>(
    method: string,
    appToken: string,
    result: S,
  ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
    decode(
      method,
      result,
      new WebClient(undefined, {
        logLevel: LogLevel.WARN,
        retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 2_000 },
        timeout: timeoutMs,
        rejectRateLimitedCalls: false,
        fetch: fetchFn,
        headers: { Authorization: `Bearer ${appToken}` },
      }).apiCall(method, {}),
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
          grantedScopes: answer.response_metadata?.scopes ?? null,
        })),
      ),
    appsConnectionsOpen: (appToken) =>
      appLevelCall("apps.connections.open", appToken, ConnectionsOpenResult).pipe(
        Effect.flatMap((answer) =>
          appLevelCall("auth.test", appToken, AppAuthTestResult).pipe(
            Effect.map((identity) => ({ url: answer.url, appId: present(identity.app_id) })),
          ),
        ),
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
      input.clientMessageId === undefined
        ? call(
            "chat.postMessage",
            token,
            // Mend's links are to itself; an unfurl would only repeat them.
            { ...message(input), unfurl_links: false, unfurl_media: false },
            PostResult,
          )
        : Effect.suspend(() =>
            decode(
              "chat.postMessage",
              PostResult,
              completionClient.apiCall("chat.postMessage", {
                ...message(input),
                token,
                unfurl_links: false,
                unfurl_media: false,
              }),
            ),
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
        // The newest `max` so far: an older message falls out as a newer one comes in.
        const messages: Array<SlackThreadMessage> = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          pages += 1;
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
            if (max <= 0) break;
            if (messages.length >= max) messages.shift();
            messages.push({
              ts: entry.ts,
              ...(entry.client_msg_id == null ? {} : { clientMessageId: entry.client_msg_id }),
              ...(entry.blocks === undefined
                ? {}
                : {
                    blockIds: entry.blocks.flatMap((block) =>
                      block.block_id == null ? [] : [block.block_id],
                    ),
                  }),
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
                size: file.size ?? null,
              })),
            });
          }
          cursor = present(page.response_metadata?.next_cursor);
        } while (cursor !== null && pages < SLACK_REPLIES_MAX_PAGES);
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
    filesGetUploadUrl: (token, input) =>
      call(
        "files.getUploadURLExternal",
        token,
        { filename: input.filename, length: input.length, alt_txt: input.altText },
        UploadUrlResult,
      ).pipe(Effect.map((answer) => ({ uploadUrl: answer.upload_url, fileId: answer.file_id }))),
    filesUpload: (url, { body, length }) =>
      Effect.gen(function* () {
        const method = "files.uploadBytes";
        if (!isSlackFileUrl(url))
          return yield* new SlackApiError({
            method,
            code: "not_slack_host",
            message: "Mend uploads files only to Slack.",
          });
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          (body instanceof Uint8Array && body.byteLength !== length)
        ) {
          return yield* new SlackApiError({
            method,
            code: "invalid_length",
            message: "The file length does not match the upload.",
          });
        }
        yield* Effect.tryPromise({
          try: async (signal) => {
            const init = {
              method: "POST",
              headers: {
                "content-type": "application/octet-stream",
                "content-length": String(length),
              },
              body: body instanceof Uint8Array ? Buffer.from(body) : uploadStream(body, length),
              duplex: "half",
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(uploadTimeoutMs)]),
            } satisfies RequestInit & { readonly duplex: "half" };
            const response = await fetchFn(url, init);
            await response.body?.cancel();
            if (!response.ok)
              throw new SlackApiError({
                method,
                code: `http_${response.status}`,
                message: `Slack answered ${response.status} for the upload.`,
              });
          },
          catch: (cause) => (cause instanceof SlackApiError ? cause : slackApiError(method, cause)),
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (!(body instanceof Uint8Array)) body.destroy();
          }),
        ),
      ),
    filesCompleteUpload: (token, input) =>
      Effect.suspend(() =>
        decode(
          "files.completeUploadExternal",
          CompleteUploadResult,
          completionClient.apiCall("files.completeUploadExternal", {
            token,
            files: [{ id: input.fileId, title: input.title }],
            channel_id: input.channelId,
            thread_ts: input.threadTs,
            initial_comment: input.initialComment,
          }),
        ),
      ).pipe(Effect.asVoid),
    filesInfo: (token, fileId, channelId) =>
      call("files.info", token, { file: fileId }, FileInfoResult).pipe(
        Effect.map(({ file }) =>
          [
            ...(file.shares?.public?.[channelId] ?? []),
            ...(file.shares?.private?.[channelId] ?? []),
          ].map((share) => ({ ts: share.ts, threadTs: present(share.thread_ts) })),
        ),
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
  readonly grantedScopes?: ReadonlyArray<string>;
  /** Threads by `<channel>:<parent ts>`, oldest first. */
  readonly threads?: Readonly<Record<string, ReadonlyArray<SlackThreadMessage>>>;
  /** File bytes by URL. */
  readonly files?: Readonly<Record<string, Uint8Array>>;
}

/** Everything the fake was asked to change, in order. */
export type FakeSlackCall =
  | {
      readonly kind: "filesGetUploadUrl";
      readonly teamId: string;
      readonly input: SlackUploadInput;
      readonly fileId: string;
    }
  | { readonly kind: "filesUpload"; readonly fileId: string; readonly length: number }
  | {
      readonly kind: "filesCompleteUpload";
      readonly teamId: string;
      readonly input: SlackCompleteUploadInput;
    }
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
  /** Refuse the next `chat.update` calls, one per error, in order; a refused edit changes nothing. */
  readonly refuseUpdates: (...errors: ReadonlyArray<SlackApiError>) => void;
  readonly refused: ReadonlyArray<SlackUpdateInput>;
  readonly refuseFiles: (...errors: ReadonlyArray<SlackApiError>) => void;
  readonly expireFile: (fileId: string) => void;
}

/**
 * An in-memory Slack: tokens a workspace lists are good, anything else is `invalid_auth`, and a
 * bot token cannot open a socket (`not_allowed_token_type`), as in Slack.
 */
export const makeFakeSlack = (workspaces: ReadonlyArray<FakeSlackWorkspace>): FakeSlack => {
  const calls: Array<FakeSlackCall> = [];
  const uploadedFiles = new Map<
    string,
    {
      readonly teamId: string;
      readonly length: number;
      uploaded: boolean;
      shared: boolean;
      channelId: string | null;
      shares: Array<SlackFileShare>;
    }
  >();
  const fileRefusals: Array<SlackApiError> = [];
  const fileError = (method: string): SlackApiError | undefined =>
    fileRefusals[0]?.method === method ? fileRefusals.shift() : undefined;
  const posted = new Map<string, Array<SlackThreadMessage>>();
  const reactions = new Map<string, Set<string>>();
  const updateRefusals: Array<SlackApiError> = [];
  const refused: Array<SlackUpdateInput> = [];
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
          grantedScopes: workspace.grantedScopes ?? [...SLACK_BOT_SCOPES],
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
          const key = `${workspace.teamId}:${input.channel}:${input.threadTs ?? ""}`;
          const replies = posted.get(key) ?? [];
          const existing =
            input.clientMessageId === undefined
              ? undefined
              : replies.find((reply) => reply.clientMessageId === input.clientMessageId);
          if (existing !== undefined) return { channel: input.channel, ts: existing.ts };
          const ts = nextTs();
          calls.push({ kind: "postMessage", teamId: workspace.teamId, input });
          replies.push({
            ts,
            userId: workspace.botUserId,
            teamId: workspace.teamId,
            isBot: true,
            displayName: null,
            text: input.text,
            files: [],
            ...(input.blocks === undefined
              ? {}
              : {
                  blockIds: input.blocks.flatMap((block) =>
                    block.block_id === undefined ? [] : [block.block_id],
                  ),
                }),
            ...(input.clientMessageId === undefined
              ? {}
              : { clientMessageId: input.clientMessageId }),
          });
          posted.set(key, replies);
          return { channel: input.channel, ts };
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
        Effect.flatMap((workspace) => {
          const refusal = updateRefusals.shift();
          if (refusal !== undefined) {
            refused.push(input);
            return Effect.fail(refusal);
          }
          calls.push({ kind: "update", teamId: workspace.teamId, input });
          return Effect.succeed({ channel: input.channel, ts: input.ts });
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
          const initial = workspace.threads?.[`${input.channel}:${input.ts}`];
          const replies = posted.get(`${workspace.teamId}:${input.channel}:${input.ts}`);
          const thread =
            initial === undefined && replies === undefined
              ? undefined
              : [...(initial ?? []), ...(replies ?? [])];
          if (thread === undefined) return refuse("conversations.replies", "thread_not_found");
          const latest = input.latest;
          const max = input.max ?? SLACK_REPLIES_MAX;
          const upTo = thread.filter(
            (entry) => latest === undefined || Number(entry.ts) <= Number(latest),
          );
          return Effect.succeed(max <= 0 ? [] : upTo.slice(-max));
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
    filesGetUploadUrl: (token, input) =>
      byBot("files.getUploadURLExternal", token).pipe(
        Effect.flatMap((workspace) =>
          Effect.suspend(() => {
            const error = fileError("files.getUploadURLExternal");
            if (error !== undefined) return Effect.fail(error);
            if (!(workspace.grantedScopes ?? SLACK_BOT_SCOPES).includes("files:write"))
              return refuse("files.getUploadURLExternal", "missing_scope");
            const fileId = `F${uploadedFiles.size}-${nextTs()}`;
            uploadedFiles.set(fileId, {
              teamId: workspace.teamId,
              length: input.length,
              uploaded: false,
              shared: false,
              channelId: null,
              shares: [],
            });
            calls.push({ kind: "filesGetUploadUrl", teamId: workspace.teamId, input, fileId });
            return Effect.succeed({
              fileId,
              uploadUrl: `https://files.slack.com/upload/${fileId}`,
            });
          }),
        ),
      ),
    filesUpload: (url, input) =>
      Effect.suspend(() => {
        const error = fileError("files.uploadBytes");
        if (error !== undefined) return Effect.fail(error);
        if (!isSlackFileUrl(url)) return refuse("files.uploadBytes", "not_slack_host");
        const fileId = url.split("/").at(-1) ?? "";
        const file = uploadedFiles.get(fileId);
        if (file === undefined) return refuse("files.uploadBytes", "http_404");
        if (
          input.length !== file.length ||
          (input.body instanceof Uint8Array && input.body.byteLength !== input.length)
        )
          return refuse("files.uploadBytes", "invalid_length");
        file.uploaded = true;
        calls.push({ kind: "filesUpload", fileId, length: input.length });
        return Effect.void;
      }),
    filesCompleteUpload: (token, input) =>
      byBot("files.completeUploadExternal", token).pipe(
        Effect.flatMap((workspace) =>
          Effect.suspend(() => {
            const error = fileError("files.completeUploadExternal");
            if (error !== undefined) return Effect.fail(error);
            const file = uploadedFiles.get(input.fileId);
            if (file === undefined || file.teamId !== workspace.teamId)
              return refuse("files.completeUploadExternal", "file_not_found");
            if (file.shared) return refuse("files.completeUploadExternal", "already_complete");
            if (!file.uploaded) return refuse("files.completeUploadExternal", "file_not_found");
            file.shared = true;
            file.channelId = input.channelId;
            file.shares.push({ ts: nextTs(), threadTs: input.threadTs });
            calls.push({ kind: "filesCompleteUpload", teamId: workspace.teamId, input });
            return Effect.void;
          }),
        ),
      ),
    filesInfo: (token, fileId, channelId) =>
      byBot("files.info", token).pipe(
        Effect.flatMap((workspace) =>
          Effect.suspend(() => {
            const error = fileError("files.info");
            if (error !== undefined) return Effect.fail(error);
            const file = uploadedFiles.get(fileId);
            if (file === undefined || file.teamId !== workspace.teamId)
              return refuse("files.info", "file_not_found");
            return Effect.succeed(file.channelId === channelId ? [...file.shares] : []);
          }),
        ),
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

  return {
    service,
    layer: Layer.succeed(SlackApi, service),
    calls,
    reactions,
    refuseUpdates: (...errors) => void updateRefusals.push(...errors),
    refused,
    refuseFiles: (...errors) => void fileRefusals.push(...errors),
    expireFile: (fileId) => void uploadedFiles.delete(fileId),
  };
};
