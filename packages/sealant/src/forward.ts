import type {
  BoundedWorkspaceForward,
  BoundedWorkspaceForwardOptions,
  ForwardDialReason,
  ForwardResetCause,
  Workspace,
} from "@sealant/sdk";
import { ForwardDialError, ForwardResetError } from "@sealant/sdk";
import { Effect, Schema } from "effect";

import type { SealantPlatformError } from "./errors.ts";

/**
 * Mend's side of the SDK's bounded TCP forward (ADR 0017, "The preview gateway"): the domain types
 * the forward adapter in `@mend/sessions` works in, and the one translation from SDK values into
 * them.
 */

/** A Sealant supporting-process session id: the PTY a Service attempt runs as, never a Mend id. */
export const ForwardSessionOwner = Schema.NonEmptyString.pipe(Schema.brand("ForwardSessionOwner"));
export type ForwardSessionOwner = typeof ForwardSessionOwner.Type;

/**
 * What a forward is asked to prove, and what an open one proved: that something holds the port, or
 * that a process of one session does.
 */
export type ForwardBinding =
  | { readonly kind: "port" }
  | { readonly kind: "session"; readonly session: ForwardSessionOwner };

/**
 * Where one dial goes. The Docker sidecar cannot prove a session, so a bound Docker dial has no
 * type.
 */
export type ForwardDestination =
  | { readonly route: "loopback"; readonly binding: ForwardBinding }
  | { readonly route: "docker"; readonly binding: { readonly kind: "port" } };

/**
 * The refusals the SDK names. A reason a newer SDK adds fails the table below until it is placed.
 */
type SdkDialReason = Exclude<ForwardDialReason, "unrecognized-refusal">;

const SDK_DIAL_REASONS = {
  "workspace-not-ready": true,
  "runtime-unreachable": true,
  "runtime-untargetable": true,
  "connection-refused": true,
  "name-unresolved": true,
  "network-unreachable": true,
  "dial-timeout": true,
  "dial-failed": true,
  "not-found": true,
  unauthorized: true,
  forbidden: true,
  "budget-exceeded": true,
  "invalid-target": true,
  "owner-required": true,
  internal: true,
  "owner-exited": true,
  "peer-mismatch": true,
  "binding-unverifiable": true,
  "binding-unsupported": true,
  "protocol-unsupported": true,
  "transport-unavailable": true,
} as const satisfies Record<SdkDialReason, true>;

/**
 * Mend's own refusals, before Core is asked: the workspace caller's rule and the principal's
 * client.
 */
export const MEND_FORWARD_REFUSALS = [
  "no_standing",
  "creator_no_access",
  "NO_PRINCIPAL",
  "UNKNOWN_USER",
] as const;
export type MendForwardRefusal = (typeof MEND_FORWARD_REFUSALS)[number];

/**
 * Why a dial did not give a forward, closed. `unrecognized-refusal` keeps the reason Core sent,
 * `platform-failed` keeps the code of a failure that is neither a forward refusal nor Mend's.
 */
export type ForwardIssue =
  | { readonly reason: SdkDialReason | MendForwardRefusal; readonly message: string }
  | {
      readonly reason: "unrecognized-refusal";
      readonly wireReason: string;
      readonly message: string;
    }
  | { readonly reason: "platform-failed"; readonly code: string; readonly message: string }
  | { readonly reason: "cancelled" | "deadline-exceeded"; readonly message: string };

export type ForwardIssueReason = ForwardIssue["reason"];

const isSdkDialReason = (reason: string): reason is SdkDialReason => reason in SDK_DIAL_REASONS;
const isMendRefusal = (code: string): code is MendForwardRefusal =>
  MEND_FORWARD_REFUSALS.some((refusal) => refusal === code);

const FINAL_STATUS: Partial<Record<number, "unauthorized" | "forbidden" | "not-found">> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
};

/**
 * Why a lookup or an open failed: from the SDK's typed error, else Mend's code, else Core's status,
 * never message text.
 */
