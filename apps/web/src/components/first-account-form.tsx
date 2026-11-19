import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { type FormEvent, useState } from "react";

import { authClient } from "#/lib/auth-client";
import { type AuthFailure, authFailureOf, fixFieldsNote, setupSteps } from "#/lib/onboarding";

import { useAccountFields } from "./account-fields.tsx";
import { SetupActions, SetupFrame, TOUCH } from "./setup-frame.tsx";

/** The first account names the server's first organization later in setup: six steps. */
const FIRST_ACCOUNT_STEPS = setupSteps(true);

/** Better Auth opens the session as it creates the account, so the next page is signed in. */
const signUp = async (form: {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}): Promise<AuthFailure | null> => {
  try {
    const email = form.email.trim();
    const name = form.name.trim();
    const result = await authClient.signUp.email({
      name: name === "" ? email : name,
      email,
      password: form.password,
    });
    return result.error === null ? null : authFailureOf(result.error);
  } catch (thrown) {
    return authFailureOf({ thrown });
  }
};

/**
 * Step 1 of setup on a server with no accounts: the first account, which the server makes its
 * operator and the owner of its first organization (docs/adr/0003).
 */
export function FirstAccountForm({ onCreated }: { readonly onCreated: () => void }) {
  const form = useAccountFields("first-account");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || !form.check()) return;
    setPending(true);
    setFailure(null);
    const failed = await signUp(form.values);
    if (failed === null) {
      onCreated();
      return;
    }
    setPending(false);
    setFailure(failed);
  };

  return (
    <SetupFrame title="Create the first account" step="account" steps={FIRST_ACCOUNT_STEPS}>
      <p className="text-prose text-pretty text-muted-foreground">
        This server has no accounts yet. Yours is the first, so you become this server's operator,
        the person who runs it, and the owner of its first organization. You name the organization
        later in setup.
      </p>
      <form
        aria-label="Create the first account"
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
        <SetupActions status={form.count === 0 ? null : fixFieldsNote(form.count)}>
          <Button type="submit" disabled={pending} className={TOUCH}>
            {pending
              ? "Creating account…"
              : failure?.kind === "unreachable"
                ? "Try again"
                : "Create account and continue"}
          </Button>
        </SetupActions>
      </form>
    </SetupFrame>
  );
}
