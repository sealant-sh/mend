import type { SavedLayout, TileLayout } from "@mend/domain/workbench";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  Columns2Icon,
  LayoutGridIcon,
  LayoutPanelLeftIcon,
  LayoutPanelTopIcon,
  PencilIcon,
  RotateCcwIcon,
  Rows2Icon,
  SaveIcon,
  SquareIcon,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  type ApplyContext,
  BUILT_IN_LAYOUTS,
  type LayoutPicture,
  layoutDigit,
  layoutNameIssue,
  layoutOfArrangement,
  pictureOf,
  SAVED_SHORTCUTS,
  showsLayout,
} from "#/lib/layouts";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { isMac } from "#/lib/search-keys";
import type { Arrangement } from "#/lib/tiles";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

const PICTURES: Readonly<Record<LayoutPicture, ReactNode>> = {
  one: <SquareIcon aria-hidden />,
  columns: <Columns2Icon aria-hidden />,
  rows: <Rows2Icon aria-hidden />,
  "panel-left": <LayoutPanelLeftIcon aria-hidden />,
  // Lucide's panel is the top one; this layout is two tiles over one.
  "panel-top": <LayoutPanelTopIcon aria-hidden className="rotate-180" />,
  grid: <LayoutGridIcon aria-hidden />,
};

/** The refusals the server words for a person (`SavedLayoutNameTaken`, …). */
const SERVER_WORDED = new Set([
  "SavedLayoutNameTaken",
  "SavedLayoutLimitReached",
  "SavedLayoutNotFound",
]);

const wordsOf = (cause: unknown, fallback: string): string =>
  SERVER_WORDED.has(refusalTagOf(cause) ?? "") ? failureWords(cause, fallback) : fallback;

const never = () => () => undefined;

/** How a layout's shortcut is written here: "⌥1" on a Mac, "Alt 1" elsewhere. */
const useAltKey = (): string =>
  useSyncExternalStore(
    never,
    () => (isMac() ? "⌥" : "Alt "),
    () => "⌥",
  );

export interface LayoutMenuProps {
  /** The sheet as it is now. */
  readonly arrangement: Arrangement;
  readonly context: ApplyContext;
  /** Picks `layout`; `name` is what the menu called it, for screen readers. */
  readonly onApply: (layout: TileLayout, name: string) => void;
  readonly onReset: () => void;
}

/**
 * The Workspace header's layout button and its menu (Doop "T18 · Choose a layout", "Layout menu ·
 * Save this layout", "Layout menu · layout saved"): the four built-in layouts (⌥1 to ⌥4), "Your
 * layouts" (the person's saved ones, the same in every workspace; the first five take ⌥5 to ⌥9),
 * "Save this layout…", "Rename or remove…" and "Reset to one tile". The layout the sheet shows now
 * has a check. Picking one rearranges only this workspace (`applyLayout`). From 1024px only: under
 * it the tiles are one strip (ADR 0026), and the button isn't drawn.
 */
