import { OrganizationsRepo, type TicketCredential } from "@mend/db";
import { Effect, Layer, Stream } from "effect";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";
import { Socket } from "effect/socket";

import { EventBus, type BusSignal } from "./events-bus.ts";

/**
 * The long-lived connections this process holds for each account: terminals, Service tunnels,
 * the key bridge, event streams and preview requests (docs/adr/0003-organizations-and-tenancy.md,
 * "Removing a member"). Removing a member closes theirs at once instead of letting an
 * authenticated socket outlive the membership that authorized it.
 */
/**
 * Who holds a connection: the account, the sign-in it came through, and the organization it was
 * authorized in. A connection with no organization belongs to the account (the key bridge) and
 * closes only when the account loses its last organization. One with an organization closes
 * when the account leaves that organization or its sign-in switches away from it.
 */
export interface ConnectionHolder {
  readonly userId: string;
  readonly credential: TicketCredential | null;
  readonly organizationId: string | null;
}

/** What a long-lived connection is, for its per-account budget (docs/adr/0004, "Budgets"). */
export type ConnectionKind =
  | "event-stream"
  | "terminal"
  | "tunnel"
  | "key-bridge"
  | "preview"
  | "screen";

/**
 * Whether a connection that names a session steers it. A screen's viewer only watches: anyone who
 * can see the session watches its screen (ADR 0020, D2), so shared control going off leaves it.
 */
const STEERS: Readonly<Record<ConnectionKind, boolean>> = {
  "event-stream": true,
  terminal: true,
  tunnel: true,
  "key-bridge": true,
  preview: true,
  screen: false,
};

