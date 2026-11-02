import { Combobox } from "@base-ui/react/combobox";
import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { finderMonoRow, Highlight } from "./finder";
import { fuzzyFilter } from "./fuzzy";
import { Icon } from "./icons";
import { menuPanel } from "./menu";

/** Why the text changed, when it was the person typing, pasting or clearing it. */
const TEXT_EDITS: ReadonlySet<string> = new Set([
  "input-change",
  "input-paste",
  "input-clear",
  "clear-press",
]);

/**
 * `.search` + `.dd`: a text field that suggests as you type, with the suggestions under it (the
 * New worktree base branch, the Adopt repository search). A Base UI combobox whose input is the
 * field itself, so whatever was typed stays a valid value: a ref no suggestion names, a git URL
 * pasted whole. Arrows move through the suggestions, Enter picks one, Escape closes them.
 *
 * `filter="fuzzy"` ranks `items` by the typed text, like `mend` in the terminal; `filter="none"`
 * shows `items` as they come, for results a server already searched. `status` is announced
 * (searching, an error), `footer` closes the list (`4 of 38 · github.com as ypanagidis`).
 *
 * ```tsx
 * <Field label="Base branch or ref">{(id) => (
 *   <SearchCombobox id={id} items={branches} itemKey={(b) => b.name} itemText={(b) => b.name}
 *     meta={(b) => b.sha.slice(0, 7)} value={base} onValueChange={setBase} filter="fuzzy" />
 * )}</Field>
 * ```
 */
export function SearchCombobox<T>({
  id,
  items,
  itemKey,
  itemText,
  meta,
  value,
  onValueChange,
  onPick,
  filter,
  placeholder,
  status,
  footer,
  trailing,
  disabled = false,
  invalid = false,
  describedBy,
  autoFocus = false,
}: {
  readonly id: string;
  readonly items: ReadonlyArray<T>;
  readonly itemKey: (item: T) => string;
  readonly itemText: (item: T) => string;
  readonly meta?: (item: T) => ReactNode;
  /** The field's text; picking an item writes `itemText(item)` here. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onPick?: (item: T) => void;
  readonly filter: "fuzzy" | "none";
  readonly placeholder?: string;
  /** Searching, or why there is nothing: announced politely. */
  readonly status?: ReactNode;
  readonly footer?: ReactNode;
  /** Quiet text at the end of the field, such as `4 / 212`. */
  readonly trailing?: ReactNode;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  readonly autoFocus?: boolean;
}) {
  const ranked =
    filter === "fuzzy"
      ? fuzzyFilter(items, value, itemText)
      : items.map((item) => ({ item, match: undefined }));
  const matches = new Map(ranked.map(({ item, match }) => [itemKey(item), match]));
  const shown = ranked.map(({ item }) => item);
  return (
    <Combobox.Root
      items={[...items]}
      filteredItems={shown}
      filter={null}
      value={null}
      inputValue={value}
      // Only the person's own edits change the text. Closing the list (a blur, Tab, a press
      // outside) would otherwise put back the empty selection and drop a URL pasted whole.
      onInputValueChange={(next, { reason }) => {
        if (TEXT_EDITS.has(reason)) onValueChange(next);
      }}
      itemToStringLabel={itemText}
      onValueChange={(picked) => {
        if (picked === null) return;
        const chosen = items.find((item) => itemKey(item) === itemKey(picked));
        if (chosen === undefined) return;
        onValueChange(itemText(chosen));
        onPick?.(chosen);
      }}
      disabled={disabled}
    >
      <Combobox.InputGroup
        className={cn(
          "flex items-center gap-2.5 rounded-[10px] border bg-panel py-[7px] pr-2.5 pl-3 text-faint focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30",
          invalid ? "border-danger" : "border-input",
        )}
      >
        <Icon name="search" size={14} />
        <Combobox.Input
          id={id}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:font-sans placeholder:text-faint"
        />
        {trailing === undefined ? null : (
          <span className="shrink-0 font-mono text-[11px] text-faint">{trailing}</span>
        )}
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={6} className="z-50">
          <Combobox.Popup
            className={cn(menuPanel, "w-[var(--anchor-width)] max-w-[var(--available-width)]")}
          >
            <Combobox.Status className="px-2.5 py-1.5 font-mono text-[11.5px] text-faint empty:hidden">
              {status}
            </Combobox.Status>
            <Combobox.List className="max-h-[min(280px,var(--available-height))] overflow-y-auto overscroll-contain data-empty:hidden">
              {(item: T) => (
                <Combobox.Item key={itemKey(item)} value={item} className={finderMonoRow}>
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
            {footer === undefined ? null : (
              <div className="mt-1 flex gap-2 border-t border-rule-faint px-2.5 pt-[7px] pb-[3px] font-mono text-[11px] text-faint">
                {footer}
              </div>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
