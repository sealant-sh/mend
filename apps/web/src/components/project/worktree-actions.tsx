import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  EllipsisIcon,
  FileDiffIcon,
  FolderIcon,
  GitBranchIcon,
  MessageSquareIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { copyTextChecked } from "#/lib/clipboard";
import { laterPage } from "#/lib/later-pages";
import { AGENTS } from "#/lib/new-session";
import { startInWorktree } from "#/lib/project-starts";
import type { WorktreeRow } from "#/lib/project-worktrees";
import { failureWords } from "#/lib/refusal";
import { sessionLink } from "#/lib/session-sheet";
import { useTRPC } from "#/lib/trpc";

import { SheetHandle, SheetItem } from "../sheet-item.tsx";
import { useStartShell } from "./project-actions.tsx";

/** Copy a name to the clipboard, and say whether it worked. */
const copy = (what: string, text: string) => {
  void copyTextChecked(text).then((copied) =>
    toast.add(
      copied
        ? { description: `Copied ${text}.` }
        : {
            description: `Couldn't copy the ${what}. This browser doesn't allow it here.`,
            priority: "high",
          },
    ),
  );
};

/**
 * What a worktree's menu does (Doop "Project · Worktrees · worktree menu", "Phone · worktree
 * actions"): open its newest session or its change, start a session or a shell in it, copy its
 * branch or directory name, and remove it. Starting something opens it; a failure is said in a
 * toast, since the menu that asked has closed.
 */
const useWorktreeActions = (projectId: string, row: WorktreeRow) => {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useMutation({
    mutationFn: (agent: string) => startInWorktree(row.worktree.id, agent),
    onSuccess: (sessionId) => {
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      void queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: projectId }));
      void navigate(sessionLink(sessionId));
    },
    onError: (error) =>
      toast.add({
        description: `The session didn't start in ${row.name}. ${failureWords(error, "Try again.")}`,
        priority: "high",
      }),
  });
  const shell = useStartShell(projectId);
  return {
    startSession: (agent: string) => session.mutate(agent),
    startShell: () => shell.mutate({ _tag: "worktree", worktreeId: row.worktree.id }),
    copyBranch: () => copy("branch name", row.branch),
    copyDirectory: () => copy("directory name", row.worktree.directory),
    starting: session.isPending || shell.isPending,
  };
};

/** "Open its session" with one, "Open its newest session" with several. */
const openSessionWords = (row: WorktreeRow) =>
  row.sessions.length === 1 ? "Open its session" : "Open its newest session";

/** `+40 −12` beside "Open its change", read when the menu opens; nothing until then. */
function ChangeSize({ changeId }: { readonly changeId: string }) {
  const trpc = useTRPC();
  const stats = useQuery(trpc.changes.stats.queryOptions({ id: changeId }, { staleTime: 60_000 }));
  if (stats.isPending || stats.isError || stats.data.files === 0) return null;
  return (
    <span
      aria-label={`${stats.data.additions} lines added, ${stats.data.deletions} removed`}
      className="ml-auto pl-4 text-xs text-muted-foreground tabular-nums"
    >
      +{stats.data.additions} −{stats.data.deletions}
    </span>
  );
}

