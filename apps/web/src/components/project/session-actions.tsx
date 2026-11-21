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
import {
  ChevronLeftIcon,
  EllipsisIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useState } from "react";

import { copyTextChecked } from "#/lib/clipboard";
import { AGENTS } from "#/lib/new-session";
import type { ProjectSessionRow } from "#/lib/project-sessions";
import { worktreeStart } from "#/lib/project-starts";
import { sessionUrl } from "#/lib/row-actions";

import { useProjectStart } from "../new-session/instant-start.ts";
import { SheetHandle, SheetItem } from "../sheet-item.tsx";
import { useStartShell } from "./project-actions.tsx";

/**
 * What one session row offers beyond opening it: another session in its worktree (with the join
 * line when someone else's session runs there), a shell in its worktree, and its link. Starting
 * something opens it; a refusal is said in a toast, since the menu that asked has closed.
 */
const useRowStarts = (projectId: string, row: ProjectSessionRow) => {
  // The session's page opens at once; a refusal is said in a toast (SLNT-1196).
  const start = useProjectStart(projectId);
  const shell = useStartShell(projectId);
  const copyLink = () => {
    void copyTextChecked(sessionUrl(window.location.origin, row.id)).then((copied) =>
      toast.add(
        copied
          ? { description: `Copied the link to "${row.title}".` }
          : {
              description: `Couldn't copy the link to "${row.title}". This browser doesn't allow it here.`,
              priority: "high",
            },
      ),
    );
  };
  return {
    startSession: (agent: string) =>
      start(worktreeStart(row.worktreeId, agent), `The session didn't start in ${row.worktree}.`),
    startShell: () => shell({ _tag: "worktree", worktreeId: row.worktreeId }),
    copyLink,
  };
};

/** The row's "…" on the desktop; a right-click on the row opens nothing more. */
export function SessionRowMenu({
  projectId,
  row,
  joinLine,
}: {
  readonly projectId: string;
  readonly row: ProjectSessionRow;
  /** Said before a session starts in a worktree where someone else's runs; null otherwise. */
  readonly joinLine: string | null;
}) {
  const starts = useRowStarts(projectId, row);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${row.title}`}
        className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "text-muted-foreground")}
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width="lg">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MessageSquarePlusIcon aria-hidden />
            <span className="min-w-0 truncate">
              New session in <span className="font-mono">{row.worktree}</span>
            </span>
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
                <DropdownMenuItem key={agent.id} onClick={() => starts.startSession(agent.id)}>
                  {agent.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={starts.startShell}>
          <SquareTerminalIcon aria-hidden />
          <span className="min-w-0 truncate">
            Open shell in <span className="font-mono">{row.worktree}</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={starts.copyLink}>
          <LinkIcon aria-hidden />
          Copy link
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The row's 44px "…" on a phone, with its action sheet; the agents are a second page. */
export function PhoneSessionActions({
  projectId,
  row,
  joinLine,
}: {
  readonly projectId: string;
  readonly row: ProjectSessionRow;
  readonly joinLine: string | null;
}) {
  const starts = useRowStarts(projectId, row);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"actions" | "agents">("actions");
  const show = (next: boolean) => {
    setOpen(next);
    if (next) setPage("actions");
  };
  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Actions for ${row.title}`}
        onClick={() => show(true)}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-touch" }), "mt-1.5 mr-1")}
      >
        <EllipsisIcon aria-hidden className="size-5" />
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
                {page === "agents" ? `New session in ${row.worktree}` : row.title}
              </SheetTitle>
            </div>
          </SheetHeader>
          {page === "actions" ? (
            <div role="menu" aria-label={`Actions for ${row.title}`} className="py-1">
              <SheetItem
                icon={<MessageSquarePlusIcon aria-hidden />}
                chevron
                onClick={() => setPage("agents")}
              >
                New session in <span className="font-mono">{row.worktree}</span>
              </SheetItem>
              <SheetItem
                icon={<SquareTerminalIcon aria-hidden />}
                onClick={() => act(starts.startShell)}
              >
                Open shell in <span className="font-mono">{row.worktree}</span>
              </SheetItem>
              <SheetItem icon={<LinkIcon aria-hidden />} onClick={() => act(starts.copyLink)}>
                Copy link
              </SheetItem>
            </div>
          ) : (
            <div role="menu" aria-label="Agent" className="py-1">
              {joinLine === null ? null : (
                <p className="border-b px-5 py-3 text-sm text-muted-foreground">{joinLine}</p>
              )}
              {AGENTS.map((agent) => (
                <SheetItem key={agent.id} onClick={() => act(() => starts.startSession(agent.id))}>
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
