import { Button } from "@mend/ui/components/ui/button";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PasswordField } from "#/components/auth-fields";
import { SetupFrame } from "#/components/setup-frame";
import { authClient } from "#/lib/auth-client";
import { passwordProblem } from "#/lib/onboarding";

export const Route = createFileRoute("/reset/$token")({
  ssr: false,
  component: ResetPage,
});

/**
 * A handed-over password reset link (docs/adr/0003-organizations-and-tenancy.md, "Recovery"): an
 * owner or the operator issued it, because Mend sends no email. It works once, and setting the
 * new password signs the account out everywhere.
 */
function ResetPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [shown, setShown] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = passwordProblem(password, confirm);

  const submit = async () => {
    if (problem !== null) {
      setError(problem);
      return;
    }
    setPending(true);
    setError(null);
    const result = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (result.error) {
      setError("This link is spent or expired. Ask an owner or the operator for a new one.");
      return;
    }
    void navigate({ to: "/login", search: { reason: "reset" } });
  };

  return (
    <SetupFrame>
      <p className="ev-eyebrow mb-2">password</p>
      <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">Set a new password</h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        The link works once. Setting a password signs this account out on every device.
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <PasswordField
          id="reset-password"
          label="New password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          shown={shown}
          onToggle={() => setShown(!shown)}
        />
        <PasswordField
          id="reset-confirm"
          label="New password, again"
          value={confirm}
          onChange={setConfirm}
          autoComplete="new-password"
          shown={shown}
          onToggle={() => setShown(!shown)}
          hint={confirm === "" ? null : problem}
        />
        {error === null ? null : (
          <p
            role="alert"
            className="border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
          >
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={pending} className="w-full">
          {pending ? "One moment…" : "Set password"}
        </Button>
      </form>
    </SetupFrame>
  );
}
