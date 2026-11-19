import { INVITATION_HEADER } from "@mend/network/handed-links";
import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { type FormEvent, useState } from "react";

import { authClient } from "#/lib/auth-client";
import { type AuthFailure, authFailureOf, fixFieldsNote } from "#/lib/onboarding";
import { dayOf } from "#/lib/organization";

import { type EmailRefusal, useAccountFields } from "./account-fields.tsx";
import { SetupActions, SetupFrame, TOUCH, useServerHost } from "./setup-frame.tsx";
import { SignInForm } from "./sign-in-form.tsx";

/** What the signed-out half of the join page shows of the invitation. */
export interface Invitation {
  readonly organizationName: string;
  readonly role: "owner" | "member";
  readonly expiresAt: Date;
}

/** "a member" or "an owner", as a sentence names the role the invitation gives. */
export const article = (role: Invitation["role"]): string =>
  role === "owner" ? "an owner" : "a member";

type SignUpResult =
  | { readonly kind: "created" }
  | { readonly kind: "taken" }
  | { readonly kind: "failed"; readonly failure: AuthFailure };

/**
 * Creates the account with the invitation's token in `x-mend-invitation`: the server admits a new
 * account only with an open invitation (docs/adr/0003), and joins it to the organization as it
 * creates it. Better Auth opens the session at the same time.
 */
const signUp = async (
  token: string,
  form: { readonly name: string; readonly email: string; readonly password: string },
): Promise<SignUpResult> => {
  try {
    const email = form.email.trim();
    const name = form.name.trim();
    const result = await authClient.signUp.email({
      name: name === "" ? email : name,
      email,
      password: form.password,
      fetchOptions: { headers: { [INVITATION_HEADER]: token } },
    });
    if (result.error === null) return { kind: "created" };
    // `USER_ALREADY_EXISTS`, or `…_USE_ANOTHER_EMAIL` from newer Better Auth.
    if (result.error.code?.startsWith("USER_ALREADY_EXISTS") === true) return { kind: "taken" };
    return { kind: "failed", failure: authFailureOf(result.error) };
  } catch (thrown) {
    return { kind: "failed", failure: authFailureOf({ thrown }) };
  }
};

/**
 * The join page for someone signed out: create an account to accept, or sign in with one first.
 * `onCreated` runs once the new account exists, joined and signed in; `reread` once the page has
 * to read the invitation and the sign-in again.
 */
export function JoinWithAccount({
  invitation,
  token,
  reread,
  onCreated,
}: {
  readonly invitation: Invitation;
  readonly token: string;
  readonly reread: () => void;
  readonly onCreated: () => void;
}) {
  // The email to start sign-in with, once the person chose to sign in instead.
  const [signingIn, setSigningIn] = useState<{ readonly email: string } | null>(null);
  if (signingIn !== null) {
    return (
      <SignInToJoin
        invitation={invitation}
        email={signingIn.email}
        onBack={() => setSigningIn(null)}
        onSignedIn={reread}
      />
    );
  }
  return (
    <CreateAccount
      invitation={invitation}
      token={token}
      reread={reread}
      onCreated={onCreated}
      onSignIn={(email) => setSigningIn({ email })}
    />
  );
}

function CreateAccount({
  invitation,
  token,
  reread,
  onCreated,
  onSignIn,
}: {
  readonly invitation: Invitation;
  readonly token: string;
  readonly reread: () => void;
  readonly onCreated: () => void;
  readonly onSignIn: (email: string) => void;
}) {
  const org = invitation.organizationName;
  const [refusal, setRefusal] = useState<EmailRefusal | null>(null);
  const form = useAccountFields("join", refusal);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !form.check()) return;
    setPending(true);
    setFailure(null);
    const result = await signUp(token, form.values);
    if (result.kind === "created") {
      // Still "Creating account…" while the next page loads.
      onCreated();
      return;
    }
    setPending(false);
    if (result.kind === "taken") {
      const email = form.values.email.trim();
      setRefusal({
        email,
        problem: `There's already an account for ${email} on this server.`,
        action: (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-lg:h-11 max-lg:text-lead"
            onClick={() => onSignIn(email)}
          >
            Sign in instead
          </Button>
        ),
      });
      form.focusEmail();
      return;
    }
    setFailure(result.failure);
    // A link spent or revoked meanwhile: the page then says so in place of the form.
    if (result.failure.kind === "refused") reread();
  };

  return (
    <SetupFrame title={`Join ${org}`} step="account">
      <p className="text-prose text-pretty text-muted-foreground">
        You're invited to join {org} on Mend as {article(invitation.role)}. Create an account to
        accept. The invitation only works once, and it expires on {dayOf(invitation.expiresAt)}.
      </p>
      <form
        aria-label={`Create an account and join ${org}`}
        noValidate
        className="mt-6"
        onSubmit={(event) => void submit(event)}
      >
        {form.fields}
        {failure === null ? null : (
          <div className="mt-6">
            {failure.kind === "unreachable" ? (
              <InlineAlert title="Mend's server didn't answer." className="max-lg:text-sm">
                Nothing was sent. Check your connection, or wait a minute and try again.
              </InlineAlert>
            ) : (
              <InlineAlert title="Mend didn't create the account." className="max-lg:text-sm">
                {failure.kind === "refused" ? failure.message : "Check the fields and try again."}
              </InlineAlert>
            )}
          </div>
        )}
        <SetupActions
          note={
            form.count === 0 ? (
              <>
                Already have an account?{" "}
                <Button
                  type="button"
                  variant="link"
                  className="text-row max-lg:text-sm"
                  onClick={() => onSignIn(form.values.email.trim())}
                >
                  Sign in
                </Button>{" "}
                and you'll come back to this invitation.
              </>
            ) : undefined
          }
          status={form.count === 0 ? null : fixFieldsNote(form.count)}
        >
          <Button type="submit" disabled={pending} className={TOUCH}>
            {pending
              ? "Creating account…"
              : failure?.kind === "unreachable"
                ? "Try again"
                : "Create account and join"}
          </Button>
        </SetupActions>
      </form>
    </SetupFrame>
  );
}

function SignInToJoin({
  invitation,
  email,
  onBack,
  onSignedIn,
}: {
  readonly invitation: Invitation;
  readonly email: string;
  readonly onBack: () => void;
  readonly onSignedIn: () => void;
}) {
  const host = useServerHost();
  return (
    <SetupFrame title={`Sign in to join ${invitation.organizationName}`}>
      <SignInForm
        onSignedIn={onSignedIn}
        initialEmail={email}
        secondary={
          <Button type="button" variant="ghost" className={TOUCH} onClick={onBack}>
            Back to invitation
          </Button>
        }
      >
        <p className="mb-6 text-prose text-pretty text-muted-foreground">
          Sign in with your account on {host === "" ? "this server" : host}. Then you'll come back
          here to accept the invitation.
        </p>
      </SignInForm>
    </SetupFrame>
  );
}