/** The row's "…" on a desktop. */
export function WorktreeMenu({
  projectId,
  row,
  joinLine,
  onRemove,
}: {
  readonly projectId: string;
  readonly row: WorktreeRow;
  /** Said before a session starts where someone else's runs; null otherwise. */
  readonly joinLine: string | null;
  readonly onRemove: () => void;
}) {
  const actions = useWorktreeActions(projectId, row);
  const [newest] = row.sessions;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${row.name}`}
        disabled={actions.starting}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "text-muted-foreground")}
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="lg">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{row.name}</DropdownMenuLabel>
          {newest === undefined ? null : (
            <DropdownMenuItem render={<Link {...sessionLink(newest.id)} />}>
              <MessageSquareIcon aria-hidden />
              {openSessionWords(row)}
            </DropdownMenuItem>
          )}
          {row.changeId === null ? null : (
            <DropdownMenuItem render={<Link {...laterPage(`changes/${row.changeId}`)} />}>
              <FileDiffIcon aria-hidden />
              Open its change
              <ChangeSize changeId={row.changeId} />
            </DropdownMenuItem>
          )}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SquarePenIcon aria-hidden />
              New session in this worktree
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent width="lg">
              {joinLine === null ? null : (
                <>
                  <p className="px-2 py-1.5 text-meta text-muted-foreground">{joinLine}</p>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuGroup>
                <DropdownMenuLabel>Agent</DropdownMenuLabel>
                {AGENTS.map((agent) => (
                  <DropdownMenuItem key={agent.id} onClick={() => actions.startSession(agent.id)}>
                    {agent.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={actions.startShell}>
            <SquareTerminalIcon aria-hidden />
            Open shell in this worktree
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={actions.copyBranch}>
          <GitBranchIcon aria-hidden />
          Copy branch name
        </DropdownMenuItem>
        <DropdownMenuItem onClick={actions.copyDirectory}>
          <FolderIcon aria-hidden />
          Copy directory name
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash2Icon aria-hidden />
          Remove worktree…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row's 44px "…" on a phone, with its action sheet; the agents are a second page. */
export function PhoneWorktreeActions({
  projectId,
  row,
  joinLine,
  onRemove,
}: {
  readonly projectId: string;
  readonly row: WorktreeRow;
  readonly joinLine: string | null;
  readonly onRemove: () => void;
}) {
  const actions = useWorktreeActions(projectId, row);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"actions" | "agents">("actions");
  const [newest] = row.sessions;
  const show = (next: boolean) => {
    setOpen(next);
    if (next) setPage("actions");
  };
  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  const changeId = row.changeId;
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Actions for ${row.name}`}
        disabled={actions.starting}
        onClick={() => show(true)}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-touch" }), "mr-1")}
      >
        <EllipsisIcon aria-hidden className="size-5" />
      </button>
      <Sheet open={open} onOpenChange={show}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHandle />
          <SheetHeader
            className={cn(
              "flex-row items-center gap-1 border-b border-border py-2.5 pr-12",
              page === "actions" ? "pl-5" : "pl-1.5",
            )}
          >
            {page === "agents" ? (
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
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-title font-semibold">
                {page === "agents" ? "New session in this worktree" : row.name}
              </SheetTitle>
              {page === "actions" ? (
                <p className="truncate text-prose text-muted-foreground">
                  {row.branch} · {row.change.words}
                </p>
              ) : null}
            </div>
          </SheetHeader>
          {page === "actions" ? (
            <div role="menu" aria-label={`Actions for ${row.name}`} className="py-1">
              {newest === undefined ? null : (
                <SheetItem
                  icon={<MessageSquareIcon aria-hidden />}
                  chevron
                  onClick={() => act(() => void navigate(sessionLink(newest.id)))}
                >
                  {openSessionWords(row)}
                </SheetItem>
              )}
              {changeId === null ? null : (
                <SheetItem
                  icon={<FileDiffIcon aria-hidden />}
                  chevron
                  onClick={() => act(() => void navigate(laterPage(`changes/${changeId}`)))}
                >
                  Open its change
                </SheetItem>
              )}
              <SheetItem
                icon={<SquarePenIcon aria-hidden />}
                chevron
                onClick={() => setPage("agents")}
              >
                New session in this worktree
              </SheetItem>
              <SheetItem
                icon={<SquareTerminalIcon aria-hidden />}
                onClick={() => act(actions.startShell)}
              >
                Open shell in this worktree
              </SheetItem>
              <div aria-hidden className="my-1 border-t" />
              <SheetItem
                icon={<GitBranchIcon aria-hidden />}
                onClick={() => act(actions.copyBranch)}
              >
                Copy branch name
              </SheetItem>
              <SheetItem
                icon={<FolderIcon aria-hidden />}
                onClick={() => act(actions.copyDirectory)}
              >
                Copy directory name
              </SheetItem>
              <div aria-hidden className="my-1 border-t" />
              <SheetItem
                icon={<Trash2Icon aria-hidden className="text-destructive!" />}
                className="text-destructive"
                onClick={() => act(onRemove)}
              >
                Remove worktree…
              </SheetItem>
            </div>
          ) : (
            <div role="menu" aria-label="Agent" className="py-1">
              {joinLine === null ? null : (
                <p className="border-b px-5 py-3 text-sm text-muted-foreground">{joinLine}</p>
              )}
              {AGENTS.map((agent) => (
                <SheetItem key={agent.id} onClick={() => act(() => actions.startSession(agent.id))}>
                  {agent.label}
                </SheetItem>
              ))}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
