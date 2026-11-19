import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  CopyIcon,
  EllipsisIcon,
  GitBranchPlusIcon,
  SettingsIcon,
  SquareTerminalIcon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import { useState } from "react";

import type { ProjectDetailDto } from "#/lib/api";
import { worktreeChoices, worktreeLiveWords } from "#/lib/project-sessions";
import { startShell, type ShellTarget } from "#/lib/project-starts";
import { shortOrigin } from "#/lib/projects";
import { failureWords } from "#/lib/refusal";
import { sessionLink } from "#/lib/session-sheet";
import { useTRPC } from "#/lib/trpc";

import { SheetHandle, SheetItem, SheetItemBody, sheetItemClass } from "../sheet-item.tsx";

/** What the project's "…" can do; each the page's to carry out. */
export interface ProjectActions {
  readonly setUp: () => void;
  readonly copyAddress: (() => void) | null;
  /** Null when the viewer can't remove this project. */
  readonly remove: (() => void) | null;
}

/**
 * Start a shell and open its session: in a worktree's workspace, beside its sessions, or in a new
 * worktree from the default branch. A shell is a session like any other; its page is the session
 * page. A refusal is said in a toast, since the menu that asked has closed.
 */
export const useStartShell = (projectId: string) => {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (target: ShellTarget) => startShell(target),
    onSuccess: (sessionId) => {
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      void queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: projectId }));
      void navigate(sessionLink(sessionId));
    },
    onError: (error) =>
      toast.add({
        description: `The shell didn't start. ${failureWords(error, "Try again.")}`,
        priority: "high",
      }),
  });
};

/**
 * Open shell (desktop): a menu of the project's worktrees, each with how many of its sessions
 * run, and a new worktree from the default branch.
 */
