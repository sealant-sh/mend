import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Field, PasswordField } from "#/components/auth-fields";
import { formatDay } from "#/components/pairing-qr";
import { SetupFrame } from "#/components/setup-frame";
import { authClient } from "#/lib/auth-client";
import { passwordProblem } from "#/lib/onboarding";
import { joinState } from "#/lib/organization";
import { useTRPC } from "#/lib/trpc";

/** The header a sign-up carries so the API admits it through this invitation (@mend/auth). */
const INVITATION_HEADER = "x-mend-invitation";

export const Route = createFileRoute("/join/$token")({
  ssr: false,
  component: JoinPage,
});

/**
 * An invitation link (docs/adr/0003-organizations-and-tenancy.md). A visitor creates an account
 * and joins with the link's role. A signed-in account already belongs to one organization, so the
 * page says which instead of moving it.
 */
function JoinPage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const session = authClient.useSession();
  const signedIn = session.data !== null && session.data !== undefined;
  const preview = useQuery(
    trpc.organization.invitationPreview.queryOptions({ token }, { retry: false }),
  );
  const current = useQuery(
    trpc.organization.current.queryOptions(undefined, { retry: false, enabled: signedIn }),
  );

  if (preview.isPending || session.isPending || (signedIn && current.isPending)) {
    return <SetupFrame />;
  }
  if (preview.data === undefined) {
    return (
      <SetupFrame>
        <p className="ev-eyebrow mb-2">invitation</p>
        <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">
          This link is not an invitation
        </h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          Check that it was copied whole, or ask an owner for a new one.
        </p>
      </SetupFrame>
    );
  }

  const invitation = preview.data;
  const state = joinState(invitation, signedIn, current.data?.organization ?? null);
  return (
    <SetupFrame>
      <p className="ev-eyebrow mb-2">invitation</p>
      <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">
        {invitation.organizationName}
      </h1>
      <p className="mt-1 font-mono text-[12px] text-label">
        as {invitation.role} · expires {formatDay(invitation.expiresAt.toISOString())}
      </p>
      {state.kind === "spent" ? (
        <p className="mt-5 text-[13px] leading-relaxed text-muted-foreground">{state.message}</p>
      ) : state.kind === "register" ? (
        <JoinForm token={token} />
      ) : state.kind === "already-member" ? (
        <div className="mt-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            You are already a member of {invitation.organizationName}.
          </p>
          <Button
            type="button"
            size="lg"
            className="mt-4 w-full"
            onClick={() => void navigate({ to: "/" })}
          >
            Open Mend
          </Button>
        </div>
      ) : (
        <div className="mt-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            This account belongs to {state.current}. An account belongs to exactly one organization;
            sign out and use a different account for {invitation.organizationName}.
          </p>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="mt-4 w-full"
            onClick={() => void authClient.signOut().then(() => window.location.reload())}
          >
            Sign out
          </Button>
        </div>
      )}
    </SetupFrame>
  );
}

function JoinForm({ token }: { readonly token: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
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
    const result = await authClient.signUp.email({
      name: name.trim() === "" ? email : name.trim(),
      email,
      password,
      fetchOptions: { headers: { [INVITATION_HEADER]: token } },
    });
    setPending(false);
    if (result.error) {
      setError(result.error.message ?? "That did not work. Check the details and try again.");
      return;
    }
    // Signed in already: the next step picks how this account reaches its repositories.
    void navigate({ to: "/welcome" });
  };

  return (
    <>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          id="join-name"
          label="Name"
          type="text"
          value={name}
          onChange={setName}
          autoComplete="name"
        />
        <Field
          id="join-email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          required
        />
        <PasswordField
          id="join-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          shown={shown}
          onToggle={() => setShown(!shown)}
        />
        <PasswordField
          id="join-confirm"
          label="Password, again"
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
          {pending ? "One moment…" : "Create account and join"}
        </Button>
      </form>
      <p className="mt-5 text-[13px] leading-relaxed text-muted-foreground">
        Have an account already? An account belongs to one organization, so this link is for a new
        one.
      </p>
    </>
  );
}
