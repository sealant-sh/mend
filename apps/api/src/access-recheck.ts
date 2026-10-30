import { deviceIdOf } from "@mend/api-contracts";
import type { TicketCredential } from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import {
  Array as Arr,
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Option,
  Schedule,
  type Scope,
  Stream,
} from "effect";

import { type BusSignal, EventBus } from "./events-bus.ts";

/**
 * One admission-and-recheck policy for connections that outlive their admission: a preview's open
 * streams (ADR 0017) and a screen's viewers (ADR 0020). `ConnectionRegistry` closes a connection
 * when its account leaves the organization; it misses a project turning private and a device being
 * revoked. This policy rechecks every held connection when the bus says one of those may have
 * changed, and every `sweepEvery` in case a signal was lost, and stops each one that no longer
 * stands. A pass that cannot decide stops what it could not judge as `Unavailable`.
 */

/** Whose access a connection runs on: an account, and the sign-in or paired device it proved. */
export interface AccessSubject {
  readonly userId: string;
  readonly credential: TicketCredential | null;
}

/** What a recheck needs of one held connection to pick it out of a bus signal. */
export interface Admission {
  readonly subject: AccessSubject;
  readonly projectId: string;
  readonly organizationId: OrganizationId;
}

export type AccessStop<Refusal> =
  | { readonly _tag: "Refused"; readonly refusal: Refusal }
  | { readonly _tag: "Unavailable" };

export interface RecheckTiming {
  readonly sweepEvery: Duration.Input;
  readonly passDeadline: Duration.Input;
  /** How long a stopped connection's work may take to end before it is left behind. */
  readonly closeGrace: Duration.Input;
}

export interface RecheckOptions<A extends Admission, Refusal> {
  /** Names the policy in its logs. */
  readonly name: string;
  readonly timing: RecheckTiming;
  /** Connections in one group stand or fall together, so a pass judges each group once. */
  readonly groupOf: (admitted: A) => string;
  /** One verdict per entry, in order: null where it still stands. */
  readonly standing: (
    batch: ReadonlyArray<A>,
  ) => Effect.Effect<ReadonlyArray<Refusal | null>, unknown>;
}

export interface AccessRecheck<A extends Admission, Refusal> {
  /**
   * Admits, holds the admission, and runs `use` until it ends or a recheck stops it. A pass that
   * started during the admission may have missed it, so `admit` runs again then. `stopped` names
   * what to fail with: during the admission, before `use` started, or while it ran, after it was
   * interrupted (given `closeGrace` to end).
   */
  readonly hold: <B, E, R, AE, S>(request: {
    readonly admit: Effect.Effect<A, AE>;
    readonly use: (admitted: A) => Effect.Effect<B, E, R>;
    readonly stopped: (stop: AccessStop<Refusal>, during: "admission" | "use") => S;
  }) => Effect.Effect<B, E | AE | S, R>;
  /** What is held right now. */
  readonly held: () => ReadonlyArray<A>;
}

/**
 * `effect`, given up on at `deadline` without waiting for it to stop: a query parked on a pool
 * connection cannot be interrupted, and must not hold an answer past its bound.
 */
export const withinDeadline = <A, E>(
  scope: Scope.Scope,
  deadline: Duration.Input,
  effect: Effect.Effect<A, E>,
): Effect.Effect<Option.Option<A>, E> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const work = yield* Effect.forkIn(effect, scope);
      return yield* restore(Effect.timeoutOption(Fiber.join(work), deadline)).pipe(
        Effect.ensuring(Effect.sync(() => work.interruptUnsafe())),
      );
    }),
  );

const STANDING_BATCH = 500;
const RECHECK_CONCURRENCY = 4;

type Selection =
  | { readonly _tag: "Project"; readonly projectId: string }
  | { readonly _tag: "UserDevices"; readonly userId: string }
  | { readonly _tag: "User"; readonly userId: string }
  | { readonly _tag: "Organization"; readonly organizationId: string }
  | { readonly _tag: "All" };

const selectionOf = (signal: BusSignal): Selection | null => {
  if (signal.kind === "resync") return { _tag: "All" };
  const event = signal.event;
  switch (event.type) {
    case "project":
    case "worktree":
      return { _tag: "Project", projectId: event.projectId };
    case "user":
      if (event.facet === "devices") return { _tag: "UserDevices", userId: event.userId };
      return event.facet === "access" ? { _tag: "User", userId: event.userId } : null;
    case "organization":
      return { _tag: "Organization", organizationId: event.organizationId };
    default:
      return null;
  }
};

const selects = (selection: Selection, admitted: Admission): boolean => {
  switch (selection._tag) {
    case "All":
      return true;
    case "Project":
      return admitted.projectId === selection.projectId;
    case "UserDevices":
      return (
        admitted.subject.userId === selection.userId &&
        deviceIdOf(admitted.subject.credential ?? undefined) !== undefined
      );
    case "User":
      return admitted.subject.userId === selection.userId;
    case "Organization":
      return admitted.organizationId === selection.organizationId;
  }
};

interface Registration<A, Refusal> {
  readonly admitted: A;
  readonly stopped: Deferred.Deferred<AccessStop<Refusal>>;
}

interface Group<A, Refusal> {
  readonly judged: A;
  readonly registrations: Array<Registration<A, Refusal>>;
}

