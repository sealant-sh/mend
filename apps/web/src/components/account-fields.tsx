import { FieldGroup } from "@mend/ui/components/ui/field";
import { type ReactNode, useRef, useState } from "react";

import { type AccountField, accountProblems } from "#/lib/onboarding";

import { PasswordField, TextField } from "./auth-fields.tsx";

/** The order the fields are on the page, so focus goes to the first one to fix. */
const FIELD_ORDER: ReadonlyArray<AccountField> = ["email", "password", "confirm"];

/** The server's answer about one email: there is an account for it already, say. */
export interface EmailRefusal {
  /** The email the server refused, trimmed; the problem goes once the field holds another. */
  readonly email: string;
  readonly problem: string;
  /** A way out of it (a Button), beside the problem. */
  readonly action?: ReactNode;
}

/**
 * The fields of a new account (name, email, a password and its confirmation), for the first
 * account and for joining from an invitation. Each field's problem shows under it once the form
 * was sent (`check`), and goes as soon as the field is fixed. `refusal` adds the server's problem
 * with the email while the field still holds the email it refused.
 */
export function useAccountFields(id: string, refusal: EmailRefusal | null = null) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [sent, setSent] = useState(false);
  const inputs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };

  const own = sent ? accountProblems({ email, password, confirm }) : {};
  const refused = own.email === undefined && refusal !== null && refusal.email === email.trim();
  const problems = refused ? { ...own, email: refusal.problem } : own;

  /** Marks the form sent; true when it can go to the server, or else focuses the first problem. */
  const check = (): boolean => {
    setSent(true);
    const found = accountProblems({ email, password, confirm });
    const first = FIELD_ORDER.find((field) => found[field] !== undefined);
    if (first === undefined) return true;
    inputs[first].current?.focus();
    return false;
  };

  const fields = (
    <FieldGroup>
      <TextField
        id={`${id}-name`}
        label="Name"
        type="text"
        value={name}
        onChange={setName}
        autoComplete="name"
      />
      <TextField
        id={`${id}-email`}
        label="Email"
        type="email"
        value={email}
        onChange={setEmail}
        autoComplete="email"
        problem={problems.email}
        action={refused ? refusal.action : undefined}
        inputRef={inputs.email}
      />
      <PasswordField
        id={`${id}-password`}
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
        id={`${id}-confirm`}
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
  );

  return {
    /** As typed: the caller trims the name and email before sending them. */
    values: { name, email, password },
    /** How many fields need fixing, the server's email problem included. */
    count: Object.keys(problems).length,
    check,
    /** Puts focus in the email field, for a problem the server found with it. */
    focusEmail: () => inputs.email.current?.focus(),
    fields,
  };
}