export const forwardIssueOf = (error: SealantPlatformError): ForwardIssue => {
  const cause: unknown = error.cause;
  if (cause instanceof ForwardDialError) {
    if (cause.reason === "unrecognized-refusal") {
      return {
        reason: "unrecognized-refusal",
        wireReason: (cause.wireReason ?? "").slice(0, 64),
        message: cause.message,
      };
    }
    if (isSdkDialReason(cause.reason)) return { reason: cause.reason, message: cause.message };
  }
  if (isMendRefusal(error.code)) return { reason: error.code, message: error.message };
  const final = error.status === null ? undefined : FINAL_STATUS[error.status];
  if (final !== undefined) return { reason: final, message: error.message };
  return { reason: "platform-failed", code: error.code, message: error.message };
};

/** Why an open forward failed. Bytes already written are never replayed after any of these. */
export const FORWARD_RESET_REASONS = [
  "window-exceeded",
  "protocol-violation",
  "aborted",
  "target-error",
  "runtime-lost",
  "owner-exited",
  "connection-lost",
  "unrecognized-reset",
  "workspace-ended",
  "write-finished",
  "io-failed",
] as const;
export type ForwardResetReason = (typeof FORWARD_RESET_REASONS)[number];

/** Fails to compile when the SDK names a reset cause this list does not. */
const everySdkResetCause: [Exclude<ForwardResetCause, ForwardResetReason>] extends [never]
  ? true
  : never = true;
void everySdkResetCause;

export class ForwardIoFailure extends Schema.TaggedError<ForwardIoFailure>()("ForwardIoFailure", {
  reason: Schema.Literals(FORWARD_RESET_REASONS),
  message: Schema.String,
}) {}

const ioFailureOf = (cause: unknown): ForwardIoFailure =>
  cause instanceof ForwardResetError
    ? new ForwardIoFailure({ reason: cause.reason, message: cause.message })
    : new ForwardIoFailure({
        reason: "io-failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });

export type ForwardRead =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "eof" };

/**
 * One open forward's bytes: one reader and one sequential writer. `write` returns once the
 * workspace has room, so a producer that awaits it is held back. `finish` is the half-close
 * (idempotent; reading stays open). `close` resets both directions (idempotent).
 *
 * The workspace ending its side ends the write direction too: from then on `write` and `finish`
 * drop what they are given, and `read` still returns everything the workspace sent. EOF from `read`
 * comes after every byte the workspace sent, unless the workspace ended without taking everything
 * the client sent before its FIN: that, and every other reset, fails `read`.
 */
export interface ForwardBytes {
  readonly read: () => Effect.Effect<ForwardRead, ForwardIoFailure>;
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ForwardIoFailure>;
  readonly finish: () => Effect.Effect<void, ForwardIoFailure>;
  readonly close: () => Effect.Effect<void>;
}

/** A forward Core has opened, with the binding it confirmed. */
export interface OpenedForward {
  readonly binding: ForwardBinding;
  readonly bytes: ForwardBytes;
}

const bindingOf = (sdk: BoundedWorkspaceForward["binding"]): ForwardBinding =>
  sdk.kind === "port"
    ? { kind: "port" }
    : { kind: "session", session: ForwardSessionOwner.make(sdk.session) };

const workspaceEnded = (cause: unknown): boolean =>
  cause instanceof ForwardResetError && cause.reason === "workspace-ended";

/**
 * The byte operations over the SDK's web streams. Owns both stream locks for the forward's life.
 */
export const forwardBytesOf = (forward: BoundedWorkspaceForward): ForwardBytes => {
  const reader = forward.readable.getReader();
  const writer = forward.writable.getWriter();
  let sending: "open" | "finished" | "ended" = "open";
  const unlessEnded = (operation: () => Promise<void>) =>
    Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
      Effect.catch((cause) => {
        if (!workspaceEnded(cause)) return Effect.fail(ioFailureOf(cause));
        sending = "ended";
        return Effect.void;
      }),
    );
  // A workspace that ended while the client was still sending has answered it (an early 413).
  const answeredEarly = (reason: ForwardResetCause): boolean =>
    reason === "workspace-ended" && sending !== "finished";
  const outcome = Effect.promise(() => forward.closed).pipe(
    Effect.flatMap((closed) =>
      closed.kind === "end" || answeredEarly(closed.reason)
        ? Effect.succeed<ForwardRead>({ kind: "eof" })
        : Effect.fail(
            new ForwardIoFailure({
              reason: closed.reason,
              message:
                closed.reason === "workspace-ended"
                  ? "the workspace ended before it took everything the client sent"
                  : `the forward was reset: ${closed.reason}`,
            }),
          ),
    ),
  );
  return {
    read: () =>
      Effect.tryPromise({ try: () => reader.read(), catch: ioFailureOf }).pipe(
        Effect.flatMap((next) =>
          next.done === true
            ? outcome
            : Effect.succeed<ForwardRead>({ kind: "bytes", bytes: next.value }),
        ),
      ),
    write: (bytes) =>
      Effect.suspend(() => {
        if (sending === "ended") return Effect.void;
        if (sending === "finished") {
          return Effect.fail(
            new ForwardIoFailure({
              reason: "write-finished",
              message: "the forward was half-closed",
            }),
          );
        }
        return unlessEnded(() => writer.write(bytes));
      }),
    finish: () =>
      Effect.suspend(() => {
        if (sending !== "open") return Effect.void;
        return unlessEnded(() => writer.close()).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (sending === "open") sending = "finished";
            }),
          ),
        );
      }),
    close: () => Effect.sync(() => forward.close()),
  };
};

