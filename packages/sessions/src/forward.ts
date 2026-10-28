import { randomUUID } from "node:crypto";

import type { SealantWorkspaceId } from "@mend/domain";
import {
  type ForwardBinding,
  type ForwardBytes,
  type ForwardIssue,
  type ForwardIssueReason,
  forwardIssueOf,
  SealantClient,
  type SealantPlatformError,
} from "@mend/sealant";
import type { Workspace } from "@sealant/sdk";
import { Cause, Clock, Data, Duration, Effect, Exit, Layer, Option, type Scope } from "effect";
import * as Context from "effect/Context";

/**
 * The one way Mend turns a workspace port into bytes over TCP (ADR 0017, delivery 5): ServiceHost's
 * listener, the Service tunnel and the readiness probe open forwards here, as the preview gateway
 * (step 7) is to.
 * It owns the dial: one workspace lookup, the loopback dial, the Docker dial only after a typed
 * loopback connection refusal, one deadline over all of it, cancellation, and one dial trace per
 * dial. The principal is the caller's, from context (`asSealantUser`); UDP stays on the SDK's
 * legacy forward.
 */

/** One workspace port, and what holding it must prove. */
export interface ForwardTarget {
  readonly workspaceId: SealantWorkspaceId;
  readonly port: number;
  readonly binding: ForwardBinding;
}

/** A port anything may hold. Every Service dials this way until one dials bound (ADR 0017). */
export const portTarget = (workspaceId: SealantWorkspaceId, port: number): ForwardTarget => ({
  workspaceId,
  port,
  binding: { kind: "port" },
});

/** Which consumer dialled: it labels the trace and sets how long the dial may take. */
export type ForwardPurpose = "service" | "tunnel" | "readiness" | "preview" | "benchmark";

const DIAL_TIMEOUT_MS = {
  service: 30_000,
  tunnel: 30_000,
  readiness: 5_000,
  preview: 30_000,
  benchmark: 30_000,
} as const satisfies Record<ForwardPurpose, number>;

export interface ForwardOpenOptions {
  readonly purpose: ForwardPurpose;
  /** Shortens the purpose's dial timeout, never lengthens it. */
  readonly timeoutMs?: number;
  /** Gives up the dial, the lookup included, and resets the forward once it is open. */
  readonly signal?: AbortSignal;
}

export type ForwardArrival =
  | { readonly route: "loopback"; readonly proof: ForwardBinding }
  | { readonly route: "docker"; readonly proof: { readonly kind: "port" } };

export type ForwardAttemptOutcome = "ready" | ForwardIssueReason;

interface Attempt<Route extends "loopback" | "docker", Outcome extends ForwardAttemptOutcome> {
  readonly route: Route;
  readonly openMs: number;
  readonly outcome: Outcome;
}

/** Docker is tried only after a loopback connection refusal. */
export type ForwardAttempts =
  | readonly []
  | readonly [Attempt<"loopback", ForwardAttemptOutcome>]
  | readonly [Attempt<"loopback", "connection-refused">, Attempt<"docker", ForwardAttemptOutcome>];

/**
 * One dial's phases, on the monotonic clock. `openMs` is the SDK call: Core's authentication,
 * daemon lookup, runtime connection and the TCP connect inside the workspace, which Mend cannot
 * split. `lookupMs` is null when the dial ended before the lookup finished.
 */
export interface DialTrace {
  readonly dialId: string;
  readonly purpose: ForwardPurpose;
  readonly workspaceId: SealantWorkspaceId;
  readonly port: number;
  readonly requested: ForwardBinding;
  readonly lookupMs: number | null;
  readonly attempts: ForwardAttempts;
  readonly totalMs: number;
}

export type ForwardDialRecord = DialTrace &
  (
    | { readonly kind: "ready"; readonly arrival: ForwardArrival }
    | { readonly kind: "failed"; readonly issue: ForwardIssue }
  );

