import { fragmentSecret } from "@mend/network/handed-links";
import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { queryOptions, useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { settingsLink } from "#/components/settings/settings-links";
import { SetupActions, SetupFrame, TOUCH } from "#/components/setup-frame";
import { SignInForm } from "#/components/sign-in-form";
import { authClient } from "#/lib/auth-client";
import type { Account } from "#/lib/authorize";
import { failureWords } from "#/lib/refusal";
import {
  linkedLead,
  readSlackLink,
  type SlackLinkPreview,
  slackPersonLabel,
} from "#/lib/slack-link";
import { type TrpcClient } from "#/lib/trpc";

const readAccount = async (): Promise<Account | null> => {
  const session = await authClient.getSession();
  if (session.error !== null) throw new Error(session.error.message ?? "No session answer.");
  return session.data === null
    ? null
    : { name: session.data.user.name, email: session.data.user.email };
};

/** The page's one read: the session, then the code. A link or a sign-in reloads it. */
const slackLinkOptions = (trpcClient: TrpcClient, code: string | null) =>
  queryOptions({
    queryKey: ["slack-link", code],
    queryFn: () =>
      readSlackLink(code, {
        account: readAccount,
        preview: (wanted) => trpcClient.slack.previewLink.query({ code: wanted }),
      }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

/**
 * Slack's private "Link your Mend account" button opens `/slack/link#<code>`
 * (`packages/slack/src/format.ts`); an older message opens `/slack/link/<code>`, which moves the
 * code into the fragment. The signed-in person checks that the Slack user is them and links it;
 * the mention that asked then runs. A signed-out person signs in here and comes back to the same
 * code, which a sign-in walk through the server would lose.
 */
export const Route = createFileRoute("/slack/link/")({
  // The code is in the fragment, which only the browser has.
  ssr: false,
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      slackLinkOptions(context.trpcClient, fragmentSecret(window.location.hash)),
    ),
  component: SlackLinkPage,
});

function SlackLinkPage() {
  const { trpcClient } = Route.useRouteContext();
  const code = fragmentSecret(window.location.hash);
  const state = useSuspenseQuery(slackLinkOptions(trpcClient, code)).data;
  switch (state.kind) {
    case "link":
      return <Confirm code={code ?? ""} account={state.account} preview={state.preview} />;
    case "unusable":
      return <Unusable />;
    case "sign-in":
      return (
        <SetupFrame title="Sign in">
          <SignInForm onSignedIn={() => window.location.reload()}>
            <p className="mb-6 text-prose text-pretty text-muted-foreground">
              After you sign in, you can link your Slack account to your Mend account.
            </p>
          </SignInForm>
        </SetupFrame>
      );
    case "unreachable":
      return (
        <SetupFrame title="Link your Slack account">
          <InlineAlert title="Mend's server didn't answer." className="max-lg:text-sm">
            Nothing was linked. The link may still work.
          </InlineAlert>
          <SetupActions>
            <Button type="button" className={TOUCH} onClick={() => window.location.reload()}>
              Try again
            </Button>
          </SetupActions>
        </SetupFrame>
      );
  }
}

const time = (at: Date): string =>
  at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** One fact about the link: what it is on the left, its value on the right. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-6 border-b border-border py-3 text-prose max-lg:flex-col max-lg:gap-0.5">
      <dt className="w-44 flex-none text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

/** The link to confirm (Doop "Slack link", "replaces your current link"), then "linked". */
function Confirm({
  code,
  account,
  preview,
}: {
  readonly code: string;
  readonly account: Account;
  readonly preview: SlackLinkPreview;
}) {
  const { trpcClient } = Route.useRouteContext();
  const navigate = useNavigate();
  const link = useMutation({
    mutationFn: () => trpcClient.slack.confirmLink.mutate({ code }),
  });
  const person = slackPersonLabel(preview);
  if (link.isSuccess) {
    return (
      <SetupFrame title="Slack account linked">
        <p className="text-lead text-pretty text-foreground">
          {linkedLead(link.data.requestQueued)}
        </p>
        <p className="mt-2 text-row text-pretty text-muted-foreground">
          {person} in {preview.teamName}'s Slack now acts as your Mend account. To unlink it, open{" "}
          <Link {...settingsLink("a-apps")} className="text-primary hover:underline">
            Settings, Account, Connected apps
          </Link>
          .
        </p>
      </SetupFrame>
    );
  }
  return (
    <SetupFrame title="Link your Slack account">
      <p className="text-prose text-pretty text-foreground-2">
        Linking lets you start and steer sessions from Slack as your Mend account, with your agent
        logins and Git access. Link only if this Slack user is you.
      </p>
      <dl className="mt-6 border-t border-border">
        <Fact label="Slack workspace">{preview.teamName}</Fact>
        <Fact label="Slack user">
          {person}{" "}
          {preview.slackUserName === null ? null : (
            <code className="font-mono text-muted-foreground">{preview.slackUserId}</code>
          )}
        </Fact>
        <Fact label="Mend account">
          {account.name} · {account.email}
        </Fact>
      </dl>
      {preview.replacesSlackUserId === null ? null : (
        <InlineAlert
          tone="warning"
          title="This replaces your current link."
          className="mt-6 max-lg:text-sm"
        >
          Your Mend account is linked to the Slack user {preview.replacesSlackUserId} in{" "}
          {preview.teamName} now. Linking this one removes that link.
        </InlineAlert>
      )}
      <div className="mt-6 rounded-lg bg-muted px-4 py-3">
        <p className="text-row text-muted-foreground">Runs once you link</p>
        <p className="mt-1 text-prose break-words whitespace-pre-wrap text-foreground">
          {preview.requestText}
        </p>
      </div>
      <p className="mt-4 text-row text-muted-foreground">
        This link works once, until {time(preview.expiresAt)}.
      </p>
      {link.isError ? (
        <p role="alert" className="mt-4 text-row text-destructive">
          Mend didn't link your Slack account. {failureWords(link.error, "Try again.")}
        </p>
      ) : null}
      <SetupActions
        secondary={
          <Button
            type="button"
            variant="outline"
            className={TOUCH}
            disabled={link.isPending}
            onClick={() => void navigate({ to: "/" })}
          >
            Cancel
          </Button>
        }
      >
        <Button
          type="button"
          className={TOUCH}
          disabled={link.isPending}
          onClick={() => link.mutate()}
        >
          {link.isPending ? "Linking…" : "Link accounts"}
        </Button>
      </SetupActions>
    </SetupFrame>
  );
}

function Unusable() {
  return (
    <SetupFrame title="Link your Slack account">
      <InlineAlert title="This link can't be used." className="max-lg:text-sm">
        It was already used, or it expired. A link works once, for 10 minutes, and only for members
        of the organization that connected this Slack workspace.
      </InlineAlert>
      <p className="mt-6 text-prose text-pretty text-foreground">
        Mention @mend in Slack again, and Mend sends you a new link.
      </p>
    </SetupFrame>
  );
}