export function LayoutMenu({ arrangement, context, onApply, onReset }: LayoutMenuProps) {
  const trpc = useTRPC();
  const saved = useQuery(trpc.layouts.list.queryOptions());
  const alt = useAltKey();
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [managing, setManaging] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const yours: ReadonlyArray<SavedLayout> = saved.isSuccess ? saved.data.layouts : [];
  const current = layoutOfArrangement(arrangement);

  const pick = (digit: number) => {
    const builtIn = BUILT_IN_LAYOUTS[digit - 1];
    if (builtIn !== undefined) onApply(builtIn.layout, builtIn.name);
    const own =
      digit > BUILT_IN_LAYOUTS.length ? yours[digit - BUILT_IN_LAYOUTS.length - 1] : undefined;
    if (own !== undefined) onApply(own.layout, own.name);
  };
  const onShortcut = useEffectEvent((digit: number) => pick(digit));
  // Listening to the window: a shortcut works wherever the focus is on the page.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const digit = layoutDigit(event);
      if (digit === null) return;
      event.preventDefault();
      onShortcut(digit);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const row = (key: string, name: string, layout: TileLayout, shortcut: number | null) => {
    const shown = showsLayout(arrangement, layout, context);
    return (
      <DropdownMenuItem key={key} onClick={() => onApply(layout, name)}>
        {PICTURES[pictureOf(layout)]}
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {shortcut === null ? null : (
          <DropdownMenuShortcut>
            {alt}
            {shortcut}
          </DropdownMenuShortcut>
        )}
        {shown ? (
          <>
            <CheckIcon aria-hidden className={shortcut === null ? "ml-auto" : undefined} />
            <span className="sr-only">, shown now</span>
          </>
        ) : null}
      </DropdownMenuItem>
    );
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={trigger}
          aria-label="Layout"
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon-sm" }),
            "text-muted-foreground data-popup-open:bg-accent data-popup-open:text-foreground",
          )}
        >
          <LayoutPanelLeftIcon aria-hidden className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent width="lg" align="end">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Layouts</DropdownMenuLabel>
            {BUILT_IN_LAYOUTS.map((each, index) => row(each.id, each.name, each.layout, index + 1))}
          </DropdownMenuGroup>
          {saved.isSuccess && yours.length === 0 ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Your layouts</DropdownMenuLabel>
                {saved.isPending ? (
                  <DropdownMenuItem disabled>Loading your layouts…</DropdownMenuItem>
                ) : saved.isError ? (
                  <DropdownMenuItem closeOnClick={false} onClick={() => void saved.refetch()}>
                    <span className="min-w-0 flex-1">
                      {saved.isRefetching
                        ? "Trying again…"
                        : "Couldn't load your layouts. Try again"}
                    </span>
                  </DropdownMenuItem>
                ) : (
                  yours.map((each, index) =>
                    row(
                      each.id,
                      each.name,
                      each.layout,
                      index < SAVED_SHORTCUTS ? BUILT_IN_LAYOUTS.length + index + 1 : null,
                    ),
                  )
                )}
              </DropdownMenuGroup>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem disabled={current === null} onClick={() => setNaming(true)}>
              <SaveIcon aria-hidden />
              Save this layout…
            </DropdownMenuItem>
            {yours.length > 0 ? (
              <DropdownMenuItem onClick={() => setManaging(true)}>
                <PencilIcon aria-hidden />
                Rename or remove…
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem onClick={onReset}>
              <RotateCcwIcon aria-hidden />
              Reset to one tile
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {current === null ? null : (
        <SaveLayoutDialog
          open={naming}
          layout={current}
          finalFocus={trigger}
          onOpenChange={setNaming}
          onSaved={() => setOpen(true)}
        />
      )}
      <YourLayoutsDialog
        open={managing}
        layouts={yours}
        finalFocus={trigger}
        onOpenChange={setManaging}
      />
    </>
  );
}

/** "Save this layout" (Doop `5AoTAMps6K`): a name, then the menu shows it under "Your layouts". */
function SaveLayoutDialog({
  open,
  layout,
  finalFocus,
  onOpenChange,
  onSaved,
}: {
  readonly open: boolean;
  readonly layout: TileLayout;
  readonly finalFocus: React.RefObject<HTMLButtonElement | null>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSaved: () => void;
}) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [shown, setShown] = useState<string | null>(null);
  const formId = useId();
  const save = useMutation(
    trpc.layouts.save.mutationOptions({
      onSuccess: (layoutSaved) => {
        void client.invalidateQueries({ queryKey: trpc.layouts.list.queryKey() });
        toast.add({ description: `Saved the layout “${layoutSaved.name}”.`, priority: "low" });
        setName("");
        onOpenChange(false);
        onSaved();
      },
      onError: (cause) =>
        setShown(wordsOf(cause, "Couldn't save the layout. Check your connection and try again.")),
    }),
  );
  const submit = () => {
    const trimmed = name.trim();
    const issue = layoutNameIssue(trimmed);
    if (issue !== null) {
      setShown(issue);
      return;
    }
    setShown(null);
    save.mutate({ name: trimmed, layout });
  };
  const errorId = `${formId}-error`;
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) setShown(null);
        onOpenChange(next);
      }}
      title="Save this layout"
      description="Saves the tiles and the tabs open in them. Your saved layouts show in the layout menu of every workspace."
      size="sm"
      finalFocus={finalFocus}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save layout"}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field data-invalid={shown !== null}>
          <FieldLabel htmlFor={`${formId}-name`}>Name</FieldLabel>
          <Input
            id={`${formId}-name`}
            value={name}
            autoFocus
            maxLength={60}
            aria-invalid={shown !== null}
            aria-describedby={shown === null ? `${formId}-hint` : errorId}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          {shown === null ? (
            <FieldDescription id={`${formId}-hint`}>
              Only you see your saved layouts.
            </FieldDescription>
          ) : (
            <p id={errorId} role="alert" className="text-sm text-destructive">
              {shown}
            </p>
          )}
        </Field>
      </form>
    </Overlay>
  );
}

