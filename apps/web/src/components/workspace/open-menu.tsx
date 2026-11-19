import { Lump, type LumpPr, type LumpStatus } from "@mend/ui/components/lump";
import { Button } from "@mend/ui/components/ui/button";
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
import { PlusIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { SheetHandle, SheetItem } from "../sheet-item.tsx";
import { type ViewPlace, WORKSPACE_VIEWS, type WorkspaceView } from "./views.tsx";

/** A session of the workspace whose tab is closed, which the menu opens again. */
export interface ClosedSession {
  readonly id: string;
  readonly title: string;
  readonly status: LumpStatus;
  readonly pr: LumpPr;
}

interface OpenChoices {
  readonly place: ViewPlace;
  readonly closed: ReadonlyArray<ClosedSession>;
  /** Open a view's or a session's tab: `view:<id>` or `session:<id>`. */
  readonly onOpen: (tab: string) => void;
  /** Open a New session tab for a session in this workspace. */
  readonly onNewSession: () => void;
}

/** "+84 −12", "web :3000": a view's facts as its menu item says them. */
const useFactWords = (view: WorkspaceView, place: ViewPlace): string => {
  // `useFacts` is the view's hook; each item calls it once, in the same order every render.
  const facts = view.useFacts(place);
  const lines =
    facts.added === undefined && facts.removed === undefined
      ? null
      : `+${facts.added ?? 0} −${facts.removed ?? 0}`;
  return [lines, facts.fact].filter((part) => part !== null && part !== undefined).join(" ");
};

function ViewItem({
  view,
  place,
  onOpen,
}: {
  readonly view: WorkspaceView;
  readonly place: ViewPlace;
  readonly onOpen: (tab: string) => void;
}) {
  const facts = useFactWords(view, place);
  return (
    <DropdownMenuItem
      onClick={() => onOpen(`view:${view.id}`)}
      onPointerEnter={view.preload}
      onFocus={view.preload}
    >
      <span aria-hidden className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
        {view.icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{view.name}</span>
      {facts === "" ? null : (
        <span className="shrink-0 text-meta text-muted-foreground tabular-nums">{facts}</span>
      )}
    </DropdownMenuItem>
  );
}

/**
 * A tile's "+" (Doop T02 "Open a view"): the workspace's views, the sessions of the workspace whose
 * tabs are closed, and New session in this workspace. What it opens goes into this tile.
 */
export function OpenMenu({ place, closed, onOpen, onNewSession }: OpenChoices) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open a view"
            className="text-muted-foreground"
          >
            <PlusIcon aria-hidden className="size-3.75" />
          </Button>
        }
      />
      <DropdownMenuContent width="lg">
        {WORKSPACE_VIEWS.length === 0 ? null : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Open a view</DropdownMenuLabel>
            {WORKSPACE_VIEWS.map((view) => (
              <ViewItem key={view.id} view={view} place={place} onOpen={onOpen} />
            ))}
          </DropdownMenuGroup>
        )}
        {closed.length === 0 ? null : (
          <>
            {WORKSPACE_VIEWS.length === 0 ? null : <DropdownMenuSeparator />}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Sessions in this workspace</DropdownMenuLabel>
              {closed.map((session) => (
                <DropdownMenuItem key={session.id} onClick={() => onOpen(`session:${session.id}`)}>
                  <Lump status={session.status} pr={session.pr} className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">{session.title}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {WORKSPACE_VIEWS.length === 0 && closed.length === 0 ? null : <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onNewSession}>
          <SquarePenIcon aria-hidden className="text-muted-foreground" />
          New session in this workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ViewSheetItem({
  view,
  place,
  onPick,
}: {
  readonly view: WorkspaceView;
  readonly place: ViewPlace;
  readonly onPick: () => void;
}) {
  const facts = useFactWords(view, place);
  return (
    <SheetItem
      icon={
        <span aria-hidden className="flex [&_svg]:size-4.5">
          {view.icon}
        </span>
      }
      {...(facts === "" ? {} : { value: facts })}
      onClick={onPick}
    >
      {view.name}
    </SheetItem>
  );
}

/**
 * The phone strip's "+" (Doop T27 "Open a view"): the same choices as a tile's "+", in a sheet that
 * rises from the foot of the screen.
 */
export function PhoneOpenSheet({
  worktree,
  place,
  closed,
  onOpen,
  onNewSession,
}: OpenChoices & { readonly worktree: string }) {
  const [open, setOpen] = useState(false);
  const pick = (act: () => void) => () => {
    setOpen(false);
    act();
  };
  return (
    <>
      <button
        type="button"
        aria-label="Open a view"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="grid size-11 shrink-0 place-items-center text-muted-foreground outline-none focus-visible:bg-muted"
      >
        <PlusIcon aria-hidden className="size-4.5" />
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="max-h-[85dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHandle />
          <SheetHeader className="flex-row items-center gap-1 border-b border-border py-2.5 pr-1.5 pl-5">
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-title font-semibold">Open a view</SheetTitle>
              <p className="truncate text-sm text-muted-foreground">{worktree}</p>
            </div>
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <XIcon aria-hidden className="size-5" />
            </Button>
          </SheetHeader>
          <div role="menu" aria-label="Open a view" className="overflow-y-auto py-1">
            {WORKSPACE_VIEWS.map((view) => (
              <ViewSheetItem
                key={view.id}
                view={view}
                place={place}
                onPick={pick(() => onOpen(`view:${view.id}`))}
              />
            ))}
            {closed.map((session) => (
              <SheetItem
                key={session.id}
                icon={<Lump status={session.status} pr={session.pr} className="size-4.5" />}
                onClick={pick(() => onOpen(`session:${session.id}`))}
              >
                {session.title}
              </SheetItem>
            ))}
            {WORKSPACE_VIEWS.length === 0 && closed.length === 0 ? null : (
              <hr className="my-1 border-border" />
            )}
            <SheetItem icon={<SquarePenIcon aria-hidden />} onClick={pick(onNewSession)}>
              New session in this workspace
            </SheetItem>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
