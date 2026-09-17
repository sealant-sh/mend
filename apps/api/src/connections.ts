import { OrganizationsRepo } from "@mend/db";
import { Effect, Layer, Stream } from "effect";
import * as Context from "effect/Context";
import type * as Scope from "effect/Scope";

import { EventBus } from "./events-bus.ts";

/**
 * The long-lived connections this process holds for each account: terminals, Service tunnels,
 * the key bridge and event streams (docs/adr/0003-organizations-and-tenancy.md, "Removing a
 * member"). Removing a member closes theirs at once instead of letting an authenticated socket
 * outlive the membership that authorized it.
 */
export class ConnectionRegistry extends Context.Service<
  ConnectionRegistry,
  {
    /** Hold `close` while the scope is open; removing the account runs it. */
    readonly register: (
      userId: string,
      close: Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    /** Close this process's open connections of one account; answers how many there were. */
    readonly closeForUser: (userId: string) => Effect.Effect<number>;
  }
>()("@mend/api/ConnectionRegistry") {}

interface Registration {
  readonly close: Effect.Effect<void>;
}

/** The in-memory registry, plus the accounts that hold connections right now. */
export const makeConnectionRegistry = Effect.sync(() => {
  const open = new Map<string, Set<Registration>>();

  const register = (userId: string, close: Effect.Effect<void>) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const registration: Registration = { close };
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

  const closeForUser = (userId: string) =>
    Effect.gen(function* () {
      const held = [...(open.get(userId) ?? [])];
      yield* Effect.forEach(held, (registration) => registration.close, { discard: true });
      return held.length;
    });

  return { register, closeForUser, accounts: () => [...open.keys()] };
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
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach((signal) => {
        if (signal.kind === "resync") {
          return Effect.forEach(
            registry.accounts(),
            (userId) =>
              organizations
                .membershipOf(userId)
                .pipe(
                  Effect.flatMap((membership) =>
                    membership === null ? registry.closeForUser(userId) : Effect.void,
                  ),
                ),
            { discard: true },
          );
        }
        return signal.event.type === "user" && signal.event.facet === "access"
          ? registry.closeForUser(signal.event.userId)
          : Effect.void;
      }),
      Effect.forkScoped,
    );
    return { register: registry.register, closeForUser: registry.closeForUser };
  }),
);
