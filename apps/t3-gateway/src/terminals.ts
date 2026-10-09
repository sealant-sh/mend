import {
  AuthTerminalOperateScope,
  EnvironmentAuthorizationError,
  TerminalNotRunningError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalRestartInput,
  type TerminalSessionSnapshot,
  type TerminalSummary,
} from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import type { GatedMend } from "./device-gate.ts";
import { makeFanout, type SubscriberFellBehind } from "./fanout.ts";
import type {
  MendCommandRefused,
  MendDeviceRefused,
  MendNotFound,
  MendUnavailable,
} from "./mend-client.ts";
import type { BearerSession } from "./state.ts";

/**
 * t3code's terminal drawer over Mend's own terminal (ADR 0012, phase 3: "terminal over `/api/tty`
 * with a `tty` ticket"). A t3code terminal of a thread is a shell Mend opens beside the agent in
 * the session's live workspace (`POST /api/sessions/:id/shell`), reached over Mend's
 * `/api/tty?process=` WebSocket, as the person:
 *
 * - The socket opens with a `tty` upgrade ticket Mend mints for that one process: single use,
 *   thirty seconds, spent at once. The ticket is redacted in the gateway and never logged or kept.
 * - Mend's rules hold: only a session's owner opens a shell in it (`steering.owned`), and only its
 *   owner types; anyone else gets t3code's authorization error.
 * - Output is Mend's PTY bytes, decoded as UTF-8; input is sent as bytes, a resize as Mend's
 *   `{"t":"resize"}` frame. Mend's `{"t":"end"}` or the socket closing ends the terminal.
 * - Terminals are the person's, shared by their sockets, kept for the hub's life with the last
 *   512 KiB of output for a client that attaches again.
 */

/** How much of a terminal's output is kept for a client attaching again. */
const HISTORY_LIMIT = 512 * 1024;
/** How long Mend may take to answer the terminal socket (the platform's attach takes up to 20 s). */
const OPEN_TIMEOUT = "25 seconds";

type TerminalStatus = TerminalSessionSnapshot["status"];

/** Why Mend did not take a command (`MendCommand`). */
type MendCommandFailure = MendDeviceRefused | MendNotFound | MendCommandRefused | MendUnavailable;

interface Terminal {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  status: TerminalStatus;
  history: string;
  processId: string | null;
  updatedAt: string;
  sequence: number;
  /** Who opened it: whose token stops its shell in Mend when the hub goes. */
  readonly openedBy: BearerSession;
  /** The socket's scope while it is open: closing it closes the socket. */
  scope: Scope.Closeable | null;
  writer: Socket.Writer | null;
}

export type TerminalFailure =
  | TerminalNotRunningError
  | TerminalSessionLookupError
  | TerminalWriteError
  | TerminalResizeError
  | EnvironmentAuthorizationError;

export interface TerminalHost {
  readonly mend: GatedMend;
  /** Mend's API origin; the terminal socket is its `/api/tty`. */
  readonly mendUrl: URL;
  /** The session a thread is, or null when the person has no such thread. */
  readonly threadSession: (threadId: string) => Effect.Effect<string | null>;
}

export interface Terminals {
  readonly open: (
    session: BearerSession,
    input: TerminalOpenInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalFailure>;
  readonly attach: (
    session: BearerSession,
    input: TerminalAttachInput,
  ) => Stream.Stream<TerminalAttachStreamEvent, TerminalFailure>;
  readonly write: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly data: string;
  }) => Effect.Effect<void, TerminalFailure>;
  readonly resize: (input: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  }) => Effect.Effect<void, TerminalFailure>;
  readonly clear: (input: {
    readonly threadId: string;
    readonly terminalId: string;
  }) => Effect.Effect<void, TerminalFailure>;
  readonly restart: (
    session: BearerSession,
    input: TerminalRestartInput,
  ) => Effect.Effect<TerminalSessionSnapshot, TerminalFailure>;
  readonly close: (session: BearerSession, input: TerminalCloseInput) => Effect.Effect<void>;
  /** Every terminal event of the person's terminals (`subscribeTerminalEvents`). */
  readonly events: Stream.Stream<TerminalEvent, SubscriberFellBehind>;
  /** The person's terminals, then each change (`subscribeTerminalMetadata`). */
  readonly metadata: Stream.Stream<TerminalMetadataStreamEvent, SubscriberFellBehind>;
  /** Ends every terminal: the hub is going. */
  readonly closeAll: Effect.Effect<void>;
}

