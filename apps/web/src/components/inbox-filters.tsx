import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { cn } from "@mend/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { InboxFilters } from "#/lib/inbox";
import { useTRPC } from "#/lib/trpc";
import { inboxFilters } from "#/lib/ui-prefs";

/**
 * The inbox's two filters, "All projects" (or the project picked) and "Mine" (or "Everyone"), as
 * one line that opens one menu with both: a dropdown in the sidebar, a sheet on a phone. The
 * sidebar and the phone keep the same choice, in this browser.
 */

const EVERY_PROJECT = "all";

/** The two words the filter line shows. */
export const filterWords = (
  filters: InboxFilters,
  projectName: string | undefined,
): { readonly project: string; readonly whose: string } => ({
  project: filters.projectId === null ? "All projects" : (projectName ?? "One project"),
  whose: filters.mine ? "Mine" : "Everyone",
});

/** The projects the menu lists, and the picked one's name, from the project list. */
const useProjectChoices = (filters: InboxFilters) => {
  const trpc = useTRPC();
  const projects = useQuery(trpc.projects.list.queryOptions());
  const picked =
    filters.projectId === null
      ? undefined
      : projects.data?.find((project) => project.id === filters.projectId)?.name;
  return { projects, picked };
};

function FilterWord({
  children,
  size,
}: {
  readonly children: string;
  readonly size: "sm" | "touch";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.25 px-1.5 font-medium",
        size === "touch" ? "h-11 text-sm" : "h-7 text-control",
      )}
    >
      {children}
      <ChevronDownIcon aria-hidden className="size-3" />
    </span>
  );
}

const lineClass =
  "flex min-w-0 items-center gap-0.5 rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:text-foreground";

/** The sidebar's filter line and its menu. */
export function InboxFilterMenu({ filters }: { readonly filters: InboxFilters }) {
  const { projects, picked } = useProjectChoices(filters);
  const words = filterWords(filters, picked);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Inbox filters: ${words.project}, ${words.whose}`}
        className={lineClass}
      >
        <FilterWord size="sm">{words.project}</FilterWord>
        <FilterWord size="sm">{words.whose}</FilterWord>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md" className="max-h-[min(var(--available-height),28rem)]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Sessions</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.mine ? "mine" : "everyone"}
            onValueChange={(value: string) =>
              inboxFilters.set({ ...filters, mine: value === "mine" })
            }
          >
            <DropdownMenuRadioItem value="mine">Mine</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="everyone">Everyone</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Projects</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filters.projectId ?? EVERY_PROJECT}
            onValueChange={(value: string) =>
              inboxFilters.set({ ...filters, projectId: value === EVERY_PROJECT ? null : value })
            }
          >
            <DropdownMenuRadioItem value={EVERY_PROJECT}>All projects</DropdownMenuRadioItem>
            {projects.isError ? (
              <DropdownMenuItem onClick={() => void projects.refetch()} closeOnClick={false}>
                The projects didn't load. Try again
              </DropdownMenuItem>
            ) : projects.isPending ? (
              <DropdownMenuItem disabled>Loading projects…</DropdownMenuItem>
            ) : (
              projects.data.map((project) => (
                <DropdownMenuRadioItem key={project.id} value={project.id}>
                  <span className="truncate">{project.name}</span>
                </DropdownMenuRadioItem>
              ))
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One choice in the phone's filter sheet: a 52px row with a check when it is picked. */
function SheetChoice({
  picked,
  onPick,
  children,
}: {
  readonly picked: boolean;
  readonly onPick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={picked}
      onClick={onPick}
      className="flex h-13 w-full items-center gap-3 px-5 text-left text-lead outline-none focus-visible:bg-muted"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {picked ? <CheckIcon aria-hidden className="size-4.5" /> : null}
    </button>
  );
}

function SheetSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label} className="border-b border-border py-2 last:border-b-0">
      <p className="px-5 pt-2 pb-1 text-sm text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}

/** The phone inbox's filter row and the sheet it opens ("Inbox filters"). */
export function InboxFilterSheet({ filters }: { readonly filters: InboxFilters }) {
  const [open, setOpen] = useState(false);
  const { projects, picked } = useProjectChoices(filters);
  const words = filterWords(filters, picked);
  const pick = (next: InboxFilters) => {
    inboxFilters.set(next);
    setOpen(false);
  };
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Inbox filters: ${words.project}, ${words.whose}`}
        onClick={() => setOpen(true)}
        className={cn(lineClass, "px-2.5")}
      >
        <FilterWord size="touch">{words.project}</FilterWord>
        <FilterWord size="touch">{words.whose}</FilterWord>
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="border-b border-border px-5 py-4">
            <SheetTitle className="text-title">Inbox filters</SheetTitle>
          </SheetHeader>
          <div role="menu" aria-label="Inbox filters" className="min-h-0 overflow-y-auto">
            <SheetSection label="Sessions">
              <SheetChoice picked={filters.mine} onPick={() => pick({ ...filters, mine: true })}>
                Mine
              </SheetChoice>
              <SheetChoice picked={!filters.mine} onPick={() => pick({ ...filters, mine: false })}>
                Everyone
              </SheetChoice>
            </SheetSection>
            <SheetSection label="Projects">
              <SheetChoice
                picked={filters.projectId === null}
                onPick={() => pick({ ...filters, projectId: null })}
              >
                All projects
              </SheetChoice>
              {projects.isError ? (
                <button
                  type="button"
                  onClick={() => void projects.refetch()}
                  className="flex h-13 w-full items-center px-5 text-left text-lead text-muted-foreground"
                >
                  The projects didn't load. Try again
                </button>
              ) : projects.isPending ? (
                <p className="flex h-13 items-center px-5 text-lead text-muted-foreground">
                  Loading projects…
                </p>
              ) : (
                projects.data.map((project) => (
                  <SheetChoice
                    key={project.id}
                    picked={filters.projectId === project.id}
                    onPick={() => pick({ ...filters, projectId: project.id })}
                  >
                    {project.name}
                  </SheetChoice>
                ))
              )}
            </SheetSection>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
