import { cn } from "@mend/ui/lib/utils";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SidebarToggle } from "../app-sidebar.tsx";

/**
 * The top row of the sheet on a session screen (Doop "Workspace header"). It names the workspace,
 * not a session: the project and the worktree, then the branch in mono. `actions` holds the
 * buttons on the right, such as "Open in VS Code". No status word: a session's status is on its
 * tab.
 *
 * It starts with the sidebar's toggle, which folds the sidebar to its rail. Still to come, each in
 * its own PR: the layout button (PR 16, before `actions`) and the workspace's "…" menu (PR 13,
 * after them).
 */
export function WorkspaceHeader({
  project,
  worktree,
  branch,
  actions,
  className,
}: {
  readonly project: string;
  readonly worktree: string;
  readonly branch: string;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      data-slot="workspace-header"
      className={cn(
        "flex h-header shrink-0 items-center gap-3 border-b bg-background pr-2.5 pl-3 text-sm text-foreground",
        className,
      )}
    >
      <SidebarToggle />
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <h1 className="flex min-w-0 items-baseline gap-2 text-prose whitespace-nowrap">
        <span className="shrink-0 text-muted-foreground">{project}</span>
        <span aria-hidden className="shrink-0 text-faint">
          /
        </span>
        <span className="sr-only"> worktree </span>
        <span className="min-w-0 truncate font-semibold">{worktree}</span>
      </h1>
      <p className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="sr-only">Branch </span>
        <span className="min-w-0 truncate font-mono text-meta">{branch}</span>
      </p>
      {actions === undefined ? null : (
        <div className="ml-auto flex shrink-0 items-center gap-2 px-1">{actions}</div>
      )}
    </header>
  );
}
