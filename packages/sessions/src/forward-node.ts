import * as http from "node:http";
import type * as net from "node:net";
import { Duplex } from "node:stream";

import { type ForwardBytes, ForwardIoFailure } from "@mend/sealant";
import { Cause, Effect, Exit, type Fiber, Result } from "effect";

import {
  ForwardAdapter,
  type ForwardConnection,
  type ForwardDialRecord,
  type ForwardOpenOptions,
  type ForwardRefused,
  type ForwardTarget,
} from "./forward.ts";

/**
 * The forward adapter as Node sockets: a `ForwardSocket` per connection, the relay ServiceHost runs
 * for each accepted TCP connection, and a keep-alive `http.Agent` over them, which the preview
 * gateway (ADR 0017 step 7) is to send requests through.
 */

/** A dial refused before the forward opened; `record` says why. */
export class ForwardRefusedError extends Error {
  readonly code = "EFORWARDREFUSED";
  readonly record: ForwardRefused;
  constructor(record: ForwardRefused) {
    super(`forward refused: ${record.issue.reason}`);
    this.record = record;
  }
}

/** The workspace side reset an open forward; what it sent so far is all there is. */
export class ForwardResetSocketError extends Error {
  readonly code = "ECONNRESET";
  readonly failure: ForwardIoFailure;
  constructor(failure: ForwardIoFailure) {
    super(`forward reset: ${failure.reason}`);
    this.failure = failure;
  }
}

type Callback = (error?: Error | null) => void;

/** Runs one byte operation; its typed failure is the result, a defect fails it as an io failure. */
const settle = <A>(
  operation: Effect.Effect<A, ForwardIoFailure>,
  then: (result: Result.Result<A, ForwardIoFailure>) => void,
): void => {
  void Effect.runPromise(
    Effect.result(operation).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          Result.fail(new ForwardIoFailure({ reason: "io-failed", message: String(cause) })),
        ),
      ),
    ),
  ).then(then);
};

/** What a dial's consumer hears once, ready or refused, before any of the socket's events. */
export type ForwardDialObserver = (record: ForwardDialRecord) => void;

/**
 * One forward as a Node socket. It returns at once, `connecting` until the forward opens, so a
 * caller (an http.Agent, a relay) owns it from the first moment: destroying it during the dial
 * gives the dial up, and a forward that opens later is reset. Half-open: the end of what is read
 * leaves writing open, and `end()` is the forward's FIN. Bytes written before the forward opens
 * wait in the stream's own buffer, bounded by its high-water mark. Once the workspace ended its
 * side, what is still written is dropped and what it sent is still read to its end.
 *
 * The socket methods an Agent calls are here: `setTimeout`/`timeout` keep a real inactivity timer;
 * `setKeepAlive`, `setNoDelay`, `ref` and `unref` change nothing, as there is no TCP connection of
 * this process's to tune or unreference.
 */
export class ForwardSocket extends Duplex {
  connecting = true;
  #bytes: ForwardBytes | null = null;
  #record: ForwardDialRecord | null = null;
  #stop: (() => void) | null = null;
  #heldWrite: { readonly chunk: Uint8Array; readonly callback: Callback } | null = null;
  #heldFinal: Callback | null = null;
  #wantsRead = false;
  #timeoutMs = 0;
  #timer: NodeJS.Timeout | null = null;
  readonly #observe: ForwardDialObserver | undefined;

  constructor(observe?: ForwardDialObserver) {
    super({ allowHalfOpen: true });
    this.#observe = observe;
  }

  /** The dial's record once it is known: on `connect`, or before the refusal's `error`. */
  get record(): ForwardDialRecord | null {
    return this.#record;
  }

  /** For `forwardSockets`: `stop` gives the dial up, or resets the open forward. */
  run(stop: () => void): void {
    if (this.destroyed) stop();
    else this.#stop = stop;
  }

