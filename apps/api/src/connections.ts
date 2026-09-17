import { OrganizationsRepo } from "@mend/db";
import { Effect, Layer, Stream } from "effect";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";
import { Socket } from "effect/unstable/socket";

import { EventBus, type BusSignal } from "./events-bus.ts";

/**
 * The long-lived connections this process holds for each account: terminals, Service tunnels,
 * the key bridge and event streams (docs/adr/0003-organizations-and-tenancy.md, "Removing a
 * member"). Removing a member closes theirs at once instead of letting an authenticated socket
 * outlive the membership that authorized it.
 */
export class ConnectionRegistry extends Context.Service<
  ConnectionRegistry,
  {
    /**
     * Hold `close` while the scope is open; removing the account runs it. A connection that steers
     * a session names it, so turning off shared control closes it too.
     */
    readonly register: (
      userId: string,
      close: Effect.Effect<void>,
      sessionId?: string,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Close this process's open connections of one account; answers how many there were. */
    readonly closeForUser: (userId: string) => Effect.Effect<number>;
    /** Close the connections other accounts hold on a session; its owner's stay open. */
    readonly closeForSession: (
      sessionId: string,
      ownerUserId: string | null,
    ) => Effect.Effect<number>;
  }
>()("@mend/api/ConnectionRegistry") {}

/** How long one connection's close may take before removal stops waiting on it. */
const CLOSE_TIMEOUT = "5 seconds";

interface Registration {
  readonly close: Effect.Effect<void>;
  readonly sessionId: string | null;
}

/**
 * Track one upgraded socket for revocation. Closing marks it revoked before the close frame goes
 * out, because a client may ignore that frame and keep sending until the close times out: the
 * route drops input once `revoked()` answers true. The account is checked again right after
 * registering, so a removal that landed between sign-in and registration still closes it.
 */
export const guardSocket = <E>(
  connections: ConnectionRegistry["Service"],
  userId: string,
  write: (event: Socket.CloseEvent) => Effect.Effect<void, E>,
  stillSignedIn: Effect.Effect<boolean>,
  /** The session this socket steers, when it steers one (terminals and tunnels). */
  sessionId?: string,
) =>
  Effect.gen(function* () {
    let revoked = false;
    const close = Effect.sync(() => {
      revoked = true;
    }).pipe(Effect.andThen(write(new Socket.CloseEvent(1008, "access revoked"))), Effect.ignore);
    yield* connections.register(userId, close, sessionId);
    if (!(yield* stillSignedIn)) yield* close;
    return { revoked: () => revoked };
  });

const closeAll = (held: ReadonlyArray<Registration>) =>
  Effect.gen(function* () {
    // All at once, each bounded: one socket that never finishes opening must not hold up the
    // others, or the removal waiting on them.
    yield* Effect.forEach(
      held,
      (registration) => registration.close.pipe(Effect.timeoutOption(CLOSE_TIMEOUT)),
      { concurrency: "unbounded", discard: true },
    );
    return held.length;
  });

/** The in-memory registry, plus the accounts that hold connections right now. */
export const makeConnectionRegistry = Effect.sync(() => {
  const open = new Map<string, Set<Registration>>();

  const register = (userId: string, close: Effect.Effect<void>, sessionId?: string) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const registration: Registration = { close, sessionId: sessionId ?? null };
        const held = open.get(userId) ?? new Set<Registration>();
        held.add(registration);
        open.set(userId, held);
        return registration;
      }),
      (registration) =>
        Effect.sync(() => {
          const held = open.get(userId);
          held?.delete(registration);
          if (held?.size === 0) open.delete(userId);
        }),
    ).pipe(Effect.asVoid);

  const closeForUser = (userId: string) => closeAll([...(open.get(userId) ?? [])]);

  const closeForSession = (sessionId: string, ownerUserId: string | null) =>
    closeAll(
      [...open.entries()]
        .filter(([userId]) => userId !== ownerUserId)
        .flatMap(([, held]) => [...held].filter((entry) => entry.sessionId === sessionId)),
    );

  return { register, closeForUser, closeForSession, accounts: () => [...open.keys()] };
});

/**
 * Every process closes on the removed account's `access` event, so a socket held by another
 * replica closes too. After a lost listen connection the event may be gone, so a resync
 * re-checks every account holding connections and closes those no longer in an organization.
 */
export const ConnectionRegistryLive: Layer.Layer<
  ConnectionRegistry,
  never,
  EventBus | OrganizationsRepo
> = Layer.effect(
  ConnectionRegistry,
  Effect.gen(function* () {
    const registry = yield* makeConnectionRegistry;
    const bus = yield* EventBus;
    const organizations = yield* OrganizationsRepo;
    const subscription = yield* bus.subscribe;
    const handle = (signal: BusSignal) => {
      if (signal.kind === "resync") {
        return Effect.forEach(
          registry.accounts(),
          (userId) =>
            organizations.membershipOf(userId).pipe(
              Effect.flatMap((membership) =>
                membership === null ? registry.closeForUser(userId) : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("connection registry: membership unreadable at resync").pipe(
                  Effect.annotateLogs({ userId, cause: String(cause) }),
                ),
              ),
            ),
          { discard: true },
        );
      }
      if (signal.event.type === "shared-control-off") {
        return registry.closeForSession(signal.event.sessionId, signal.event.ownerUserId);
      }
      return signal.event.type === "user" && signal.event.facet === "access"
        ? registry.closeForUser(signal.event.userId)
        : Effect.void;
    };
    // A resync arrives right after the database connection dropped, so its membership reads can
    // fail. One failed signal is logged; the subscriber keeps closing on later ones.
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((signal) =>
        handle(signal).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("connection registry: a signal could not be handled").pipe(
              Effect.annotateLogs({ signal: signal.kind, cause: String(cause) }),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
    return {
      register: registry.register,
      closeForUser: registry.closeForUser,
      closeForSession: registry.closeForSession,
    };
  }),
);
