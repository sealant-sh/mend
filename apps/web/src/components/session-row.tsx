import { cn } from "@mend/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { sessionLink } from "#/lib/session-sheet";

/**
 * One session in a list (Doop "Session row"), at its touch size: the phone inbox's row. The title
 * and the project on the first line, then what happened last (red when it failed), and when on
 * the right. The whole row opens the session; `actions` is its 44px "…" (`PhoneRowActions`).
 *
 * The default size, with the branch, is the project page's row; its PR adds it.
 */
export function SessionRow({
  sessionId,
  title,
  project,
  last,
  bad = false,
  when,
  actions,
}: {
  readonly sessionId: string;
  readonly title: string;
  readonly project: string;
  readonly last: ReactNode;
  readonly bad?: boolean;
  readonly when: string;
  readonly actions?: ReactNode;
}) {
  return (
    <li className="relative flex items-start border-b border-border">
      <Link
        {...sessionLink(sessionId)}
        data-session-id={sessionId}
        className={cn(
          "flex min-h-11 min-w-0 flex-1 items-start gap-3 py-3 pl-4 outline-none focus-visible:bg-muted",
          actions === undefined ? "pr-4" : "pr-1",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            <span className="min-w-0 truncate text-row font-medium text-foreground">{title}</span>
            <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground">
              {project}
            </span>
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-meta",
              bad ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {last}
          </span>
        </span>
        <span className="mt-0.5 shrink-0 text-meta text-muted-foreground tabular-nums">{when}</span>
      </Link>
      {actions}
    </li>
  );
}
