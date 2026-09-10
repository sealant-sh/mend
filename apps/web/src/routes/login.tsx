import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { SetupFrame } from "#/components/setup-frame";
import { authClient } from "#/lib/auth-client";
import { defaultLoginMode, passwordProblem, safeNextPath, type LoginMode } from "#/lib/onboarding";
import { useTRPC } from "#/lib/trpc";

export { safeNextPath } from "#/lib/onboarding";

export const Route = createFileRoute("/login")({
  ssr: false,
  // `next` stays optional so every existing `navigate({ to: "/login" })` keeps
  // compiling; absent means the workbench root.
  validateSearch: (search: Record<string, unknown>): { readonly next?: string } => {
    const next = safeNextPath(search["next"]);
    return next === "/" ? {} : { next };
  },
  component: LoginPage,
});

/**
 * Sign-in, or the first of the three setup steps. The page asks the instance
 * whether any account exists before it renders: a fresh install opens on
 * registration and says so; one with accounts opens on sign-in, with
 * registration a link away (sign-up stays open behind the operator's
 * perimeter — docs/SELF-HOSTING.md).
 */
function LoginPage() {
  const navigate = useNavigate();
  const next = Route.useSearch().next ?? "/";
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
  const mode = chosen ?? defaultLoginMode(instance.data);
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
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "sign-up" ? (
          <Field label="Name" type="text" value={name} onChange={setName} autoComplete="name" />
        ) : null}
        <Field
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
      {mode === "sign-in" ? (
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

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  required,
}: {
  readonly label: string;
  readonly type: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  readonly required?: boolean;
}) {
  const id = `login-${label.toLowerCase()}`;
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block">
        {label}
      </Label>
      <Input
        id={id}
        className="h-10 bg-background"
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        {...(required === true ? { required: true } : {})}
      />
    </div>
  );
}

/**
 * A password input with its own reveal. Both password fields of the
 * registration share one `shown`, so revealing shows the pair being compared.
 */
function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  shown,
  onToggle,
  hint = null,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: string;
  readonly shown: boolean;
  readonly onToggle: () => void;
  /** A live, quiet statement under the field (the pair differs); null for none. */
  readonly hint?: string | null;
}) {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 block">
        {label}
      </Label>
      <div className="relative">
        <Input
          id={id}
          className="h-10 bg-background pr-10"
          type={shown ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          required
        />
        <button
          type="button"
          onClick={onToggle}
          aria-label={shown ? "Hide password" : "Show password"}
          aria-pressed={shown}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {shown ? (
            <EyeOff className="size-4" aria-hidden="true" />
          ) : (
            <Eye className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>
      {hint === null ? null : (
        <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}