/**
 * Rename or remove a saved layout. No frame draws it; without it a person at the limit of saved
 * layouts couldn't make room. Each row renames in place, or removes the layout everywhere.
 */
function YourLayoutsDialog({
  open,
  layouts,
  finalFocus,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly layouts: ReadonlyArray<SavedLayout>;
  readonly finalFocus: React.RefObject<HTMLButtonElement | null>;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title="Your layouts"
      description="Renaming or removing a layout changes it in every workspace."
      size="sm"
      finalFocus={finalFocus}
      footer={
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      {layouts.length === 0 ? (
        <p className="text-muted-foreground">You have no saved layouts.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {layouts.map((layout) => (
            <YourLayoutRow key={layout.id} layout={layout} />
          ))}
        </ul>
      )}
    </Overlay>
  );
}

function YourLayoutRow({ layout }: { readonly layout: SavedLayout }) {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(layout.name);
  const [shown, setShown] = useState<string | null>(null);
  const fieldId = useId();
  const refresh = () => client.invalidateQueries({ queryKey: trpc.layouts.list.queryKey() });
  const rename = useMutation(
    trpc.layouts.rename.mutationOptions({
      onSuccess: () => {
        void refresh();
        setEditing(false);
      },
      onError: (cause) =>
        setShown(
          wordsOf(cause, "Couldn't rename the layout. Check your connection and try again."),
        ),
    }),
  );
  const remove = useMutation(
    trpc.layouts.remove.mutationOptions({
      onSuccess: () => {
        void refresh();
        toast.add({ description: `Removed the layout “${layout.name}”.`, priority: "low" });
      },
      onError: (cause) =>
        setShown(
          wordsOf(cause, "Couldn't remove the layout. Check your connection and try again."),
        ),
    }),
  );
  const submit = () => {
    const trimmed = name.trim();
    const issue = layoutNameIssue(trimmed);
    if (issue !== null) {
      setShown(issue);
      return;
    }
    setShown(null);
    if (trimmed === layout.name) setEditing(false);
    else rename.mutate({ id: layout.id, request: { name: trimmed } });
  };
  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Input
            id={fieldId}
            aria-label={`New name for ${layout.name}`}
            value={name}
            autoFocus
            maxLength={60}
            aria-invalid={shown !== null}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              setEditing(false);
              setName(layout.name);
              setShown(null);
            }}
          />
          <Button type="submit" size="sm" disabled={rename.isPending}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground [&_svg]:size-4">
            {PICTURES[pictureOf(layout.layout)]}
          </span>
          <span className="min-w-0 flex-1 truncate">{layout.name}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Rename ${layout.name}`}
            onClick={() => setEditing(true)}
          >
            Rename
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Remove ${layout.name}`}
            className="text-destructive"
            disabled={remove.isPending}
            onClick={() => {
              setShown(null);
              remove.mutate({ id: layout.id });
            }}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        </div>
      )}
      {shown === null ? null : (
        <p role="alert" className="text-meta text-destructive">
          {shown}
        </p>
      )}
    </li>
  );
}
