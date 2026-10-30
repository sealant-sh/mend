import { fragmentSecret } from "@mend/network";
import { Button } from "@mend/ui/components/ui/button";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { PasswordField } from "#/components/auth-fields";
import { SetupFrame } from "#/components/setup-frame";
import { authClient } from "#/lib/auth-client";
import { passwordProblem } from "#/lib/onboarding";

export function ResetPage() {
  const secret = fragmentSecret(window.location.hash);
  return secret === null ? (
    <SetupFrame>
      <p className="ev-eyebrow mb-2">password</p>
      <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">
        This link is not complete
      </h1>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Check that it was copied whole, or ask an owner or the operator for a new one.
      </p>
    </SetupFrame>
  ) : (
    <ResetForm token={secret} />
  );
}

function ResetForm({ token }: { readonly token: string }) {
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
      setError(
        result.error.code === "INVALID_TOKEN" || result.error.message === undefined
          ? "This link is spent or expired. Ask an owner or the operator for a new one."
          : result.error.message,
      );
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
