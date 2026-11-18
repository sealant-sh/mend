import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@mend/ui/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@mend/ui/components/ui/sheet";
import { cn } from "@mend/ui/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  AlarmClockOffIcon,
  ArrowUpRightIcon,
  CalendarIcon,
  CheckCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  LinkIcon,
  PencilIcon,
  Undo2Icon,
} from "lucide-react";
import { type ComponentType, type ReactNode, useState } from "react";

import { whenAhead, type InboxRow } from "#/lib/inbox";
import { sessionPage } from "#/lib/later-pages";
import { type RowActions, snoozeChoices } from "#/lib/row-actions";
import type { RowActionHandlers } from "#/lib/use-row-actions";

/**
 * A session row's actions (Doop "Sidebar · session menu", "Phone · Inbox · row actions"): the
 * session's own, never its workspace's. Copy branch name and Land… belong to the workspace, in its
 * header's "…" and the Change view. Approving from a row is the phone app's alone.
 *
 * On the desk they are the row's "…" menu and its right-click menu, the same items in both; on a
 * phone, a sheet. Stop session… (route PR 13) goes last in each, after a separator.
 */

/** The parts of a menu, so the "…" menu and the right-click menu draw the same items. */
interface MenuParts {
  readonly Group: ComponentType<{ readonly children: ReactNode }>;
  readonly Label: ComponentType<{ readonly children: ReactNode; readonly className?: string }>;
  readonly Item: ComponentType<{
    readonly onClick?: () => void;
    readonly children: ReactNode;
  }>;
  readonly Sub: ComponentType<{ readonly children: ReactNode }>;
  readonly SubTrigger: ComponentType<{ readonly children: ReactNode }>;
  readonly SubContent: ComponentType<{
    readonly children: ReactNode;
    readonly width?: "sm" | "md" | "lg";
  }>;
  readonly Shortcut: ComponentType<{ readonly children: ReactNode }>;
}

const DROPDOWN: MenuParts = {
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Shortcut: DropdownMenuShortcut,
};

const CONTEXT: MenuParts = {
  Group: ContextMenuGroup,
  Label: ContextMenuLabel,
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Shortcut: ContextMenuShortcut,
};

export interface RowMenuProps {
  readonly row: InboxRow;
  readonly actions: RowActions;
  readonly handlers: RowActionHandlers;
  /** Starts renaming the row in place. */
  readonly onRename: () => void;
}

/** The desk's menu items, in the frame's order: open, snooze, mark done, rename, copy link. */
function RowMenuItems({
  parts: { Group, Label, Item, Sub, SubTrigger, SubContent, Shortcut },
  row,
  actions,
  handlers,
  onRename,
}: RowMenuProps & { readonly parts: MenuParts }) {
  const navigate = useNavigate();
  const now = new Date();
  return (
    <Group>
      <Label className="truncate">{row.title}</Label>
      <Item onClick={() => void navigate(sessionPage(row.session.id))}>
        <ArrowUpRightIcon aria-hidden />
        Open session
        <Shortcut>↵</Shortcut>
      </Item>
      {actions.snooze ? (
        <Sub>
          <SubTrigger>
            <AlarmClockIcon aria-hidden />
            Snooze
          </SubTrigger>
          <SubContent width="sm">
            {snoozeChoices(now).map((choice) => (
              <Item key={choice.label} onClick={() => handlers.snooze(row, choice.until)}>
                {choice.label}
                <Shortcut>{whenAhead(choice.until, now)}</Shortcut>
              </Item>
            ))}
          </SubContent>
        </Sub>
      ) : null}
      {actions.unsnooze ? (
        <Item onClick={() => handlers.unsnooze(row)}>
          <AlarmClockOffIcon aria-hidden />
          Unsnooze
        </Item>
      ) : null}
      {actions.markDone ? (
        <Item onClick={() => handlers.markDone(row)}>
          <CheckCheckIcon aria-hidden />
          Mark done
        </Item>
      ) : null}
      {actions.markNotDone ? (
        <Item onClick={() => handlers.markNotDone(row)}>
          <Undo2Icon aria-hidden />
          Mark not done
        </Item>
      ) : null}
      {actions.rename ? (
        <Item onClick={onRename}>
          <PencilIcon aria-hidden />
          Rename
          <Shortcut>F2</Shortcut>
        </Item>
      ) : null}
      <Item onClick={() => handlers.copyLink(row)}>
        <LinkIcon aria-hidden />
        Copy link
      </Item>
    </Group>
  );
}