export type ForwardReady = Extract<ForwardDialRecord, { readonly kind: "ready" }>;
export type ForwardRefused = Extract<ForwardDialRecord, { readonly kind: "failed" }>;

/** A dial that gave no forward. Its record is the only place the reason is kept. */
export class ForwardDialFailure extends Data.TaggedError("ForwardDialFailure")<{
  readonly record: ForwardRefused;
}> {}

/** Bytes of an open forward, owned by the scope it was opened in. */
export interface ForwardConnection {
  readonly bytes: ForwardBytes;
  readonly record: ForwardReady;
}

export interface ForwardAdapterShape {
  /** A forward, open until the scope closes. Expected failures carry the dial's record. */
  readonly open: (
    target: ForwardTarget,
    options: ForwardOpenOptions,
  ) => Effect.Effect<ForwardConnection, ForwardDialFailure, Scope.Scope>;
  /** Opens and closes one forward, reading no bytes: what answered, or why nothing did. */
  readonly probe: (
    target: ForwardTarget,
    options: ForwardOpenOptions,
  ) => Effect.Effect<ForwardDialRecord>;
}

export class ForwardAdapter extends Context.Service<ForwardAdapter, ForwardAdapterShape>()(
  "@mend/sessions/ForwardAdapter",
) {}

/**
 * A session-bound dial never falls back to the sidecar: the sidecar cannot prove the session
 * (ADR 0017, decided by Yiannis, 2026-10-25).
 */
export const dockerAfterLoopback = (requested: ForwardBinding, loopback: ForwardIssue): boolean =>
  loopback.reason === "connection-refused" && requested.kind === "port";

/**
 * The refusal to report after both attempts: the loopback one when the sidecar is absent or holds
 * nothing on the port ("nothing listens on 127.0.0.1:port"), the sidecar's when it says more.
 */
export const reportedIssue = (loopback: ForwardIssue, docker: ForwardIssue): ForwardIssue =>
  docker.reason === "name-unresolved" || docker.reason === "connection-refused" ? loopback : docker;

/** What a readiness wait does with a refusal: poll again within its deadline, or stop now. */
export type ForwardStartupAction = "retry" | "stop";

const STARTUP_ACTION = {
  "connection-refused": "retry",
  "name-unresolved": "retry",
  "network-unreachable": "retry",
  "dial-failed": "retry",
  "dial-timeout": "retry",
  "workspace-not-ready": "retry",
  "runtime-unreachable": "retry",
  "runtime-untargetable": "retry",
  "transport-unavailable": "retry",
  "budget-exceeded": "retry",
  "deadline-exceeded": "retry",
  internal: "retry",
  "platform-failed": "retry",
  "not-found": "stop",
  unauthorized: "stop",
  forbidden: "stop",
  no_standing: "stop",
  creator_no_access: "stop",
  NO_PRINCIPAL: "stop",
  UNKNOWN_USER: "stop",
  "owner-exited": "stop",
  "owner-required": "stop",
  "invalid-target": "stop",
  "peer-mismatch": "stop",
  "binding-unverifiable": "stop",
  "binding-unsupported": "stop",
  "protocol-unsupported": "stop",
  "unrecognized-refusal": "stop",
  cancelled: "stop",
} as const satisfies Record<ForwardIssueReason, ForwardStartupAction>;

export const forwardStartupAction = (issue: ForwardIssue): ForwardStartupAction =>
  STARTUP_ACTION[issue.reason];

const issue = (reason: "cancelled" | "deadline-exceeded", message: string): ForwardIssue => ({
  reason,
  message,
});

type Phase<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly issue: ForwardIssue };