const stopAll = <A, Refusal>(
  registrations: Iterable<Registration<A, Refusal>>,
  reason: AccessStop<Refusal>,
) =>
  Effect.forEach(registrations, (registration) => Deferred.succeed(registration.stopped, reason), {
    discard: true,
  });

/** Built in a layer: its passes run in that layer's scope and end with it, stopping what it held. */
export const makeAccessRecheck = <A extends Admission, Refusal>(
  options: RecheckOptions<A, Refusal>,
): Effect.Effect<AccessRecheck<A, Refusal>, never, EventBus | Scope.Scope> =>
  Effect.gen(function* () {
    const { name, timing } = options;
    const bus = yield* EventBus;
    const scope = yield* Effect.scope;
    const registry = new Set<Registration<A, Refusal>>();
    let passesStarted = 0;

    const recheck = (selection: Selection) =>
      Effect.gen(function* () {
        passesStarted += 1;
        const selected = [...registry].filter((registration) =>
          selects(selection, registration.admitted),
        );
        if (selected.length === 0) return;
        const groups = new Map<string, Group<A, Refusal>>();
        for (const registration of selected) {
          const key = options.groupOf(registration.admitted);
          const group = groups.get(key);
          if (group === undefined) {
            groups.set(key, { judged: registration.admitted, registrations: [registration] });
          } else {
            group.registrations.push(registration);
          }
        }
        const unjudged = new Set(groups.values());
        const judgeBatch = (batch: ReadonlyArray<Group<A, Refusal>>) =>
          options.standing(batch.map((group) => group.judged)).pipe(
            Effect.flatMap((verdicts) =>
              Effect.forEach(
                batch,
                (group, index) => {
                  unjudged.delete(group);
                  const refusal = verdicts[index] ?? null;
                  return refusal === null
                    ? Effect.void
                    : stopAll(group.registrations, { _tag: "Refused", refusal });
                },
                { discard: true },
              ),
            ),
          );
        const judged = yield* withinDeadline(
          scope,
          timing.passDeadline,
          Effect.forEach(Arr.chunksOf([...unjudged], STANDING_BATCH), judgeBatch, {
            concurrency: RECHECK_CONCURRENCY,
            discard: true,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(`${name}: an open connection's recheck failed`).pipe(
                  Effect.annotateLogs({ cause: Cause.pretty(cause) }),
                  Effect.as(Option.none()),
                ),
          ),
        );
        if (Option.isNone(judged)) {
          yield* stopAll(
            [...unjudged].flatMap((group) => group.registrations),
            { _tag: "Unavailable" },
          );
        }
      });

    const closeWork = <X, Y>(work: Fiber.Fiber<X, Y>) =>
      Fiber.interrupt(work).pipe(Effect.timeoutOption(timing.closeGrace), Effect.asVoid);

    const runUntilStopped = <B, E, R, S>(
      stopped: Deferred.Deferred<AccessStop<Refusal>>,
      use: Effect.Effect<B, E, R>,
      ended: (stop: AccessStop<Refusal>) => S,
    ): Effect.Effect<B, E | S, R> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const work = yield* Effect.forkDetach(use);
          return yield* restore(
            Effect.gen(function* () {
              const reason = yield* Effect.raceFirst(
                Effect.map(Fiber.await(work), () => null),
                Deferred.await(stopped),
              );
              if (reason === null) return yield* Fiber.join(work);
              return yield* Effect.fail(ended(reason));
            }),
          ).pipe(Effect.ensuring(closeWork(work)));
        }),
      );

    const hold = <B, E, R, AE, S>(request: {
      readonly admit: Effect.Effect<A, AE>;
      readonly use: (admitted: A) => Effect.Effect<B, E, R>;
      readonly stopped: (stop: AccessStop<Refusal>, during: "admission" | "use") => S;
    }): Effect.Effect<B, E | AE | S, R> =>
      Effect.gen(function* () {
        const passesBefore = passesStarted;
        const first = yield* request.admit;
        const registration: Registration<A, Refusal> = {
          admitted: first,
          stopped: yield* Deferred.make<AccessStop<Refusal>>(),
        };
        registry.add(registration);
        return yield* Effect.gen(function* () {
          const admitted = passesStarted === passesBefore ? first : yield* request.admit;
          if (yield* Deferred.isDone(registration.stopped)) {
            return yield* Effect.fail(
              request.stopped(yield* Deferred.await(registration.stopped), "admission"),
            );
          }
          return yield* runUntilStopped(registration.stopped, request.use(admitted), (reason) =>
            request.stopped(reason, "use"),
          );
        }).pipe(Effect.ensuring(Effect.sync(() => void registry.delete(registration))));
      });

    const supervisedRecheck = (selection: Selection) =>
      recheck(selection).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logError(`${name}: a recheck pass failed`).pipe(
                Effect.annotateLogs({ cause: Cause.pretty(cause) }),
              ),
        ),
      );

    const subscription = yield* bus.subscribe;
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((signal) => {
        const selection = selectionOf(signal);
        return selection === null ? Effect.void : supervisedRecheck(selection);
      }),
      Effect.forkScoped,
    );
    yield* supervisedRecheck({ _tag: "All" }).pipe(
      Effect.repeat(Schedule.fixed(timing.sweepEvery)),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => stopAll(registry, { _tag: "Unavailable" }));

    return {
      hold,
      held: () => [...registry].map((registration) => registration.admitted),
    } satisfies AccessRecheck<A, Refusal>;
  });