/** `/api/tty?ticket=&process=` on Mend's origin, as a WebSocket URL. */
export const ttyUrlOf = (mendUrl: URL, processId: string, ticket: string): string => {
  const url = new URL("/api/tty", mendUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("process", processId);
  return url.toString();
};

const keyOf = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;

const snapshotOf = (terminal: Terminal): TerminalSessionSnapshot => ({
  threadId: terminal.threadId,
  terminalId: terminal.terminalId,
  cwd: terminal.cwd,
  worktreePath: terminal.worktreePath,
  status: terminal.status,
  pid: null,
  history: terminal.history,
  exitCode: null,
  exitSignal: null,
  label: "shell",
  updatedAt: terminal.updatedAt,
  sequence: terminal.sequence,
});

const summaryOf = (terminal: Terminal): TerminalSummary => ({
  threadId: terminal.threadId,
  terminalId: terminal.terminalId,
  cwd: terminal.cwd,
  worktreePath: terminal.worktreePath,
  status: terminal.status,
  pid: null,
  exitCode: null,
  exitSignal: null,
  hasRunningSubprocess: false,
  label: "shell",
  updatedAt: terminal.updatedAt,
});

/** The words of Mend's end frame. */
const isEndFrame = (text: string): boolean => {
  try {
    const frame: unknown = JSON.parse(text);
    return typeof frame === "object" && frame !== null && "t" in frame && frame.t === "end";
  } catch {
    return false;
  }
};

const lookup = (threadId: string, terminalId: string) =>
  new TerminalSessionLookupError({ threadId, terminalId });
const notRunning = (threadId: string, terminalId: string) =>
  new TerminalNotRunningError({ threadId, terminalId });

export const makeTerminals = (host: TerminalHost): Terminals => {
  const { mend } = host;
  const terminals = new Map<string, Terminal>();
  const events = makeFanout<TerminalEvent>();
  const metadata = makeFanout<TerminalMetadataStreamEvent>();

  /** Stamps and publishes one event of a terminal, and its summary when its state moved. */
  const publish = (
    terminal: Terminal,
    event: (base: {
      readonly threadId: string;
      readonly terminalId: string;
      readonly sequence: number;
    }) => TerminalEvent,
    moved = false,
  ) =>
    Effect.gen(function* () {
      terminal.sequence += 1;
      terminal.updatedAt = new Date().toISOString();
      yield* events.publish([
        event({
          threadId: terminal.threadId,
          terminalId: terminal.terminalId,
          sequence: terminal.sequence,
        }),
      ]);
      if (moved) yield* metadata.publish([{ type: "upsert", terminal: summaryOf(terminal) }]);
    });

  /** The socket is gone: the terminal has exited, once. */
  const ended = (terminal: Terminal) =>
    Effect.suspend(() => {
      if (terminal.status === "exited") return Effect.void;
      terminal.status = "exited";
      terminal.writer = null;
      return publish(
        terminal,
        (base) => ({ ...base, type: "exited", exitCode: null, exitSignal: null }),
        true,
      );
    });

  /** Mend's refusal of opening a shell, in t3code's terms. */
  const shellRefusal =
    (threadId: string, terminalId: string) =>
    (error: MendCommandFailure): TerminalFailure =>
      error._tag === "MendDeviceRefused" ||
      (error._tag === "MendCommandRefused" && error.status === 403)
        ? new EnvironmentAuthorizationError({
            message:
              error._tag === "MendDeviceRefused"
                ? "Mend no longer accepts this device. Pair again from Mend."
                : "Only the session's owner opens a terminal in it. Ask them in Mend.",
            requiredScope: AuthTerminalOperateScope,
          })
        : error._tag === "MendNotFound"
          ? lookup(threadId, terminalId)
          : notRunning(threadId, terminalId);

  /** Opens Mend's shell for the thread and its socket, with a ticket spent at once. */
  const connect = (
    session: BearerSession,
    terminal: Terminal,
    sessionId: string,
    size: { readonly cols?: number | undefined; readonly rows?: number | undefined },
  ) =>
    Effect.gen(function* () {
      const token = session.deviceToken;
      const refusal = shellRefusal(terminal.threadId, terminal.terminalId);
      const shell = yield* mend.openShell(token, sessionId).pipe(Effect.mapError(refusal));
      terminal.processId = shell.id;
      const ticket = yield* mend.ttyTicket(token, shell.id).pipe(Effect.mapError(refusal));
      const scope = Scope.makeUnsafe();
      const opened = yield* Effect.gen(function* () {
        const socket = yield* Socket.makeWebSocket(
          ttyUrlOf(host.mendUrl, shell.id, Redacted.value(ticket)),
          { openTimeout: OPEN_TIMEOUT },
        );
        const reader = yield* socket.reader;
        const writer = yield* socket.writer;
        return { reader, writer };
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
        Effect.result,
      );
      if (opened._tag === "Failure") {
        yield* Scope.close(scope, Exit.void);
        // The ticket is in the URL: only that the socket did not open is logged.
        yield* Effect.logWarning("t3 gateway could not open Mend's terminal socket");
        return yield* notRunning(terminal.threadId, terminal.terminalId);
      }
      terminal.scope = scope;
      terminal.writer = opened.success.writer;
      terminal.status = "running";
      const decoder = new TextDecoder();
      yield* Effect.forever(
        opened.success.reader.pull.pipe(
          Effect.flatMap((chunks) =>
            Effect.forEach(
              chunks,
              (chunk) => {
                if (typeof chunk === "string") {
                  return isEndFrame(chunk) ? ended(terminal) : Effect.void;
                }
                const data = decoder.decode(chunk, { stream: true });
                if (data.length === 0) return Effect.void;
                terminal.history = `${terminal.history}${data}`.slice(-HISTORY_LIMIT);
                return publish(terminal, (base) => ({ ...base, type: "output", data }));
              },
              { discard: true },
            ),
          ),
        ),
      ).pipe(
        Effect.catch(() => ended(terminal)),
        Effect.forkIn(scope),
      );
      if (size.cols !== undefined && size.rows !== undefined) {
        yield* opened.success.writer
          .write(JSON.stringify({ t: "resize", cols: size.cols, rows: size.rows }))
          .pipe(Effect.ignore);
      }
    });

  /** Ends a terminal's socket and its shell in Mend. */
  const disconnect = (session: BearerSession | null, terminal: Terminal) =>
    Effect.gen(function* () {
      const scope = terminal.scope;
      terminal.scope = null;
      terminal.writer = null;
      if (scope !== null) yield* Scope.close(scope, Exit.void);
      const processId = terminal.processId;
      terminal.processId = null;
      if (session !== null && processId !== null) {
        yield* mend
          .stopShell(session.deviceToken, processId)
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("t3 gateway could not stop a terminal's shell in Mend"),
            ),
          );
      }
    });

  const start = (
    session: BearerSession,
    input: Pick<
      TerminalOpenInput,
      "threadId" | "terminalId" | "cwd" | "worktreePath" | "cols" | "rows"
    >,
  ) =>
    Effect.gen(function* () {
      const sessionId = yield* host.threadSession(input.threadId);
      if (sessionId === null) return yield* lookup(input.threadId, input.terminalId);
      const terminal: Terminal = {
        threadId: input.threadId,
        terminalId: input.terminalId,
        cwd: input.cwd,
        worktreePath: input.worktreePath ?? null,
        status: "starting",
        history: terminals.get(keyOf(input.threadId, input.terminalId))?.history ?? "",
        processId: null,
        updatedAt: new Date().toISOString(),
        sequence: terminals.get(keyOf(input.threadId, input.terminalId))?.sequence ?? 0,
        openedBy: session,
        scope: null,
        writer: null,
      };
      // Kept before Mend opens the shell, so `close` and the hub's end always find it; a failure
      // anywhere after the shell opened (ticket, socket, interruption) stops that shell again,
      // and the terminal held before, if any, is kept as it was.
      const key = keyOf(input.threadId, input.terminalId);
      const previous = terminals.get(key);
      terminals.set(key, terminal);
      yield* connect(session, terminal, sessionId, input).pipe(
        Effect.onError(() =>
          disconnect(session, terminal).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (terminals.get(key) !== terminal) return;
                if (previous === undefined) terminals.delete(key);
                else terminals.set(key, previous);
              }),
            ),
          ),
        ),
      );
      return terminal;
    });

  const open: Terminals["open"] = (session, input) =>
    Effect.gen(function* () {
      const known = terminals.get(keyOf(input.threadId, input.terminalId));
      if (known !== undefined && known.status === "running") return snapshotOf(known);
      const terminal = yield* start(session, input);
      yield* publish(
        terminal,
        (base) => ({ ...base, type: "started", snapshot: snapshotOf(terminal) }),
        true,
      );
      return snapshotOf(terminal);
    });

  const attach: Terminals["attach"] = (session, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribed first: nothing between the snapshot and the stream is missed.
        const changes = yield* events.subscribe(
          (event) => event.threadId === input.threadId && event.terminalId === input.terminalId,
        );
        let terminal = terminals.get(keyOf(input.threadId, input.terminalId));
        const restart =
          input.restartIfNotRunning === true &&
          (terminal === undefined || terminal.status !== "running");
        if ((terminal === undefined || restart) && input.cwd !== undefined) {
          terminal = yield* start(session, { ...input, cwd: input.cwd });
          yield* metadata.publish([{ type: "upsert", terminal: summaryOf(terminal) }]);
        }
        if (terminal === undefined) return yield* lookup(input.threadId, input.terminalId);
        const snapshot: TerminalAttachStreamEvent = {
          type: "snapshot",
          snapshot: snapshotOf(terminal),
        };
        const live: Stream.Stream<TerminalAttachStreamEvent, TerminalFailure> = changes.pipe(
          // A client too slow to keep up resubscribes: t3code retries a typed failure.
          Stream.mapError(() => notRunning(input.threadId, input.terminalId)),
          Stream.filter(
            (event): event is Exclude<TerminalEvent, { readonly type: "started" }> =>
              event.type !== "started",
          ),
        );
        return Stream.make(snapshot).pipe(Stream.concat(live));
      }),
    );

  const running = (
    threadId: string,
    terminalId: string,
  ): Effect.Effect<Socket.Writer, TerminalSessionLookupError | TerminalNotRunningError> =>
    Effect.suspend(
      (): Effect.Effect<Socket.Writer, TerminalSessionLookupError | TerminalNotRunningError> => {
        const terminal = terminals.get(keyOf(threadId, terminalId));
        if (terminal === undefined) return Effect.fail(lookup(threadId, terminalId));
        if (terminal.writer === null) return Effect.fail(notRunning(threadId, terminalId));
        return Effect.succeed(terminal.writer);
      },
    );

  const write: Terminals["write"] = (input) =>
    running(input.threadId, input.terminalId).pipe(
      Effect.flatMap((writer) =>
        writer.write(new TextEncoder().encode(input.data)).pipe(
          Effect.mapError(
            (cause) =>
              new TerminalWriteError({
                threadId: input.threadId,
                terminalId: input.terminalId,
                terminalPid: 0,
                cause,
              }),
          ),
        ),
      ),
    );

  const resize: Terminals["resize"] = (input) =>
    running(input.threadId, input.terminalId).pipe(
      Effect.flatMap((writer) =>
        writer.write(JSON.stringify({ t: "resize", cols: input.cols, rows: input.rows })).pipe(
          Effect.mapError(
            (cause) =>
              new TerminalResizeError({
                threadId: input.threadId,
                terminalId: input.terminalId,
                terminalPid: 0,
                cols: input.cols,
                rows: input.rows,
                cause,
              }),
          ),
        ),
      ),
    );

  const clear: Terminals["clear"] = (input) =>
    Effect.suspend(() => {
      const terminal = terminals.get(keyOf(input.threadId, input.terminalId));
      if (terminal === undefined) return Effect.fail(lookup(input.threadId, input.terminalId));
      terminal.history = "";
      return publish(terminal, (base) => ({ ...base, type: "cleared" }));
    });

  const restart: Terminals["restart"] = (session, input) =>
    Effect.gen(function* () {
      const known = terminals.get(keyOf(input.threadId, input.terminalId));
      if (known !== undefined) yield* disconnect(session, known);
      const terminal = yield* start(session, input);
      yield* publish(
        terminal,
        (base) => ({ ...base, type: "restarted", snapshot: snapshotOf(terminal) }),
        true,
      );
      return snapshotOf(terminal);
    });

  const close: Terminals["close"] = (session, input) =>
    Effect.forEach(
      Array.from(terminals.values()).filter(
        (terminal) =>
          terminal.threadId === input.threadId &&
          (input.terminalId === undefined || terminal.terminalId === input.terminalId),
      ),
      (terminal) =>
        Effect.gen(function* () {
          yield* disconnect(session, terminal);
          terminal.status = "exited";
          yield* publish(terminal, (base) => ({ ...base, type: "closed" }));
          if (input.deleteHistory === true) {
            terminals.delete(keyOf(terminal.threadId, terminal.terminalId));
            yield* metadata.publish([
              { type: "remove", threadId: terminal.threadId, terminalId: terminal.terminalId },
            ]);
          } else {
            yield* metadata.publish([{ type: "upsert", terminal: summaryOf(terminal) }]);
          }
        }),
      { discard: true },
    );

  const metadataStream: Stream.Stream<TerminalMetadataStreamEvent, SubscriberFellBehind> =
    Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* metadata.subscribe(() => true);
        const snapshot: TerminalMetadataStreamEvent = {
          type: "snapshot",
          terminals: Array.from(terminals.values(), summaryOf),
        };
        return Stream.make(snapshot).pipe(Stream.concat(changes));
      }),
    );

  const eventStream: Stream.Stream<TerminalEvent, SubscriberFellBehind> = Stream.unwrap(
    events.subscribe(() => true),
  );

  // The terminals as they are when the hub goes, not when it was made: each socket closed and
  // each shell stopped in Mend, with the token of the person who opened it.
  const closeAll = Effect.suspend(() =>
    Effect.forEach(
      Array.from(terminals.values()),
      (terminal) => disconnect(terminal.openedBy, terminal),
      { discard: true },
    ),
  );

  return {
    open,
    attach,
    write,
    resize,
    clear,
    restart,
    close,
    events: eventStream,
    metadata: metadataStream,
    closeAll,
  };
};
