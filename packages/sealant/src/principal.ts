import { Effect } from "effect";
import * as Context from "effect/Context";

/**
 * WHO a Sealant call is made for. Every platform resource Mend touches is owned
 * by exactly one Sealant user, and Mend maps each of its users to one
 * (docs/SEALANT-IDENTITY.md), so the principal is a Mend user id:
 *
 * - `{ kind: "user" }`: a specific Mend user — the request's signed-in user for
 *   "my" things (connected accounts, the connection check, creating a session),
 *   the SESSION OWNER for anything about a session (a collaborator viewing
 *   someone's session reads that session's workspace as its owner).
 * - `{ kind: "none" }`: the default, and what a row with no owner runs as. A
 *   call without a principal is a typed failure, never a silent fallback to
 *   another account (docs/adr/0003-organizations-and-tenancy.md). Machine work
 *   names its account: hot pools warm as each owner they serve, legacy queue
 *   runs as the operator.
 *
 * A reference, not a service: fibers inherit it, so setting it once at a
 * request or session boundary covers every platform call underneath.
 */
export type SealantPrincipalValue =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "none" };

export const SealantPrincipal: Context.Reference<SealantPrincipalValue> =
  Context.Reference<SealantPrincipalValue>("@mend/sealant/SealantPrincipal", {
    defaultValue: () => ({ kind: "none" }),
  });

/** Run `self` as a Mend user; with no owner (`null`) every platform call fails `NO_PRINCIPAL`. */
export const asSealantUser =
  (userId: string | null) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(
      self,
      SealantPrincipal,
      userId === null ? { kind: "none" } : { kind: "user", userId },
    );