export function OpenShellMenu({ detail }: { readonly detail: ProjectDetailDto }) {
  const { project } = detail;
  const start = useStartShell(project.id);
  const worktrees = worktreeChoices(detail);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={start.isPending}
        className={buttonVariants({ variant: "outline" })}
      >
        {start.isPending ? "Starting a shell…" : "Open shell"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="lg">
        {worktrees.length === 0 ? null : (
          <>
            <DropdownMenuGroup>
              <DropdownMenuLabel>Open a shell in</DropdownMenuLabel>
              {worktrees.map((worktree) => (
                <DropdownMenuItem
                  key={worktree.id}
                  onClick={() => start.mutate({ _tag: "worktree", worktreeId: worktree.id })}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-meta">
                    {worktree.name}
                  </span>
                  <span className="shrink-0 text-meta text-muted-foreground">
                    {worktreeLiveWords(worktree.live)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => start.mutate({ _tag: "new", projectId: project.id })}>
          <GitBranchPlusIcon aria-hidden />
          <span className="min-w-0 truncate">
            A new worktree from <span className="font-mono">{project.defaultBranch}</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The project's "…" on the desktop (Doop "Project · project menu"). */
export function ProjectMenu({
  detail,
  actions,
}: {
  readonly detail: ProjectDetailDto;
  readonly actions: ProjectActions;
}) {
  const { project } = detail;
  const { copyAddress, remove } = actions;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${project.name} menu`}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "text-muted-foreground")}
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="md">
        <DropdownMenuItem onClick={actions.setUp}>
          <WandSparklesIcon aria-hidden />
          Set up this project…
        </DropdownMenuItem>
        <DropdownMenuItem
          render={<Link to="/projects/$projectId/settings" params={{ projectId: project.id }} />}
        >
          <SettingsIcon aria-hidden />
          Project settings
        </DropdownMenuItem>
        {copyAddress === null ? null : (
          <DropdownMenuItem onClick={copyAddress}>
            <CopyIcon aria-hidden />
            Copy repository address
          </DropdownMenuItem>
        )}
        {remove === null ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={remove}>
              <Trash2Icon aria-hidden />
              Remove project…
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The project's "…" on a phone (Doop "Phone · Project · project actions"): an action sheet with
 * Open shell (a second page of worktrees), Set up this project…, the settings and Remove
 * project…. Each row is a 52px touch target.
 */
export function ProjectActionsSheet({
  detail,
  actions,
}: {
  readonly detail: ProjectDetailDto;
  readonly actions: ProjectActions;
}) {
  const { project } = detail;
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"actions" | "shell">("actions");
  const start = useStartShell(project.id);
  const worktrees = worktreeChoices(detail);
  const show = (next: boolean) => {
    setOpen(next);
    if (next) setPage("actions");
  };
  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  const { copyAddress, remove } = actions;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${project.name} actions`}
        disabled={start.isPending}
        onClick={() => show(true)}
        className={buttonVariants({ variant: "ghost", size: "icon-touch" })}
      >
        <EllipsisIcon aria-hidden className="size-5.5" />
      </button>
      <Sheet open={open} onOpenChange={show}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHandle />
          <SheetHeader
            className={cn(
              "flex-row items-center gap-1 border-b border-border py-2.5 pr-1.5",
              page === "actions" ? "pl-5" : "pl-1.5",
            )}
          >
            {page === "shell" ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-touch"
                aria-label="Back"
                onClick={() => setPage("actions")}
              >
                <ChevronLeftIcon aria-hidden className="size-5.5" />
              </Button>
            ) : null}
            <SheetTitle className="min-w-0 flex-1 truncate text-title font-semibold">
              {page === "shell" ? "Open a shell in" : project.name}
            </SheetTitle>
          </SheetHeader>
          {page === "actions" ? (
            <div role="menu" aria-label={`${project.name} actions`} className="py-1">
              <SheetItem
                icon={<SquareTerminalIcon aria-hidden />}
                chevron
                onClick={() => setPage("shell")}
              >
                Open shell
              </SheetItem>
              <SheetItem icon={<WandSparklesIcon aria-hidden />} onClick={() => act(actions.setUp)}>
                Set up this project…
              </SheetItem>
              {copyAddress === null ? null : (
                <SheetItem icon={<CopyIcon aria-hidden />} onClick={() => act(copyAddress)}>
                  Copy repository address
                </SheetItem>
              )}
              <Link
                to="/projects/$projectId/settings"
                params={{ projectId: project.id }}
                role="menuitem"
                className={sheetItemClass}
              >
                <SheetItemBody icon={<SettingsIcon aria-hidden />} chevron>
                  Project settings
                </SheetItemBody>
              </Link>
              {remove === null ? null : (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => act(remove)}
                  className="flex h-13 w-full items-center gap-3.5 border-t pr-4 pl-5 text-left text-lead text-destructive outline-none focus-visible:bg-muted active:bg-accent"
                >
                  <Trash2Icon aria-hidden className="size-4.5 shrink-0" />
                  Remove project…
                </button>
              )}
            </div>
          ) : (
            <div role="menu" aria-label="Open a shell in" className="overflow-y-auto py-1">
              {worktrees.map((worktree) => (
                <SheetItem
                  key={worktree.id}
                  value={worktreeLiveWords(worktree.live)}
                  onClick={() =>
                    act(() => start.mutate({ _tag: "worktree", worktreeId: worktree.id }))
                  }
                >
                  <span className="font-mono">{worktree.name}</span>
                </SheetItem>
              ))}
              <SheetItem
                icon={<GitBranchPlusIcon aria-hidden />}
                onClick={() => act(() => start.mutate({ _tag: "new", projectId: project.id }))}
              >
                A new worktree from <span className="font-mono">{project.defaultBranch}</span>
              </SheetItem>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Copy the repository's address, and say so. */
export const copyAddressOf = (originUrl: string) => () => {
  navigator.clipboard.writeText(originUrl).then(
    () => toast.add({ description: `Copied ${shortOrigin(originUrl)}.` }),
    () =>
      toast.add({
        description: "The browser didn't allow copying. Select the address on this page.",
        priority: "high",
      }),
  );
};
