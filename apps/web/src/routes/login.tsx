import { Banner, InlineAlert } from "@mend/ui/components/banner";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { UserX } from "lucide-react";
import { useState } from "react";

import { FirstAccountForm } from "#/components/first-account-form";
import { SetupFrame } from "#/components/setup-frame";
import { SignInForm } from "#/components/sign-in-form";
import { continuationOf } from "#/lib/onboarding";
import { afterSignIn, readSetup, SETUP_PATHS, signInEntry } from "#/lib/setup";
import type { TrpcProxy } from "#/lib/trpc";

/** Why a page sent the person here, when it says: removed from their organization, or a new password. */
type Reason = "access" | "reset";

/** Whether the server has an account yet. Asked fresh on each visit: the answer changes once. */
const instanceOptions = (trpc: TrpcProxy) =>
  trpc.platform.instance.queryOptions(undefined, { retry: false, staleTime: 0 });

export const Route = createFileRoute("/login")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { readonly reason?: Reason; readonly next?: string } => {
    const reason = search["reason"];
    const next = search["next"];
    return {
      ...(reason === "access" || reason === "reset" ? { reason } : {}),
      ...(typeof next === "string" ? { next } : {}),
    };
  },
  // The page to return to rides the fragment, which never reaches the server.
  ssr: false,
  // No form until the server answered: showing sign-in for a beat and then swapping to the first
  // account would read as a glitch on the very first visit. A failure is the page's error screen.
  loader: ({ context }) => context.queryClient.ensureQueryData(instanceOptions(context.trpc)),
  component: LoginPage,
});

/** The first account goes on to setup's next step, whatever page sent it here. */
const setUp = () => window.location.assign(SETUP_PATHS.commandLine);

/**
 * Sign-in, or on a server with no account yet, the first account (docs/adr/0003). After the first
 * account the server takes no new ones here: people join from an invitation link.
 */
function LoginPage() {
  const { trpc } = Route.useRouteContext();
  const instance = useSuspenseQuery(instanceOptions(trpc));
  const { reason } = Route.useSearch();
  // `?next=` from the API's /preview-auth, `#next=` from the app's own walk; read once.
  const [next] = useState(() => continuationOf(window.location));
  const queryClient = useQueryClient();
  // A full load, so whatever loads there reads with the new session. With no page to return to,
  // setup decides: the person's next step, or Mend itself once setup is done.
  const enter = async () => {
    const page = await afterSignIn(next, async () =>
      signInEntry(await readSetup({ queryClient, trpc })),
    );
    window.location.assign(page);
  };

  if (instance.data.users === "none") return <FirstAccountForm onCreated={setUp} />;
  return (
    <SetupFrame
      title="Sign in"
      banner={
        reason === "access" ? (
          <Banner tone="warning" icon={<UserX />} title="You were removed from your organization.">
            Your sessions there were stopped, and their work is kept. To get back in, ask an owner
            of the organization for a new invitation.
          </Banner>
        ) : undefined
      }
    >
      <SignInForm onSignedIn={() => void enter()}>
        <Lead reason={reason} next={next} />
      </SignInForm>
    </SetupFrame>
  );
}

function Lead({ reason, next }: { readonly reason: Reason | undefined; readonly next: string }) {
  if (reason === "reset") {
    return (
      <InlineAlert tone="success" title="Password changed." className="mb-6 max-lg:text-sm">
        Sign in with your new password. Mend signed you out in every other browser.
      </InlineAlert>
    );
  }
  if (next === "/") return null;
  return (
    <p className="mb-6 text-prose text-pretty text-muted-foreground">
      After you sign in, Mend takes you back to{" "}
      <code className="font-mono text-row break-all text-foreground">{next}</code>.
    </p>
  );
}