export class ConnectionRegistry extends Context.Service<
  ConnectionRegistry,
  {
    /**
     * Hold `close` while the scope is open; removing the account runs it. A connection on a
     * session names it: one that steers it closes when shared control turns off, and every one
     * counts toward the session's own budgets.
     */
    readonly register: (
      holder: ConnectionHolder,
      close: Effect.Effect<void>,
      sessionId?: string,
      kind?: ConnectionKind,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Holds a connection of `kind` on `sessionId` while the scope is open, as `register` does,
     * when the account holds fewer than `limits.account` of that kind and the session fewer than
     * `limits.session` (0: no ceiling). Counting and holding are one step, so connections that
     * arrive together cannot all pass. Answers null once held, or the ceiling that refused it.
     */
    readonly reserve: (request: {
      readonly holder: ConnectionHolder;
      readonly sessionId: string;
      readonly kind: ConnectionKind;
      readonly limits: { readonly account: number; readonly session: number };
      readonly close: Effect.Effect<void>;
    }) => Effect.Effect<"account" | "session" | null, never, Scope.Scope>;
    /** Connections of one kind this process holds for one account right now. */
    readonly countFor: (userId: string, kind: ConnectionKind) => Effect.Effect<number>;
    /** Connections of one kind this process holds on one session right now, whoever holds them. */
    readonly countOnSession: (sessionId: string, kind: ConnectionKind) => Effect.Effect<number>;
    /** Close this process's open connections of one account; answers how many there were. */
    readonly closeForUser: (userId: string) => Effect.Effect<number>;
    /** Close the connections one account holds in one organization it left. */
    readonly closeForMembership: (userId: string, organizationId: string) => Effect.Effect<number>;
    /** Close the organization connections of one sign-in that switched organization. */
    readonly closeForCredential: (credential: string) => Effect.Effect<number>;
    /** Close the connections other accounts hold to steer a session; its owner's stay open. */
    readonly closeForSession: (
      sessionId: string,
      ownerUserId: string | null,
    ) => Effect.Effect<number>;
  }
>()("@mend/api/ConnectionRegistry") {}

/** How long one connection's close may take before removal stops waiting on it. */
const CLOSE_TIMEOUT = "5 seconds";

interface Registration {
  readonly holder: ConnectionHolder;
  readonly close: Effect.Effect<void>;
  readonly sessionId: string | null;
  readonly kind: ConnectionKind | null;
}

/**
 * Track one upgraded socket for revocation. Closing marks it revoked before the close frame goes
 * out, because a client may ignore that frame and keep sending until the close times out: the
 * route drops input once `revoked()` answers true. The account is checked again right after
 * registering, so a removal that landed between sign-in and registration still closes it.
 */
export const guardSocket = <E>(
  connections: ConnectionRegistry["Service"],
  holder: ConnectionHolder,
  write: (event: Socket.CloseEvent) => Effect.Effect<void, E>,
  stillSignedIn: Effect.Effect<boolean>,
  /** The session this socket steers, when it steers one (terminals and tunnels). */
  sessionId?: string,
  kind?: ConnectionKind,
) =>
  Effect.gen(function* () {
    let revoked = false;
    const close = Effect.sync(() => {
      revoked = true;
    }).pipe(Effect.andThen(write(new Socket.CloseEvent(1008, "access revoked"))), Effect.ignore);
    yield* connections.register(holder, close, sessionId, kind);
    if (!(yield* stillSignedIn)) yield* close;
    return { revoked: () => revoked };
  });

/**
 * `guardSocket` for a socket whose budget is taken before it upgrades (`reserve`). Until `opened`,
 * a removal is remembered, and `opened` closes the socket at once when one came, or when the
 * account no longer stands.
 */
export const reserveSocket = (
  connections: ConnectionRegistry["Service"],
  request: {
    readonly holder: ConnectionHolder;
    readonly sessionId: string;
    readonly kind: ConnectionKind;
    readonly limits: { readonly account: number; readonly session: number };
  },
) =>
  Effect.gen(function* () {
    let revoked = false;
    let write: ((event: Socket.CloseEvent) => Effect.Effect<void>) | null = null;
    const close = Effect.suspend(() => {
      revoked = true;
      return write === null ? Effect.void : write(new Socket.CloseEvent(1008, "access revoked"));
    });
    const refused = yield* connections.reserve({ ...request, close });
    if (refused !== null) return { _tag: "Refused", ceiling: refused } as const;
    return {
      _tag: "Held",
      revoked: () => revoked,
      opened: <E>(
        writeClose: (event: Socket.CloseEvent) => Effect.Effect<void, E>,
        stillSignedIn: Effect.Effect<boolean>,
      ) =>
        Effect.gen(function* () {
          write = (event) => Effect.ignore(writeClose(event));
          if (revoked || !(yield* stillSignedIn)) yield* close;
        }),
    } as const;
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

const atCeiling = (limit: number, count: number) => limit > 0 && count >= limit;

/** The in-memory registry, plus the accounts that hold connections right now. */
export const makeConnectionRegistry = Effect.sync(() => {
  const open = new Map<string, Set<Registration>>();
  const add = (registration: Registration) => {
    const userId = registration.holder.userId;
    const held = open.get(userId) ?? new Set<Registration>();
    held.add(registration);
    open.set(userId, held);
    return registration;
  };
  const remove = (registration: Registration) => {
    const userId = registration.holder.userId;
    const held = open.get(userId);
    held?.delete(registration);
    if (held?.size === 0) open.delete(userId);
  };
  const countOf = (userId: string, kind: ConnectionKind) =>
    [...(open.get(userId) ?? [])].filter((entry) => entry.kind === kind).length;
  const countOnSessionOf = (sessionId: string, kind: ConnectionKind) =>
    [...open.values()]
      .flatMap((held) => [...held])
      .filter((entry) => entry.sessionId === sessionId && entry.kind === kind).length;

  const register = (
    holder: ConnectionHolder,
    close: Effect.Effect<void>,
    sessionId?: string,
    kind?: ConnectionKind,
  ) =>
    Effect.acquireRelease(
      Effect.sync(() => add({ holder, close, sessionId: sessionId ?? null, kind: kind ?? null })),
      (registration) => Effect.sync(() => remove(registration)),
    ).pipe(Effect.asVoid);

  const reserve = (request: {
    readonly holder: ConnectionHolder;
    readonly sessionId: string;
    readonly kind: ConnectionKind;
    readonly limits: { readonly account: number; readonly session: number };
    readonly close: Effect.Effect<void>;
  }) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const { holder, sessionId, kind, limits } = request;
        if (atCeiling(limits.account, countOf(holder.userId, kind))) return "account" as const;
        if (atCeiling(limits.session, countOnSessionOf(sessionId, kind))) return "session" as const;
        return add({ holder, close: request.close, sessionId, kind });
      }),
      (held) => Effect.sync(() => (typeof held === "string" ? undefined : remove(held))),
    ).pipe(Effect.map((held) => (typeof held === "string" ? held : null)));

  const closeForUser = (userId: string) => closeAll([...(open.get(userId) ?? [])]);

  const closeForMembership = (userId: string, organizationId: string) =>
    closeAll(
      [...(open.get(userId) ?? [])].filter(
        (entry) => entry.holder.organizationId === organizationId,
      ),
    );

  const closeForCredential = (credential: string) =>
    closeAll(
      [...open.values()]
        .flatMap((held) => [...held])
        .filter(
          (entry) => entry.holder.credential === credential && entry.holder.organizationId !== null,
        ),
    );

  /** The distinct holders of open connections: what a resync re-checks. */
  const holders = () => {
    const seen = new Map<string, ConnectionHolder>();
    for (const held of open.values()) {
      for (const { holder } of held) {
        seen.set(
          `${holder.userId}\u0000${holder.credential ?? ""}\u0000${holder.organizationId ?? ""}`,
          holder,
        );
      }
    }
    return [...seen.values()];
  };

  /** Close the connections of one holder: every one it holds under that organization. */
  const closeForHolder = (holder: ConnectionHolder) =>
    closeAll(
      [...(open.get(holder.userId) ?? [])].filter(
        (entry) =>
          entry.holder.credential === holder.credential &&
          entry.holder.organizationId === holder.organizationId,
      ),
    );

  const closeForSession = (sessionId: string, ownerUserId: string | null) =>
    closeAll(
      [...open.entries()]
        .filter(([userId]) => userId !== ownerUserId)
        .flatMap(([, held]) =>
          [...held].filter(
            (entry) => entry.sessionId === sessionId && (entry.kind === null || STEERS[entry.kind]),
          ),
        ),
    );

  const countFor = (userId: string, kind: ConnectionKind) =>
    Effect.sync(() => countOf(userId, kind));

  const countOnSession = (sessionId: string, kind: ConnectionKind) =>
    Effect.sync(() => countOnSessionOf(sessionId, kind));

  return {
    register,
    reserve,
    closeForUser,
    closeForMembership,
    closeForCredential,
    closeForSession,
    closeForHolder,
    countFor,
    countOnSession,
    holders,
  };
});

