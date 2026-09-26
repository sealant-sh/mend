import { LogLevel, SocketModeClient } from "@slack/socket-mode";
import { type Cause, Effect, Layer, Queue, Stream } from "effect";
import * as Context from "effect/Context";

import { SlackApiError, slackApiError } from "./client.ts";

/**
 * Slack's Socket Mode (docs/adr/0006-slack.md, "Socket Mode, outbound only"): Mend opens a
 * WebSocket to Slack with the install's app-level token, and Slack delivers events and button
 * presses over it. Slack never connects to Mend. Behind a service so the worker's runner is tested
 * against a fake event source.
 */

/**
 * One envelope Slack delivered: an `events_api` event (`body` is the event callback, with its
 * `event_id`), an `interactive` payload (`body` is a `block_actions` payload), or anything else
 * Mend does not read. Every envelope must be acknowledged, or Slack delivers it again.
 */
export interface SlackEnvelope {
  readonly type: string;
  readonly envelopeId: string;
  readonly body: unknown;
  /** Slack's count of earlier deliveries of the same event; null on the first. */
  readonly retryAttempt: number | null;
  /**
   * Acknowledge the envelope. It never fails: an ack the socket could not send is logged, Slack
   * delivers the event again, and the event claim drops the repeat.
   */
  readonly ack: Effect.Effect<void>;
}

export class SlackSocket extends Context.Service<
  SlackSocket,
  {
    /**
     * A Socket Mode connection for one app-level token (`xapp-`). The stream opens the socket
     * when it runs and closes it when it is interrupted. It ends when Slack closes the socket,
     * which Slack does routinely every few hours; the caller reconnects. It fails when the
     * socket cannot be opened, with Slack's own code (`invalid_auth`, …) when Slack refused.
     */
    readonly connect: (appToken: string) => Stream.Stream<SlackEnvelope, SlackApiError>;
  }
>()("@mend/slack/SlackSocket") {}

/** What `@slack/socket-mode` emits as `slack_event` for every envelope. */
interface SocketModeEvent {
  readonly ack: (response?: Record<string, unknown>) => Promise<void>;
  readonly envelope_id: string;
  readonly type: string;
  readonly body: unknown;
  readonly retry_num?: number;
}

/**
 * The live connection over `@slack/socket-mode`. The SDK's own reconnect is off: after a lost
 * socket it reconnects from a timer whose failure (a revoked token) is an unhandled rejection
 * that would take the worker down. The stream ends instead, and the caller's supervisor
 * reconnects with its own backoff.
 */
export const makeSlackSocket = (
  options: { readonly fetch?: typeof globalThis.fetch } = {},
): SlackSocket["Service"] => ({
  connect: (appToken) =>
    Stream.callback<SlackEnvelope, SlackApiError>((queue) =>
      Effect.gen(function* () {
        const client = new SocketModeClient({
          appToken,
          autoReconnectEnabled: false,
          logLevel: LogLevel.WARN,
          // A person is not waiting on this call, but the supervisor owns the backoff.
          clientOptions: {
            retryConfig: { retries: 2, factor: 2 },
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          },
        });
        client.on("slack_event", (event: SocketModeEvent) => {
          Queue.offerUnsafe(queue, {
            type: event.type,
            envelopeId: event.envelope_id,
            body: event.body,
            retryAttempt: event.retry_num ?? null,
            ack: Effect.tryPromise(() => event.ack({})).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("slack socket: ack not sent").pipe(
                  Effect.annotateLogs({ envelopeId: event.envelope_id, cause: String(cause) }),
                ),
              ),
            ),
          });
        });
        client.on("disconnected", () => {
          Queue.endUnsafe(queue);
        });
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise(() => client.disconnect()).pipe(
            Effect.timeout("5 seconds"),
            Effect.ignore,
          ),
        );
        yield* Effect.tryPromise({
          try: () => client.start(),
          catch: (cause) => slackApiError("apps.connections.open", cause),
        });
        // `start` resolves once the socket is open; the SDK itself says so only at debug level.
        yield* Effect.logInfo("slack socket: connected");
      }).pipe(
        // The callback runs in a fiber of its own: its failure reaches the stream only here.
        Effect.catch((error) => Queue.fail(queue, error)),
      ),
    ),
});

export const SlackSocketLive: Layer.Layer<SlackSocket> = Layer.sync(SlackSocket, () =>
  makeSlackSocket(),
);

// ─── A fake socket for tests ────────────────────────────────────────────────

export interface FakeSlackSocket {
  readonly service: SlackSocket["Service"];
  readonly layer: Layer.Layer<SlackSocket>;
  /** Envelope ids, in the order they were acknowledged. */
  readonly acks: ReadonlyArray<string>;
  /** App tokens with a socket open right now, one entry per socket. */
  readonly open: () => ReadonlyArray<string>;
  /** Every connect attempt, by app token, in order. */
  readonly attempts: ReadonlyArray<string>;
  /** Deliver an envelope to every socket open for `appToken`; false when none is. */
  readonly deliver: (
    appToken: string,
    envelope: {
      readonly type: string;
      readonly envelopeId: string;
      readonly body: unknown;
      readonly retryAttempt?: number;
    },
  ) => boolean;
  /** Close every socket open for `appToken`, as Slack does when it recycles a connection. */
  readonly drop: (appToken: string) => void;
  /** Tokens Slack refuses with `invalid_auth`. */
  readonly refuse: (appToken: string) => void;
}

/** An in-memory Socket Mode: tests deliver envelopes to whichever sockets are open. */
export const makeFakeSlackSocket = (): FakeSlackSocket => {
  const acks: Array<string> = [];
  const attempts: Array<string> = [];
  const refused = new Set<string>();
  const sockets = new Map<string, Set<Queue.Queue<SlackEnvelope, SlackApiError | Cause.Done>>>();

  const service: SlackSocket["Service"] = {
    connect: (appToken) =>
      Stream.callback<SlackEnvelope, SlackApiError>((queue) =>
        Effect.gen(function* () {
          attempts.push(appToken);
          if (refused.has(appToken)) {
            return yield* new SlackApiError({
              method: "apps.connections.open",
              code: "invalid_auth",
              message: "An API error occurred: invalid_auth",
            });
          }
          const open = sockets.get(appToken) ?? new Set();
          open.add(queue);
          sockets.set(appToken, open);
          yield* Effect.addFinalizer(() => Effect.sync(() => void open.delete(queue)));
        }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
      ),
  };

  return {
    service,
    layer: Layer.succeed(SlackSocket, service),
    acks,
    attempts,
    open: () => [...sockets].flatMap(([token, open]) => [...open].map(() => token)),
    deliver: (appToken, envelope) => {
      const open = sockets.get(appToken);
      if (open === undefined || open.size === 0) return false;
      for (const queue of open) {
        Queue.offerUnsafe(queue, {
          type: envelope.type,
          envelopeId: envelope.envelopeId,
          body: envelope.body,
          retryAttempt: envelope.retryAttempt ?? null,
          ack: Effect.sync(() => void acks.push(envelope.envelopeId)),
        });
      }
      return true;
    },
    drop: (appToken) => {
      const open = sockets.get(appToken);
      if (open === undefined) return;
      for (const queue of open) Queue.endUnsafe(queue);
      open.clear();
    },
    refuse: (appToken) => void refused.add(appToken),
  };
};
