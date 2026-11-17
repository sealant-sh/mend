import { Combobox } from "@base-ui/react/combobox";
import { useState, type ReactElement, type ReactNode } from "react";

import { finderInput, finderMonoRow, Highlight } from "./finder";
import { fuzzyFilter } from "./fuzzy";
import { menuPanel, menuRow } from "./menu";

/** The finder itself, which `./finder` loads on first use. */
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
  defaultOpen,
  triggerRef,
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
  readonly defaultOpen: boolean;
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
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
      defaultOpen={defaultOpen}
    >
      <Combobox.Trigger ref={triggerRef} render={trigger} aria-label={label} />
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
