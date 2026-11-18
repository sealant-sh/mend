import { Dialog, DialogContent, DialogTitle } from "@mend/ui/components/ui/dialog";
import { Kbd } from "@mend/ui/components/ui/kbd";
import { cn } from "@mend/ui/lib/utils";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import * as React from "react";

/**
 * The command palette (⌘K): a 512px popover 128px from the top of the window over the scrim, with
 * the query field, the results and a footer of keys and the result count.
 *
 * It only presents. The app searches as `query` changes and passes the results as children:
 * `CommandPaletteGroup`s of `CommandPaletteItem`s, and a `CommandPaletteEmpty` (holding an Empty
 * state of kind inline) that shows when there are none. `scope` says where it searches ("in Northwind"); `count` says how many it found
 * ("4 results"). Arrow keys, Enter and Escape come from cmdk and Base UI's dialog.
 */
function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
  placeholder,
  scope,
  count,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
  scope?: string;
  count?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="command-palette"
        showCloseButton={false}
        className={cn(
          "top-32 translate-y-0 gap-0 overflow-hidden rounded-palette border border-input p-0 text-row ring-0 data-[size=md]:sm:max-w-palette",
          className,
        )}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {/* The app has already searched: cmdk keeps its order and only moves the highlight. */}
        <CommandPrimitive shouldFilter={false} loop className="flex flex-col">
          <div
            data-slot="command-palette-input"
            className="flex h-12 items-center gap-2 border-b px-3"
          >
            <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <CommandPrimitive.Input
              value={query}
              onValueChange={onQueryChange}
              placeholder={placeholder}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-hidden placeholder:text-faint"
            />
            {scope === undefined ? null : (
              <span className="shrink-0 text-2xs text-muted-foreground">{scope}</span>
            )}
          </div>
          <CommandPrimitive.List
            data-slot="command-palette-list"
            className="max-h-96 scroll-py-1 overflow-y-auto p-1 outline-none **:[[cmdk-group-heading]]:px-2 **:[[cmdk-group-heading]]:py-1.5 **:[[cmdk-group-heading]]:text-2xs **:[[cmdk-group-heading]]:font-medium **:[[cmdk-group-heading]]:text-muted-foreground"
          >
            {children}
          </CommandPrimitive.List>
          <div
            data-slot="command-palette-footer"
            className="flex h-10 items-center gap-4 border-t px-3 text-2xs text-muted-foreground"
          >
            <span className="flex items-center gap-1.5">
              <Kbd>↑↓</Kbd>Move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>↵</Kbd>Open
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Esc</Kbd>Close
            </span>
            {count === undefined ? null : (
              <span aria-live="polite" className="ms-auto">
                {count}
              </span>
            )}
          </div>
        </CommandPrimitive>
      </DialogContent>
    </Dialog>
  );
}

/** A group of results under a muted heading: Actions, Sessions, Projects, Settings. */
function CommandPaletteGroup(props: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group data-slot="command-palette-group" {...props} />;
}

/** Shown only while the palette holds no results. */
function CommandPaletteEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-palette-empty" {...props} />;
}

/**
 * One result: an icon, the name (wrap the typed letters in `CommandPaletteMatch`), a muted
 * `context` and an optional `trailing` piece such as a session's Status. Give each a unique
 * `value`; `onSelect` runs on Enter or a click.
 */
function CommandPaletteItem({
  icon,
  context,
  trailing,
  children,
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
  icon?: React.ReactNode;
  context?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <CommandPrimitive.Item
      data-slot="command-palette-item"
      className={cn(
        "grid h-9 cursor-default grid-cols-[--spacing(4)_minmax(0,1fr)_auto_auto] items-center gap-2.5 rounded-md px-2 whitespace-nowrap outline-hidden select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-selected:bg-accent [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span aria-hidden="true" className="flex text-muted-foreground">
        {icon}
      </span>
      <span className="truncate">{children}</span>
      <span className="text-2xs text-muted-foreground">{context}</span>
      <span>{trailing}</span>
    </CommandPrimitive.Item>
  );
}

/** `text` with every case-insensitive occurrence of `query` in semibold. */
function CommandPaletteMatch({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return text;
  const parts: React.ReactNode[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <b key={at} className="font-semibold">
        {text.slice(at, at + needle.length)}
      </b>,
    );
    from = at + needle.length;
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

export {
  CommandPalette,
  CommandPaletteEmpty,
  CommandPaletteGroup,
  CommandPaletteItem,
  CommandPaletteMatch,
};
