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

    const registered = Effect.fn("RegistrationPolicy.registered")(function* (
      user: { readonly id: string; readonly email: string },
      invitationToken: string | null,
    ) {
      if (yield* organizations.bootstrapFirstAccount(user.id)) return;
      if (invitationToken === null) {
        return yield* Effect.logWarning(
          "an account registered without an invitation after the first; it belongs to no organization",
        ).pipe(Effect.annotateLogs({ userId: user.id }));
      }
      yield* organizations.acceptInvitation(invitationToken, user).pipe(
        Effect.asVoid,
        Effect.catch((error) =>
          Effect.logWarning(
            "an admitted registration could not spend its invitation; the account belongs to no organization",
          ).pipe(Effect.annotateLogs({ userId: user.id, reason: error._tag })),
        ),
      );
    });

    return { decide, registered };
  }),
);
