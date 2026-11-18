import { InlineAlert } from "@mend/ui/components/banner";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { FieldGroup } from "@mend/ui/components/ui/field";
import { cn } from "@mend/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";

import { authClient } from "#/lib/auth-client";
import { useFragmentSecret } from "#/lib/handed-links";
import { accountProblems, type AuthFailure, authFailureOf, fixFieldsNote } from "#/lib/onboarding";

import { PasswordField } from "./auth-fields.tsx";
import { SetupActions, SetupFrame, TOUCH } from "./setup-frame.tsx";

/**
 * `/reset#<token>`: a new password from a reset link an owner (Settings, Members) or the operator
 * (`mend operator reset-link`) made and handed over. Mend sends no email. The server checks the
 * link only when the password is sent, so a spent or expired link shows as such then.
 */
export function ResetPassword() {
  const secret = useFragmentSecret();
  return secret === null ? <NoLink /> : <ResetForm key={secret} token={secret} />;
}

/** Back to sign-in, the way out of every state that can't go on. */
function SignInLink() {
  return (
    <SetupActions>
      <Link to="/login" className={cn(buttonVariants({ variant: "outline" }), TOUCH)}>
        Sign in
      </Link>
    </SetupActions>
  );
}

function NoLink() {
  return (
    <SetupFrame title="Reset your password">
      <p className="text-prose text-pretty text-foreground">
        To set a new password, you need a reset link. Mend doesn't send email, so ask an owner of
        your organization to make one in Settings, Members, and send it to you. The operator of this
        server can make one too.
      </p>
      <p className="mt-3 text-row text-pretty text-muted-foreground">
        If you opened a link, check that it was copied whole. It ends with a long code after{" "}
        <code className="font-mono text-meta">/reset#</code>.
      </p>
      <SignInLink />
    </SetupFrame>
  );
}

type Sent = AuthFailure | { readonly kind: "spent" };

const resetPassword = async (token: string, newPassword: string): Promise<Sent | null> => {
  try {
    const result = await authClient.resetPassword({ newPassword, token });
    if (result.error === null) return null;
    return result.error.code === "INVALID_TOKEN" ? { kind: "spent" } : authFailureOf(result.error);
  } catch (thrown) {
    return authFailureOf({ thrown });
  }
};

function Spent() {
  return (
    <>
      <InlineAlert title="This reset link can't be used." className="max-lg:text-sm">
        It was already used, or it expired. A reset link works once.
      </InlineAlert>
      <p className="mt-6 text-prose text-pretty text-foreground">
        Ask an owner of your organization for a new link. Owners make one in Settings, Members. The
        operator of this server can make one too. Mend doesn't send email, so they copy the link and
        send it to you.
      </p>
      <p className="mt-3 text-row text-pretty text-muted-foreground">
        If you already set a new password with this link, sign in with it.
      </p>
      <SignInLink />
    </>
  );
}

function ResetForm({ token }: { readonly token: string }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Sent | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmInput = useRef<HTMLInputElement>(null);

  const problems = sent ? accountProblems({ password, confirm }) : {};
  const count = Object.keys(problems).length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setSent(true);
    const found = accountProblems({ password, confirm });
    if (found.password !== undefined) return passwordInput.current?.focus();
    if (found.confirm !== undefined) return confirmInput.current?.focus();
    setPending(true);
    setFailure(null);
    const failed = await resetPassword(token, password);
    if (failed === null) {
      void navigate({ to: "/login", search: { reason: "reset" } });
      return;
    }
    setPending(false);
    setFailure(failed);
  };

  if (failure?.kind === "spent") {
    return (
      <SetupFrame title="Set a new password">
        <Spent />
      </SetupFrame>
    );
  }

  return (
    <SetupFrame title="Set a new password">
      <p className="text-prose text-pretty text-muted-foreground">
        Choose a new password for your account. This reset link works once.
      </p>
      <form
        aria-label="Set a new password"
        noValidate
        className="mt-6"
        onSubmit={(event) => void submit(event)}
      >
        <FieldGroup>
          <PasswordField
            id="reset-password"
            label="New password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint="Use at least 8 characters."
            problem={problems.password}
            inputRef={passwordInput}
            shown={shown}
            onToggle={() => setShown(!shown)}
          />
          <PasswordField
            id="reset-confirm"
            label="Confirm new password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            problem={problems.confirm}
            inputRef={confirmInput}
            shown={shown}
            onToggle={() => setShown(!shown)}
          />
        </FieldGroup>
        <p className="mt-6 text-row text-pretty text-muted-foreground max-lg:text-sm">
          Setting a password signs you out of Mend in every browser. Your terminals, the desktop app
          and your phone stay signed in.
        </p>
        {failure === null ? null : (
          <div className="mt-6">
            {failure.kind === "unreachable" ? (
              <InlineAlert title="Mend's server didn't answer." className="max-lg:text-sm">
                Nothing was sent. Check your connection, or wait a minute and try again.
              </InlineAlert>
            ) : (
              <InlineAlert title="Mend didn't set the password." className="max-lg:text-sm">
                {failure.kind === "refused" ? failure.message : "Try again."}
              </InlineAlert>
            )}
          </div>
        )}
        <SetupActions status={count === 0 ? null : fixFieldsNote(count)}>
          <Button type="submit" disabled={pending} className={TOUCH}>
            {pending
              ? "Setting password…"
              : failure?.kind === "unreachable"
                ? "Try again"
                : "Set password"}
          </Button>
        </SetupActions>
      </form>
    </SetupFrame>
  );
}
