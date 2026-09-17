import { RegistrationPolicy, type RegistrationDecision } from "@mend/auth";
import { OrganizationsRepo, UsersRepo } from "@mend/db";
import { Effect, Layer } from "effect";

const BY_INVITATION = "Registration is by invitation. Ask an owner of this Mend for a link.";

const SPENT: Record<"accepted" | "revoked" | "expired", string> = {
  accepted: "This invitation was already used. Ask an owner for a new link.",
  revoked: "This invitation was revoked. Ask an owner for a new link.",
  expired: "This invitation has expired. Ask an owner for a new link.",
};

/**
 * Closed registration (docs/adr/0003-organizations-and-tenancy.md). An unclaimed instance admits
 * its first account, which becomes the organization's owner and the operator. Everyone after
 * registers through an open invitation link, bound to an email when the owner chose one.
 */
export const RegistrationPolicyLive: Layer.Layer<
  RegistrationPolicy,
  never,
  UsersRepo | OrganizationsRepo
> = Layer.effect(
  RegistrationPolicy,
  Effect.gen(function* () {
    const users = yield* UsersRepo;
    const organizations = yield* OrganizationsRepo;

    const decide = Effect.fn("RegistrationPolicy.decide")(function* (input: {
      readonly email: string;
      readonly invitationToken: string | null;
    }) {
      if ((yield* users.count()) === 0) {
        const bootstrap: RegistrationDecision = { kind: "bootstrap" };
        return bootstrap;
      }
      const token = input.invitationToken;
      if (token === null) {
        const refused: RegistrationDecision = { kind: "refused", message: BY_INVITATION };
        return refused;
      }
      const resolved = yield* organizations
        .invitationByToken(token)
        .pipe(Effect.catchTag("InvitationUnknownError", () => Effect.succeed(null)));
      const decision: RegistrationDecision =
        resolved === null
          ? { kind: "refused", message: BY_INVITATION }
          : resolved.state !== "open"
            ? { kind: "refused", message: SPENT[resolved.state] }
            : resolved.invitation.email !== null &&
                resolved.invitation.email !== input.email.trim().toLowerCase()
              ? {
                  kind: "refused",
                  message: "This invitation is for a different email address.",
                }
              : { kind: "invitation", token };
      return decision;
    });

    /** An admitted account that could not join anything must not keep a working session. */
    const strand = (userId: string, reason: string) =>
      Effect.gen(function* () {
        yield* users.deactivate(userId);
        yield* Effect.logWarning(
          "a registration was admitted but could not complete; the account is deactivated",
        ).pipe(Effect.annotateLogs({ userId, reason }));
      });

    const registered = Effect.fn("RegistrationPolicy.registered")(function* (
      user: { readonly id: string; readonly email: string },
      invitationToken: string | null,
    ) {
      // An invitation is spent first: that is what an invited sign-up asked for. Bootstrap is the
      // fallback, for the first account on an unclaimed instance (with or without a stray token).
      if (invitationToken !== null) {
        const accepted = yield* organizations.acceptInvitation(invitationToken, user).pipe(
          Effect.as(null),
          Effect.catch((error) => Effect.succeed(error._tag)),
        );
        if (accepted === null) return;
        if (yield* organizations.bootstrapFirstAccount(user.id)) return;
        return yield* strand(user.id, accepted);
      }
      if (yield* organizations.bootstrapFirstAccount(user.id)) return;
      yield* strand(user.id, "no invitation");
    });

    return { decide, registered };
  }),
);
