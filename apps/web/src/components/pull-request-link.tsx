import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";

import type { SessionAnnotationDto } from "#/lib/api";

type ChangePullRequestDto = NonNullable<SessionAnnotationDto["pullRequest"]>;

const ICONS = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const;

/**
 * The change's newest pull request as a list shows it (docs/adr/0007-landing.md): `#412 · open`
 * in cobalt, because it leaves for GitHub, then its title. The state is what `gh` last reported;
 * the list never asks GitHub.
 */
export function PullRequestLink({
  pullRequest,
  className = "",
}: {
  readonly pullRequest: ChangePullRequestDto;
  readonly className?: string;
}) {
  const Icon = ICONS[pullRequest.state];
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={`${pullRequest.title ?? `pull request #${pullRequest.number}`} · ${pullRequest.state} · observed ${new Date(pullRequest.observedAt).toLocaleString()}${pullRequest.adopted ? " · opened outside Mend" : ""}`}
      className={`inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-primary no-underline hover:underline ${className}`}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0">{`#${pullRequest.number} · ${pullRequest.state}`}</span>
      {pullRequest.title === null ? null : (
        <span className="truncate text-faint">{pullRequest.title}</span>
      )}
    </a>
  );
}