  opened(connection: ForwardConnection): void {
    if (this.destroyed) return;
    this.#bytes = connection.bytes;
    this.#record = connection.record;
    this.connecting = false;
    this.#observe?.(connection.record);
    this.emit("connect");
    this.emit("ready");
    const held = this.#heldWrite;
    this.#heldWrite = null;
    if (held !== null) this.#send(held.chunk, held.callback);
    const final = this.#heldFinal;
    this.#heldFinal = null;
    if (final !== null) this.#finish(final);
    if (this.#wantsRead) this.#pull();
  }

  refused(record: ForwardRefused): void {
    if (this.destroyed) return;
    this.#record = record;
    this.#observe?.(record);
    this.destroy(new ForwardRefusedError(record));
  }

  override _read(): void {
    this.#pull();
  }

  #pull(): void {
    const bytes = this.#bytes;
    if (bytes === null) {
      this.#wantsRead = true;
      return;
    }
    this.#wantsRead = false;
    settle(bytes.read(), (result) => {
      if (this.destroyed) return;
      if (result._tag === "Failure") {
        this.destroy(new ForwardResetSocketError(result.failure));
        return;
      }
      this.#touch();
      this.push(result.success.kind === "eof" ? null : result.success.bytes);
    });
  }

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: Callback): void {
    if (this.#bytes === null) this.#heldWrite = { chunk, callback };
    else this.#send(chunk, callback);
  }

  override _final(callback: Callback): void {
    if (this.#bytes === null) this.#heldFinal = callback;
    else this.#finish(callback);
  }

  override _destroy(error: Error | null, callback: Callback): void {
    this.#clearTimer();
    const stop = this.#stop;
    this.#stop = null;
    stop?.();
    const gone = error ?? new Error("the forward socket was destroyed");
    this.#heldWrite?.callback(gone);
    this.#heldWrite = null;
    this.#heldFinal?.(gone);
    this.#heldFinal = null;
    callback(error);
  }

  #send(chunk: Uint8Array, callback: Callback): void {
    this.#touch();
    const bytes = this.#bytes;
    if (bytes === null) return callback(new Error("the forward is not open"));
    settle(bytes.write(chunk), (result) =>
      callback(result._tag === "Failure" ? new ForwardResetSocketError(result.failure) : null),
    );
  }

  #finish(callback: Callback): void {
    const bytes = this.#bytes;
    if (bytes === null) return callback(new Error("the forward is not open"));
    settle(bytes.finish(), (result) =>
      callback(result._tag === "Failure" ? new ForwardResetSocketError(result.failure) : null),
    );
  }

  get timeout(): number {
    return this.#timeoutMs;
  }

  setTimeout(timeoutMs: number, callback?: () => void): this {
    this.#timeoutMs = timeoutMs;
    if (callback !== undefined) this.once("timeout", callback);
    if (timeoutMs === 0) this.#clearTimer();
    else this.#touch();
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  #touch(): void {
    if (this.#timeoutMs <= 0 || this.destroyed) return;
    this.#clearTimer();
    this.#timer = setTimeout(() => this.emit("timeout"), this.#timeoutMs);
    this.#timer.unref();
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }
}

export type ForwardSocketConnect = (
  target: ForwardTarget,
  options: ForwardOpenOptions & { readonly observe?: ForwardDialObserver },
) => ForwardSocket;

const unfinishedDial = (exit: Exit.Exit<void>): Error =>
  Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
    ? new Error(`the forward's dial failed: ${Cause.pretty(exit.cause)}`)
    : new Error("the forward's dial was interrupted");

/**
 * Sockets dialled with the context this runs in, the principal included: each one owns one fiber,
 * whose scope holds its forward until the socket is destroyed. The fiber ending for any reason
 * destroys the socket, so none stays `connecting`.
 */
export const forwardSockets: Effect.Effect<ForwardSocketConnect, never, ForwardAdapter> =
  Effect.gen(function* () {
    const adapter = yield* ForwardAdapter;
    const context = yield* Effect.context<never>();
    const fork = Effect.runForkWith(context);
    return (target, options) => {
      const socket = new ForwardSocket(options.observe);
      const fiber: Fiber.Fiber<void> = fork(
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* adapter.open(target, options);
            socket.opened(connection);
            return yield* Effect.never;
          }),
        ).pipe(
          Effect.catchTag("ForwardDialFailure", (failure) =>
            Effect.sync(() => socket.refused(failure.record)),
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (!socket.destroyed) socket.destroy(unfinishedDial(exit));
            }),
          ),
        ),
      );
      socket.run(() => fiber.interruptUnsafe());
      return socket;
    };
  });

/**
 * Relays one accepted TCP connection through a forward: its bytes both ways with each side's own
 * backpressure, each side's FIN as the other's, and a reset as a reset (RST), never a clean end.
 * The client closing at any point, the dial included, gives the forward up. `observe` hears the
 * dial's record once, ready or refused.
 */
export const relayForwardSocket = (
  client: net.Socket,
  connect: ForwardSocketConnect,
  target: ForwardTarget,
  options: ForwardOpenOptions & { readonly observe: ForwardDialObserver },
): ForwardSocket => {
  const upstream = connect(target, options);
  client.setNoDelay(true);
  client.pipe(upstream);
  upstream.pipe(client);
  upstream.on("error", () => {
    if (!client.destroyed) client.resetAndDestroy();
  });
  client.on("error", () => upstream.destroy());
  client.once("close", () => upstream.destroy());
  if (client.destroyed) upstream.destroy();
  return upstream;
};

/**
 * An http.Agent for one target, keep-alive: a request reuses an idle forward, and a new socket is
 * a new dial. `maxSockets` bounds dials in flight too, since a socket counts from the moment it is
 * returned. A socket Node hands back before any request used it (its request was destroyed before
 * Node assigned it) is not pooled while it dials: it is destroyed, and its dial given up.
 */
export class ForwardAgent extends http.Agent {
  readonly #connect: () => ForwardSocket;

  constructor(connect: () => ForwardSocket, options: http.AgentOptions) {
    super({ ...options, keepAlive: true });
    this.#connect = connect;
  }

  override createConnection(): Duplex {
    return this.#connect();
  }

  override keepSocketAlive(socket: Duplex): boolean {
    if (socket instanceof ForwardSocket && socket.connecting) return false;
    const kept: unknown = super.keepSocketAlive(socket);
    return kept !== false;
  }
}