/**
 * Every process closes on the removed account's `access` event and on a sign-in's switch, so a
 * socket held by another replica closes too. After a lost listen connection the event may be
 * gone, so a resync re-checks every holder: an organization connection stands while its sign-in
 * still acts in that organization, an account connection while the account is in any.
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
          registry.holders(),
          (holder) =>
            organizations.activeMembership(holder).pipe(
              Effect.flatMap((membership) =>
                membership === null ||
                (holder.organizationId !== null &&
                  membership.organization.id !== holder.organizationId)
                  ? registry.closeForHolder(holder)
                  : Effect.void,
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("connection registry: membership unreadable at resync").pipe(
                  Effect.annotateLogs({ userId: holder.userId, cause: String(cause) }),
                ),
              ),
            ),
          { discard: true },
        );
      }
      const event = signal.event;
      if (event.type === "shared-control-off") {
        return registry.closeForSession(event.sessionId, event.ownerUserId);
      }
      if (event.type === "sign-in-organization")
        return registry.closeForCredential(event.credential);
      if (event.type !== "user" || event.facet !== "access") return Effect.void;
      return event.organizationId === undefined
        ? registry.closeForUser(event.userId)
        : registry.closeForMembership(event.userId, event.organizationId);
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
      reserve: registry.reserve,
      closeForUser: registry.closeForUser,
      closeForMembership: registry.closeForMembership,
      closeForCredential: registry.closeForCredential,
      closeForSession: registry.closeForSession,
      countFor: registry.countFor,
      countOnSession: registry.countOnSession,
    };
  }),
);
