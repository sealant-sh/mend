import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Field, PasswordField } from "#/components/auth-fields";
import { SetupFrame } from "#/components/setup-frame";
import { authClient } from "#/lib/auth-client";
import { defaultLoginMode, passwordProblem, safeNextPath, type LoginMode } from "#/lib/onboarding";
import { useTRPC } from "#/lib/trpc";

export { safeNextPath } from "#/lib/onboarding";

export const Route = createFileRoute("/login")({
  ssr: false,
  // `next` stays optional so every existing `navigate({ to: "/login" })` keeps
  // compiling; absent means the workbench root.
  validateSearch: (
    search: Record<string, unknown>,
  ): { readonly next?: string; readonly reason?: "access" } => {
    const next = safeNextPath(search["next"]);
    return {
      ...(next === "/" ? {} : { next }),
      ...(search["reason"] === "access" ? { reason: "access" as const } : {}),
    };
  },
  component: LoginPage,
});

/**
 * Sign-in, or the first of the three setup steps. The page asks the instance
 * whether any account exists before it renders: a fresh install opens on
 * registration and says so; one with accounts opens on sign-in only, because
 * after the first account people join through an invitation link
 * (docs/adr/0003-organizations-and-tenancy.md).
 */
function LoginPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const next = search.next ?? "/";
  const trpc = useTRPC();
  const instance = useQuery(trpc.platform.instance.queryOptions(undefined, { retry: false }));
  const [chosen, setChosen] = useState<LoginMode | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // No form until the instance answered: rendering sign-in for a beat and
  // then swapping to registration would read as a glitch on the very first visit.
  if (instance.isPending) return <SetupFrame />;

  const fresh = instance.data?.users === "none";
  const closed = instance.data?.registration === "closed";
  const mode = closed ? "sign-in" : (chosen ?? defaultLoginMode(instance.data));
  const problem = mode === "sign-up" ? passwordProblem(password, confirm) : null;

  const submit = async () => {
    if (mode === "sign-up" && problem !== null) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const result =
      mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({
            name: name.trim() === "" ? email : name.trim(),
            email,
            password,
          });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "That did not work — check the details and try again.");
      return;
    }
    if (mode === "sign-up") {
      // Step two: how this account reaches its repositories. Signed in already —
      // better-auth opens the session on sign-up.
      void navigate({ to: "/welcome", search: next === "/" ? {} : { next } });
      return;
    }
    // A plain string path (validated same-origin above) — assign like the 401
    // walk does, so the freshly signed-in session re-runs whatever loads there.
    if (next === "/") void navigate({ to: "/" });
    else window.location.assign(next);
  };

  const switchMode = (to: LoginMode) => {
    setChosen(to);
    setError(null);
    setConfirm("");
  };

  return (
    <SetupFrame step={mode === "sign-up" ? 1 : undefined}>
      {mode === "sign-up" && fresh ? <p className="ev-eyebrow mb-2">first run</p> : null}
      <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">
        {mode === "sign-in"
          ? "Sign in"
          : fresh
            ? "Create the first account"
            : "Create your account"}
      </h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {mode === "sign-in"
          ? "Your Mend, on your machines."
          : fresh
            ? "This Mend has no accounts yet. Yours comes first; the next step picks how it reaches your repositories."
            : "One account per person: sessions, keys and devices are yours alone."}
      </p>
      {search.reason === "access" ? (
        <p
          role="status"
          className="mt-5 border-l-2 border-[var(--sw-accent)] pl-3 text-[13px] leading-relaxed text-ink-2"
        >
          Your access to this Mend was removed. Sessions you were running were checkpointed and
          stopped.
        </p>
      ) : null}
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "sign-up" ? (
          <Field
            id="login-name"
            label="Name"
            type="text"
            value={name}
            onChange={setName}
            autoComplete="name"
          />
        ) : null}
        <Field
          id="login-email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        <PasswordField
          id="login-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
          shown={shown}
          onToggle={() => setShown(!shown)}
        />
        {mode === "sign-up" ? (
          <PasswordField
            id="login-confirm"
            label="Password, again"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
            shown={shown}
            onToggle={() => setShown(!shown)}
            hint={confirm === "" ? null : problem}
          />
        ) : null}
        {error === null ? null : (
          <p
            role="alert"
            className="border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
          >
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? "One moment…" : mode === "sign-in" ? "Sign in" : "Create account and continue"}
        </Button>
      </form>
      {closed ? (
        <p className="mt-5 text-[13px] leading-relaxed text-muted-foreground">
          Accounts are created by invitation. Ask an owner of this Mend for a link.
        </p>
      ) : mode === "sign-in" ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-5"
          onClick={() => switchMode("sign-up")}
        >
          Create an account
        </Button>
      ) : fresh ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-5"
          onClick={() => switchMode("sign-in")}
        >
          Have an account? Sign in
        </Button>
      )}
    </SetupFrame>
  );
}