const makeForwardAdapter = Effect.gen(function* () {
  const sealant = yield* SealantClient;

  const open = (
    target: ForwardTarget,
    options: ForwardOpenOptions,
  ): Effect.Effect<ForwardConnection, ForwardDialFailure, Scope.Scope> =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const now = () => clock.currentTimeNanosUnsafe();
      const started = now();
      const timeoutMs = Math.min(
        DIAL_TIMEOUT_MS[options.purpose],
        Math.max(0, Math.floor(options.timeoutMs ?? Number.POSITIVE_INFINITY)),
      );
      const deadline = started + BigInt(timeoutMs) * 1_000_000n;
      const elapsedMs = (from: bigint) => Number(now() - from) / 1_000_000;
      const remainingMs = () => Math.max(0, Number(deadline - now()) / 1_000_000);
      const cancelled = () => issue("cancelled", "the dial was given up");
      const lateIssue = () => issue("deadline-exceeded", `no forward within ${timeoutMs} ms`);

      // What the trace holds so far, so an interrupted dial still leaves its one record.
      const progress: {
        lookupMs: number | null;
        attempts: ForwardAttempts;
        refusedLoopback: Attempt<"loopback", "connection-refused"> | null;
        inFlightSince: bigint | null;
      } = { lookupMs: null, attempts: [], refusedLoopback: null, inFlightSince: null };

      const base = {
        dialId: randomUUID(),
        purpose: options.purpose,
        workspaceId: target.workspaceId,
        port: target.port,
        requested: target.binding,
      };
      const ready = (arrival: ForwardArrival): ForwardReady => ({
        ...base,
        lookupMs: progress.lookupMs,
        attempts: progress.attempts,
        totalMs: elapsedMs(started),
        kind: "ready",
        arrival,
      });
      const refused = (reason: ForwardIssue): ForwardRefused => ({
        ...base,
        lookupMs: progress.lookupMs,
        attempts: progress.attempts,
        totalMs: elapsedMs(started),
        kind: "failed",
        issue: reason,
      });

      // One controller for the dial and the forward it gives: the caller's signal, then the scope.
      const lifetime = new AbortController();
      const onAbort = () => lifetime.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          options.signal?.removeEventListener("abort", onAbort);
          lifetime.abort();
        }),
      );

      const givenUp = Effect.callback<Phase<never>>((resume) => {
        const onGivenUp = () => resume(Effect.succeed({ ok: false, issue: cancelled() }));
        if (lifetime.signal.aborted) return onGivenUp();
        lifetime.signal.addEventListener("abort", onGivenUp, { once: true });
        return Effect.sync(() => lifetime.signal.removeEventListener("abort", onGivenUp));
      });

      const settled = <A, R>(
        self: Effect.Effect<A, SealantPlatformError, R>,
      ): Effect.Effect<Phase<A>, never, R> =>
        Effect.raceFirst(
          self.pipe(
            Effect.timeoutOption(Duration.millis(remainingMs())),
            Effect.map(
              (result): Phase<A> =>
                Option.isSome(result)
                  ? { ok: true, value: result.value }
                  : { ok: false, issue: lateIssue() },
            ),
            Effect.catch((error) =>
              Effect.succeed<Phase<A>>({
                ok: false,
                issue: lifetime.signal.aborted
                  ? cancelled()
                  : now() >= deadline
                    ? lateIssue()
                    : forwardIssueOf(error),
              }),
            ),
          ),
          givenUp,
        );

      const attempt = (workspace: Workspace, route: "loopback" | "docker") =>
        Effect.gen(function* () {
          const attemptStarted = now();
          progress.inFlightSince = attemptStarted;
          const opened = yield* settled(
            sealant.openForward(
              workspace,
              target.port,
              route === "loopback"
                ? { route: "loopback", binding: target.binding }
                : { route: "docker", binding: { kind: "port" } },
              { signal: lifetime.signal, deadlineMs: Math.max(1, Math.ceil(remainingMs())) },
            ),
          );
          progress.inFlightSince = null;
          return { opened, openMs: elapsedMs(attemptStarted) };
        });

      const dial = Effect.gen(function* () {
        if (options.signal?.aborted === true)
          return yield* new ForwardDialFailure({ record: refused(cancelled()) });

        const lookupStarted = now();
        const workspace = yield* settled(sealant.getWorkspace(target.workspaceId));
        const lookupAnswered =
          workspace.ok ||
          (workspace.issue.reason !== "cancelled" &&
            workspace.issue.reason !== "deadline-exceeded");
        if (lookupAnswered) progress.lookupMs = elapsedMs(lookupStarted);
        if (!workspace.ok)
          return yield* new ForwardDialFailure({ record: refused(workspace.issue) });

        const loopback = yield* attempt(workspace.value, "loopback");
        if (loopback.opened.ok) {
          progress.attempts = [{ route: "loopback", openMs: loopback.openMs, outcome: "ready" }];
          const arrival: ForwardArrival = {
            route: "loopback",
            proof: loopback.opened.value.binding,
          };
          return { bytes: loopback.opened.value.bytes, arrival };
        }
        const loopbackIssue = loopback.opened.issue;
        if (
          loopbackIssue.reason !== "connection-refused" ||
          !dockerAfterLoopback(target.binding, loopbackIssue)
        ) {
          progress.attempts = [
            { route: "loopback", openMs: loopback.openMs, outcome: loopbackIssue.reason },
          ];
          return yield* new ForwardDialFailure({ record: refused(loopbackIssue) });
        }
        const refusedLoopback: Attempt<"loopback", "connection-refused"> = {
          route: "loopback",
          openMs: loopback.openMs,
          outcome: "connection-refused",
        };
        progress.attempts = [refusedLoopback];
        progress.refusedLoopback = refusedLoopback;

        const docker = yield* attempt(workspace.value, "docker");
        if (docker.opened.ok) {
          progress.attempts = [
            refusedLoopback,
            { route: "docker", openMs: docker.openMs, outcome: "ready" },
          ];
          const arrival: ForwardArrival = { route: "docker", proof: { kind: "port" } };
          return { bytes: docker.opened.value.bytes, arrival };
        }
        progress.attempts = [
          refusedLoopback,
          { route: "docker", openMs: docker.openMs, outcome: docker.opened.issue.reason },
        ];
        return yield* new ForwardDialFailure({
          record: refused(reportedIssue(loopbackIssue, docker.opened.issue)),
        });
      });

      const unfinished = (cause: Cause.Cause<unknown>): ForwardRefused => {
        const reason: ForwardIssue = Cause.hasInterruptsOnly(cause)
          ? cancelled()
          : { reason: "platform-failed", code: "defect", message: Cause.pretty(cause) };
        if (progress.inFlightSince !== null) {
          const openMs = elapsedMs(progress.inFlightSince);
          progress.attempts =
            progress.refusedLoopback === null
              ? [{ route: "loopback", openMs, outcome: reason.reason }]
              : [progress.refusedLoopback, { route: "docker", openMs, outcome: reason.reason }];
        }
        return refused(reason);
      };

      return yield* dial.pipe(
        Effect.map(({ bytes, arrival }): ForwardConnection => ({ bytes, record: ready(arrival) })),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? logDial(exit.value.record)
            : Option.match(Exit.findErrorOption(exit), {
                onNone: () => logDial(unfinished(exit.cause)),
                onSome: (failure) => logDial(failure.record),
              }),
        ),
      );
    });

  const probe = (target: ForwardTarget, options: ForwardOpenOptions) =>
    Effect.scoped(open(target, options)).pipe(
      Effect.map((connection): ForwardDialRecord => connection.record),
      Effect.catchTag("ForwardDialFailure", (failure) =>
        Effect.succeed<ForwardDialRecord>(failure.record),
      ),
    );

  return { open, probe } satisfies ForwardAdapterShape;
});

const logDial = (record: ForwardDialRecord) =>
  (record.purpose === "readiness"
    ? Effect.logDebug("forward.dial")
    : Effect.logInfo("forward.dial")
  ).pipe(Effect.annotateLogs({ dial: JSON.stringify(record) }));

export const ForwardAdapterLive: Layer.Layer<ForwardAdapter, never, SealantClient> = Layer.effect(
  ForwardAdapter,
  makeForwardAdapter,
);
