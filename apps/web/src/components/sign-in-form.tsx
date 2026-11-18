import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { FieldGroup } from "@mend/ui/components/ui/field";
import { type FormEvent, type ReactNode, useState } from "react";

import { authClient } from "#/lib/auth-client";
import { type AuthFailure, authFailureOf } from "#/lib/onboarding";

import { PasswordField, TextField } from "./auth-fields.tsx";
import { SetupActions, TOUCH } from "./setup-frame.tsx";

/** Where a person goes who forgot their password: Mend sends no email, so a person hands the link. */
const FORGOT = "Forgot your password? Ask an owner of your organization for a reset link.";
const NO_ACCOUNT = "No account? Ask an owner of your organization for an invitation.";

/** Sends the email and password to Better Auth; a thrown request is the server not answering. */
const signIn = async (email: string, password: string): Promise<AuthFailure | null> => {
  try {
    const result = await authClient.signIn.email({ email: email.trim(), password });
    return result.error === null ? null : authFailureOf(result.error);
  } catch (thrown) {
    return authFailureOf({ thrown });
  }
};

function Failure({ failure }: { readonly failure: AuthFailure }) {
  switch (failure.kind) {
    case "wrong-credentials":
      return (
        <InlineAlert title="Wrong email or password." className="max-lg:text-sm">
          Check both and try again.
        </InlineAlert>
      );
    case "unreachable":
      return (
        <InlineAlert title="Mend's server didn't answer." className="max-lg:text-sm">
          Nothing was sent. Check your connection, or wait a minute and try again.
        </InlineAlert>
      );
    case "refused":
      return (
        <InlineAlert title="Mend didn't sign you in." className="max-lg:text-sm">
          {failure.message}
        </InlineAlert>
      );
  }
}

/**
 * Email and password, and the Sign in button, with every state of a sign-in: working on it, the
 * wrong email or password, and a server that didn't answer (its button reads Try again). Used by
 * the sign-in page, and by the pages that ask a signed-out person to sign in first (joining from
 * an invitation, authorizing a terminal). `onSignedIn` runs once the browser holds a session.
 */
export function SignInForm({
  onSignedIn,
  note = NO_ACCOUNT,
  children,
}: {
  readonly onSignedIn: () => void;
  /** The line beside the button: by default, how to get an account. */
  readonly note?: ReactNode;
  /** Above the fields: the page's own lead or notice. */
  readonly children?: ReactNode;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setFailure(null);
    const failed = await signIn(email, password);
    if (failed === null) {
      // Still "Signing in…" while the page that asked loads.
      onSignedIn();
      return;
    }
    setPending(false);
    setFailure(failed);
  };

  return (
    <form aria-label="Sign in" onSubmit={(event) => void submit(event)}>
      {children}
      <FieldGroup>
        <TextField
          id="sign-in-email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
        />
        <PasswordField
          id="sign-in-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          hint={FORGOT}
          shown={shown}
          onToggle={() => setShown(!shown)}
        />
      </FieldGroup>
      {failure === null ? null : (
        <div className="mt-6">
          <Failure failure={failure} />
        </div>
      )}
      <SetupActions note={note}>
        <Button type="submit" disabled={pending} className={TOUCH}>
          {pending ? "Signing in…" : failure?.kind === "unreachable" ? "Try again" : "Sign in"}
        </Button>
      </SetupActions>
    </form>
  );
}
