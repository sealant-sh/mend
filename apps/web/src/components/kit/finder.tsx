import type { ComponentProps } from "react";

import type * as Popup from "./finder-popup";
import { Deferred, firstUse } from "./first-use";
import type { FuzzyMatch } from "./fuzzy";

/** Base UI's combobox, loaded on first use (`./first-use`). */
const finders = firstUse(() => import("./finder-popup"));

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
export function FuzzyFinder<T>(
  props: Omit<ComponentProps<typeof Popup.FuzzyFinder<T>>, "defaultOpen" | "triggerRef">,
) {
  return (
    <Deferred code={finders} trigger={props.trigger} popup="listbox" label={props.label}>
      {(code, woken) => (
        <code.FuzzyFinder {...props} defaultOpen={woken.pressed} triggerRef={woken.triggerRef} />
      )}
    </Deferred>
  );
}
