import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { cn } from "@mend/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { sessionLink } from "#/lib/session-sheet";
import type { ShownRow } from "#/lib/sidebar-moves";

import { Changed } from "./changed.tsx";

/**
 * One session in a list (Doop "Session row"), at its touch size: the phone inbox's row. The title
 * and the project on the first line, then what happened last (red when it failed), and when on
 * the right, after the session glyph (`sheet-lump`). The whole row opens the session; `actions`
 * is its 44px "…" (`PhoneRowActions`). It moves between groups as a sidebar row does.
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
  lump,
  phase = "still",
  lit = false,
}: {
  readonly sessionId: string;
  readonly title: string;
  readonly project: string;
  readonly last: ReactNode;
  readonly bad?: boolean;
  readonly when: string;
  readonly actions?: ReactNode;
  /** The glyph: its shape the session's state, its colour the pull request. */
  readonly lump?: { readonly status: LumpStatus; readonly pr: LumpPr };
  readonly phase?: ShownRow["phase"];
  readonly lit?: boolean;
}) {
  const leaving = phase === "leaving";
  return (
    <li
      data-row-id={leaving ? undefined : sessionId}
      aria-hidden={leaving ? true : undefined}
      inert={leaving}
      className={cn(
        "grid border-b border-border",
        phase === "entering" && "animate-row-open",
        leaving && "pointer-events-none animate-row-close",
        lit && "animate-row-lit",
      )}
    >
      <div
        className={cn("relative flex min-h-0 items-start", phase !== "still" && "overflow-hidden")}
      >
        <Link
          {...sessionLink(sessionId)}
          data-session-id={leaving ? undefined : sessionId}
          className={cn(
            "flex min-h-11 min-w-0 flex-1 items-start gap-3 py-3 pl-4 outline-none focus-visible:bg-muted",
            actions === undefined ? "pr-4" : "pr-1",
          )}
        >
          {lump === undefined ? null : (
            <Changed value={lump.status} className="mt-0.75 shrink-0">
              <Lump status={lump.status} pr={lump.pr} className="size-4" />
            </Changed>
          )}
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
          <span className="mt-0.5 shrink-0 text-meta text-muted-foreground tabular-nums">
            {when}
          </span>
        </Link>
        {actions}
      </div>
    </li>
  );
}
