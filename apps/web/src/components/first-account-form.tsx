import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { FieldGroup } from "@mend/ui/components/ui/field";
import { type FormEvent, useRef, useState } from "react";

import { authClient } from "#/lib/auth-client";
import {
  type AccountField,
  accountProblems,
  type AuthFailure,
  authFailureOf,
  fixFieldsNote,
} from "#/lib/onboarding";

import { PasswordField, TextField } from "./auth-fields.tsx";
import { SetupActions, SetupFrame, TOUCH } from "./setup-frame.tsx";

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

/** The order the fields are on the page, so focus goes to the first one to fix. */
const FIELD_ORDER: ReadonlyArray<AccountField> = ["email", "password", "confirm"];

/**
 * Step 1 of setup on a server with no accounts: the first account, which the server makes its
 * operator and the owner of its first organization (docs/adr/0003). Each field's problem shows
 * under it once the form was sent, and goes as soon as the field is fixed.
 */
export function FirstAccountForm({ onCreated }: { readonly onCreated: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const inputs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  const problems = sent ? accountProblems({ email, password, confirm }) : {};
  const count = Object.keys(problems).length;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setSent(true);
    const found = accountProblems({ email, password, confirm });
    const first = FIELD_ORDER.find((field) => found[field] !== undefined);
    if (first !== undefined) {
      inputs[first].current?.focus();
      return;
    }
    setPending(true);
    setFailure(null);
    const failed = await signUp({ name, email, password });
    if (failed === null) {
      onCreated();
      return;
    }
    setPending(false);
    setFailure(failed);
  };

  return (
    <SetupFrame title="Create the first account" step={1}>
      <p className="text-prose text-pretty text-muted-foreground">
        This server has no accounts yet. Yours is the first, so you become this server's operator,
        the person who runs it, and the owner of its first organization. Once setup is done, you can
        name the organization and invite people in Settings.
      </p>
      <form
        aria-label="Create the first account"
        noValidate
        className="mt-6"
        onSubmit={(event) => void submit(event)}
      >
        <FieldGroup>
          <TextField
            id="first-account-name"
            label="Name"
            type="text"
            value={name}
            onChange={setName}
            autoComplete="name"
          />
          <TextField
            id="first-account-email"
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
            problem={problems.email}
            inputRef={inputs.email}
          />
          <PasswordField
            id="first-account-password"
            label="Password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            hint="Use at least 8 characters."
            problem={problems.password}
            inputRef={inputs.password}
            shown={shown}
            onToggle={() => setShown(!shown)}
          />
          <PasswordField
            id="first-account-confirm"
            label="Confirm password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            problem={problems.confirm}
            inputRef={inputs.confirm}
            shown={shown}
            onToggle={() => setShown(!shown)}
          />
        </FieldGroup>
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
        <SetupActions status={count === 0 ? null : fixFieldsNote(count)}>
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