/** The row's "…" button and its menu: shown on hover or focus, and while the menu is open. */
export function RowMenuButton(props: RowMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${props.row.title}`}
        className="grid size-6.5 place-items-center rounded-md bg-background text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md" align="start">
        <RowMenuItems {...props} parts={DROPDOWN} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The same items as the row's right-click menu; the row is its `ContextMenu`'s trigger. */
export function RowContextMenuContent(props: RowMenuProps) {
  return (
    <ContextMenuContent width="md">
      <RowMenuItems {...props} parts={CONTEXT} />
    </ContextMenuContent>
  );
}

/**
 * The title as a text box, its name selected (Doop "Sidebar row", renaming): Enter saves, Esc
 * cancels, and leaving the box saves what was typed.
 */
export function RenameField({
  title,
  onSave,
  onCancel,
}: {
  readonly title: string;
  readonly onSave: (text: string) => void;
  readonly onCancel: () => void;
}) {
  // Enter and Esc end the edit before the box loses focus: the blur after them does nothing.
  const [ended, setEnded] = useState(false);
  const end = (then: () => void) => {
    if (ended) return;
    setEnded(true);
    then();
  };
  return (
    <div className="rounded-lg bg-sidebar-accent pt-1.5 pr-2 pb-1.75 pl-4.5">
      <input
        aria-label="Session name"
        defaultValue={title}
        ref={focusOnMount}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const text = event.currentTarget.value;
            end(() => onSave(text));
          } else if (event.key === "Escape") {
            event.preventDefault();
            end(onCancel);
          }
        }}
        onBlur={(event) => {
          const text = event.currentTarget.value;
          end(() => onSave(text));
        }}
        className="block w-full rounded-md bg-background px-1.5 py-0.5 text-row text-foreground ring-1 ring-ring outline-none focus-visible:ring-ring [box-shadow:0_0_0_3px_color-mix(in_oklab,var(--color-ring)_20%,transparent)] selection:bg-ring/24"
      />
      <span className="mt-0.5 block truncate pl-1.5 text-meta text-muted-foreground">
        Enter to save · Esc to cancel
      </span>
    </div>
  );
}

/**
 * A rename box opens because the person asked to rename: it takes the focus as it mounts, and
 * selects the name (its `onFocus`).
 */
const focusOnMount = (input: HTMLInputElement | null) => {
  input?.focus();
};

type Page = "actions" | "snooze" | "time" | "rename";

/** One 52px row of the phone's action sheet (Doop "Action sheet item"). */
function SheetItem({
  icon,
  value,
  chevron = false,
  onClick,
  children,
}: {
  readonly icon?: ReactNode;
  readonly value?: string;
  readonly chevron?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex h-13 w-full items-center gap-3.5 pr-4 pl-5 text-left text-lead text-foreground outline-none focus-visible:bg-muted active:bg-accent [&_svg]:size-4.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {value === undefined ? null : (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{value}</span>
      )}
      {chevron ? <ChevronRightIcon aria-hidden className="size-4" /> : null}
    </button>
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** A local date and time as a `datetime-local` box takes it: "2026-11-18T16:00". */
const localInput = (date: Date): string => {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * A row's actions on a phone (Doop "Phone · Inbox · row actions"): its 44px "…", and a sheet of
 * 52px rows. Snooze and Pick a time are second pages of the same sheet; Rename is a sheet with
 * the name selected, and Cancel and Save.
 */
export function PhoneRowActions({ row, actions, handlers }: Omit<RowMenuProps, "onRename">) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>("actions");
  const [name, setName] = useState(row.title);
  const [time, setTime] = useState("");
  const now = new Date();
  const show = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPage("actions");
      setName(row.title);
    }
  };
  const act = (action: () => void) => {
    setOpen(false);
    action();
  };
  const pickedTime = time === "" ? null : new Date(time);
  const header = (title: string, subtitle?: string) => (
    <SheetHeader
      className={cn(
        "flex-row items-center gap-1 border-b border-border py-2.5 pr-1.5",
        page === "actions" || page === "rename" ? "pl-5" : "pl-1.5",
      )}
    >
      {page === "snooze" || page === "time" ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-label="Back"
          onClick={() => setPage(page === "time" ? "snooze" : "actions")}
        >
          <ChevronLeftIcon aria-hidden className="size-5.5" />
        </Button>
      ) : null}
      <div className="min-w-0 flex-1">
        <SheetTitle className="truncate text-title font-semibold">{title}</SheetTitle>
        {subtitle === undefined ? null : (
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
    </SheetHeader>
  );
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
          {page === "actions" ? (
            <>
              {header(row.title)}
              <div role="menu" aria-label={`Actions for ${row.title}`} className="py-1">
                {actions.rename ? (
                  <SheetItem icon={<PencilIcon aria-hidden />} onClick={() => setPage("rename")}>
                    Rename…
                  </SheetItem>
                ) : null}
                {actions.snooze ? (
                  <SheetItem
                    icon={<AlarmClockIcon aria-hidden />}
                    chevron
                    onClick={() => setPage("snooze")}
                  >
                    Snooze
                  </SheetItem>
                ) : null}
                {actions.unsnooze ? (
                  <SheetItem
                    icon={<AlarmClockOffIcon aria-hidden />}
                    onClick={() => act(() => handlers.unsnooze(row))}
                  >
                    Unsnooze
                  </SheetItem>
                ) : null}
                {actions.markDone ? (
                  <SheetItem
                    icon={<CheckCheckIcon aria-hidden />}
                    onClick={() => act(() => handlers.markDone(row))}
                  >
                    Mark done
                  </SheetItem>
                ) : null}
                {actions.markNotDone ? (
                  <SheetItem
                    icon={<Undo2Icon aria-hidden />}
                    onClick={() => act(() => handlers.markNotDone(row))}
                  >
                    Mark not done
                  </SheetItem>
                ) : null}
                <SheetItem
                  icon={<LinkIcon aria-hidden />}
                  onClick={() => act(() => handlers.copyLink(row))}
                >
                  Copy link
                </SheetItem>
              </div>
            </>
          ) : null}
          {page === "snooze" ? (
            <>
              {header("Snooze until", row.title)}
              <div role="menu" aria-label="Snooze until" className="py-1">
                {snoozeChoices(now).map((choice) => (
                  <SheetItem
                    key={choice.label}
                    value={whenAhead(choice.until, now)}
                    onClick={() => act(() => handlers.snooze(row, choice.until))}
                  >
                    {choice.label}
                  </SheetItem>
                ))}
                <hr className="my-1 border-border" />
                <SheetItem
                  icon={<CalendarIcon aria-hidden />}
                  onClick={() => {
                    setTime(localInput(new Date(now.getTime() + 3 * 60 * 60_000)));
                    setPage("time");
                  }}
                >
                  Pick a time…
                </SheetItem>
              </div>
            </>
          ) : null}
          {page === "time" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (pickedTime !== null && pickedTime > now)
                  act(() => handlers.snooze(row, pickedTime));
              }}
            >
              {header("Pick a time", row.title)}
              <div className="px-4 py-4">
                <Input
                  type="datetime-local"
                  aria-label="Snooze until"
                  value={time}
                  min={localInput(now)}
                  onChange={(event) => setTime(event.currentTarget.value)}
                  className="h-11 text-lead"
                />
                {pickedTime !== null && pickedTime <= now ? (
                  <p className="mt-2 text-sm text-destructive">Pick a time after now.</p>
                ) : null}
              </div>
              <div className="flex gap-2 border-t border-border px-4 pt-3 pb-2">
                <Button
                  type="submit"
                  size="touch"
                  className="flex-1"
                  disabled={pickedTime === null || pickedTime <= now}
                >
                  Snooze
                </Button>
              </div>
            </form>
          ) : null}
          {page === "rename" ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                act(() => handlers.rename(row, name));
              }}
            >
              {header("Rename session")}
              <div className="border-b border-border px-4 py-4">
                <Input
                  aria-label="Session name"
                  value={name}
                  ref={focusOnMount}
                  onFocus={(event) => event.currentTarget.select()}
                  onChange={(event) => setName(event.currentTarget.value)}
                  className="h-11 text-lead"
                />
              </div>
              <div className="flex gap-2 px-4 pt-3 pb-2">
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="flex-1"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" size="touch" className="flex-1">
                  Save
                </Button>
              </div>
            </form>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
