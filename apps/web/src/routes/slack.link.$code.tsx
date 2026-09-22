import { Button } from "@mend/ui/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { SetupFrame } from "#/components/setup-frame";
import { confirmSlackLink, type SlackLinkConfirmedDto } from "#/lib/api";
import { linkedLine, slackPersonLabel } from "#/lib/slack";
import { useTRPC } from "#/lib/trpc";

export const Route = createFileRoute("/slack/link/$code")({
  ssr: false,
  component: SlackLinkPage,
});

const formatTime = (at: Date): string =>
  at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * A Slack link code (docs/adr/0006-slack.md, "A Slack user acts only once they have linked their
 * account"). A mention from an unlinked Slack user answers with this page. Signed in to Mend, the
 * person sees which Slack user in which workspace they are about to act for and confirms; Mend then
 * runs the mention they made. Signing in comes first: the query's 401 walks them to the login page
 * and back.
 */
function SlackLinkPage() {
  const { code } = Route.useParams();
  const navigate = useNavigate();
  const trpc = useTRPC();
  const preview = useQuery(trpc.slack.previewLink.queryOptions({ code }, { retry: false }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<SlackLinkConfirmedDto | null>(null);

  if (preview.isPending) return <SetupFrame />;
  if (preview.data === undefined) {
    return (
      <SetupFrame>
        <p className="ev-eyebrow mb-2">slack link</p>
        <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">
          This link does not work
        </h1>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          A link works once, for ten minutes, and only for members of the organization that
          connected that Slack workspace. Mention @mend in Slack again for a new one.
        </p>
      </SetupFrame>
    );
  }

  const link = preview.data;
  const person = slackPersonLabel(link);

  const confirm = () => {
    setPending(true);
    setError(null);
    void confirmSlackLink(code)
      .then(setConfirmed)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };

  return (
    <SetupFrame>
      <p className="ev-eyebrow mb-2">slack link</p>
      <h1 className="font-display text-lg font-semibold tracking-[-0.01em]">{person}</h1>
      <p className="mt-1 font-mono text-[12px] text-label">
        {link.slackUserId} · {link.teamName} · expires {formatTime(link.expiresAt)}
      </p>
      {confirmed === null ? (
        <div className="mt-5 space-y-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Linking lets this Slack user start and steer sessions as your Mend account, with your
            credentials and Git access. Confirm only if this Slack user is you.
          </p>
          {link.replacesSlackUserId === null ? null : (
            <p className="border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-ink-2">
              Your account is linked to Slack user {link.replacesSlackUserId} in {link.teamName}{" "}
              now. Confirming replaces that link.
            </p>
          )}
          <div className="rounded-xl bg-sunken p-4">
            <p className="font-mono text-[12px] text-label">runs once linked</p>
            <p className="mt-1 text-[13px] leading-relaxed break-words whitespace-pre-wrap text-foreground">
              {link.requestText}
            </p>
          </div>
          {error === null ? null : (
            <p
              role="alert"
              className="border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger"
            >
              {error}
            </p>
          )}
          <Button type="button" size="lg" disabled={pending} className="w-full" onClick={confirm}>
            {pending ? "Linking…" : `Link ${person} to my account`}
          </Button>
        </div>
      ) : (
        <div className="mt-5">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {linkedLine(link.teamName, confirmed.requestQueued)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="mt-4 w-full"
            onClick={() => void navigate({ to: "/settings", hash: "slack" })}
          >
            Slack settings
          </Button>
        </div>
      )}
    </SetupFrame>
  );
}