/** The SDK's options for one destination: loopback (bound to a session or not) or the sidecar. */
const boundedForwardOptions = (
  destination: ForwardDestination,
  signal: AbortSignal,
  deadlineMs: number,
): BoundedWorkspaceForwardOptions => {
  if (destination.route === "docker")
    return { flow: "bounded", signal, deadlineMs, host: "docker" };
  return destination.binding.kind === "session"
    ? { flow: "bounded", signal, deadlineMs, session: destination.binding.session }
    : { flow: "bounded", signal, deadlineMs };
};

/**
 * Opens one bounded forward in the caller's scope. `signal` gives up the open, and resets the
 * forward once it is open; so does closing the scope. A forward the SDK hands back after either has
 * happened is reset at once: the slot is in the scope before the SDK is asked.
 */
export const openBoundedForward = (
  open: (signal: AbortSignal) => Promise<BoundedWorkspaceForward>,
  signal: AbortSignal,
  toError: (cause: unknown) => SealantPlatformError,
) =>
  Effect.gen(function* () {
    const slot: { forward: BoundedWorkspaceForward | null; released: boolean } = {
      forward: null,
      released: false,
    };
    const release = () => {
      slot.released = true;
      slot.forward?.close();
    };
    signal.addEventListener("abort", release, { once: true });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        signal.removeEventListener("abort", release);
        release();
      }),
    );
    const forward = yield* Effect.callback<BoundedWorkspaceForward, SealantPlatformError>(
      (resume, interrupted) => {
        const either = AbortSignal.any([signal, interrupted]);
        let opening: Promise<BoundedWorkspaceForward>;
        try {
          opening = open(either);
        } catch (cause) {
          return resume(Effect.fail(toError(cause)));
        }
        opening.then(
          (opened) => {
            if (slot.released || either.aborted) {
              opened.close();
              return resume(Effect.fail(toError(either.reason)));
            }
            slot.forward = opened;
            return resume(Effect.succeed(opened));
          },
          (cause: unknown) => resume(Effect.fail(toError(cause))),
        );
      },
    );
    return {
      binding: bindingOf(forward.binding),
      bytes: forwardBytesOf(forward),
    } satisfies OpenedForward;
  });

/** `openBoundedForward` on a workspace handle: what `SealantClient.openForward` runs. */
export const openWorkspaceForward = (
  workspace: Workspace,
  port: number,
  destination: ForwardDestination,
  options: { readonly signal: AbortSignal; readonly deadlineMs: number },
  toError: (cause: unknown) => SealantPlatformError,
) =>
  openBoundedForward(
    (signal) =>
      workspace.forward(port, boundedForwardOptions(destination, signal, options.deadlineMs)),
    options.signal,
    toError,
  );
