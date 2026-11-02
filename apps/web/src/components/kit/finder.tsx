import { Combobox } from "@base-ui/react/combobox";
import { useState, type ReactElement, type ReactNode } from "react";

import { fuzzyFilter, type FuzzyMatch } from "./fuzzy";
import { menuPanel, menuRow } from "./menu";

/** The search box at the top of a finder (`.search`). */
export const finderInput =
  "mb-1.5 w-full rounded-[10px] bg-secondary px-3 py-[7px] font-sans text-[13px] text-foreground outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-ring/30";

/** A finder row in the mono `.dd .o` voice: branches, worktrees, paths. */
export const finderMonoRow =
  "flex cursor-default items-baseline gap-2.5 rounded-[9px] px-2.5 py-[7px] font-mono text-[13px] text-ink-2 outline-none select-none data-highlighted:bg-wash data-highlighted:text-foreground data-selected:text-foreground";

/** The text with the characters the query matched in bold. */
export function Highlight({
  text,
  match,
}: {
  readonly text: string;
  readonly match: FuzzyMatch | undefined;
}) {
  if (match === undefined || match.indices.length === 0) return <>{text}</>;
  const hits = new Set(match.indices);
  return (
    <>
      {[...text].map((character, index) =>
        hits.has(index) ? (
          <b key={index} className="font-semibold text-foreground">
            {character}
          </b>
        ) : (
          <span key={index}>{character}</span>
        ),
      )}
    </>
  );
}

/**
 * `.dd`: pick one item by typing a few of its characters, like `mend` in the terminal. A Base UI
 * combobox with its input inside the popup: the trigger opens it, typing filters and ranks, the
 * arrows move, Enter picks, Escape closes and returns focus to the trigger.
 *
 * ```tsx
 * <FuzzyFinder label="Branch" items={branches} itemText={(b) => b.name} itemKey={(b) => b.name}
 *   meta={(b) => b.age} onPick={(b) => setBranch(b.name)}
 *   trigger={<Pick>{branch}</Pick>} placeholder="Find a branch" />
 * ```
 */
export function FuzzyFinder<T>({
  label,
  items,
  itemKey,
  itemText,
  meta,
  onPick,
  trigger,
  placeholder,
  emptyText = "Nothing matches",
  hint = "↑↓ move · ↵ pick · type to narrow",
  mono = true,
  width = 320,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<T>;
  readonly itemKey: (item: T) => string;
  readonly itemText: (item: T) => string;
  readonly meta?: (item: T) => ReactNode;
  readonly onPick: (item: T) => void;
  readonly trigger: ReactElement;
  readonly placeholder: string;
  readonly emptyText?: string;
  readonly hint?: string | null;
  readonly mono?: boolean;
  readonly width?: number;
}) {
  const [query, setQuery] = useState("");
  const ranked = fuzzyFilter(items, query, itemText);
  const matches = new Map(ranked.map(({ item, match }) => [itemKey(item), match]));
  return (
    <Combobox.Root
      items={[...items]}
      filteredItems={ranked.map(({ item }) => item)}
      filter={null}
      value={null}
      inputValue={query}
      onInputValueChange={(next) => setQuery(next)}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      itemToStringLabel={itemText}
      onValueChange={(picked) => {
        const chosen = items.find((item) => picked !== null && itemKey(item) === itemKey(picked));
        if (chosen !== undefined) onPick(chosen);
      }}
      autoHighlight
    >
      <Combobox.Trigger render={trigger} aria-label={label} />
      <Combobox.Portal>
        <Combobox.Positioner
          align="start"
          sideOffset={6}
          collisionPadding={8}
          collisionAvoidance={{ side: "flip", align: "shift", fallbackAxisSide: "end" }}
          className="z-50"
        >
          <Combobox.Popup aria-label={label} style={{ width }} className={menuPanel}>
            <Combobox.Input placeholder={placeholder} aria-label={label} className={finderInput} />
            <Combobox.Empty className="px-2.5 py-2 font-mono text-[12px] text-faint empty:hidden">
              {emptyText}
            </Combobox.Empty>
            <Combobox.List className="max-h-[min(320px,var(--available-height))] overflow-y-auto overscroll-contain data-empty:hidden">
              {(item: T) => (
                <Combobox.Item
                  key={itemKey(item)}
                  value={item}
                  className={mono ? finderMonoRow : menuRow}
                >
                  <span className="min-w-0 truncate">
                    <Highlight text={itemText(item)} match={matches.get(itemKey(item))} />
                  </span>
                  {meta === undefined ? null : (
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-faint">
                      {meta(item)}
                    </span>
                  )}
                </Combobox.Item>
              )}
            </Combobox.List>
            {hint === null ? null : (
              <div
                aria-hidden="true"
                className="mt-1 flex gap-2 border-t border-rule-faint px-2.5 pt-[7px] pb-[3px] font-mono text-[11px] text-faint"
              >
                {hint}
              </div>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
