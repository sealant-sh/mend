import type { ReactNode } from "react";

import { Button } from "./button";
import { Panel } from "./section";
import { ErrorNote } from "./status";
import { UnsavedGuard } from "./unsaved-guard";

/**
 * `.savebar`: the panel under a draft that says what is unsaved (`1 unsaved change · rebuilds the
 * image`), with Discard and the one primary action. It shows while there is something to save, a
 * save is running, or one failed; the failure is announced.
 *
 * - While the draft is unsaved, leaving the page asks first (`UnsavedGuard`).
 * - `said` is what the last save or discard did ("Saved", "Discarded"). It sits in a polite status
 *   region that stays mounted while the bar comes and goes, so a screen reader hears it after the
 *   bar that held the focused button has gone.
 * - `returnFocus` puts the focus back on the draft (`focusFirstControl(fields)`) when the bar goes
 *   while it held the focus, instead of dropping it on the page.
 *
 * ```tsx
 * <SaveBar dirty={dirty} summary="1 unsaved change" saveLabel="Save workspace" pending={save.isPending}
 *   error={save.error === null ? null : errorText(save.error)} said={said}
 *   returnFocus={() => focusFirstControl(fields.current)} onDiscard={reset} onSave={() => save.mutate(draft)} />
 * ```
 */
export function SaveBar({
  dirty,
  summary,
  saveLabel,
  pendingLabel = "Saving…",
  pending,
  error,
  said,
  returnFocus,
  onDiscard,
  onSave,
  canSave = true,
}: {
  readonly dirty: boolean;
  readonly summary: ReactNode;
  readonly saveLabel: string;
  readonly pendingLabel?: string;
  readonly pending: boolean;
  /** Why the last save failed; null or undefined while nothing failed. */
  readonly error?: ReactNode;
  /** What the last save or discard did, said once the bar has gone. */
  readonly said?: ReactNode;
  readonly returnFocus?: () => void;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
  /** False while the draft cannot be saved as it stands (a required field is empty). */
  readonly canSave?: boolean;
}) {
  const failed = error !== null && error !== undefined;
  const shown = dirty || pending || failed;
  // When the bar goes while one of its buttons has the focus, hand the focus back to the draft.
  const keepFocus = (node: HTMLDivElement | null) => {
    if (node === null || returnFocus === undefined) return undefined;
    return () => {
      if (node.contains(document.activeElement)) queueMicrotask(returnFocus);
    };
  };
  return (
    <>
      <UnsavedGuard dirty={dirty} summary={<>{summary}. Leaving drops the draft.</>} />
      {shown ? (
        <div ref={keepFocus}>
          <Panel className="mt-3.5 grid gap-2.5 py-3 pr-4 pl-5">
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[12px] text-muted-foreground">
                {pending ? pendingLabel : summary}
              </span>
              <span className="flex-1" />
              <Button variant="ghost" disabled={pending} onClick={onDiscard}>
                Discard
              </Button>
              <Button variant="primary" disabled={pending || !canSave} onClick={onSave}>
                {pending ? pendingLabel : saveLabel}
              </Button>
            </div>
            {failed ? <ErrorNote>{error}</ErrorNote> : null}
          </Panel>
        </div>
      ) : null}
      <SaveStatus>{shown ? null : said}</SaveStatus>
    </>
  );
}

/**
 * What the last save or discard of a draft did, in a polite live region that stays mounted while
 * the `SaveBar` comes and goes. `SaveBar` renders one; use it alone only beside a draft that saves
 * without a bar.
 */
export function SaveStatus({ children }: { readonly children: ReactNode }) {
  return (
    <p role="status" className="mt-3.5 font-mono text-[12px] text-muted-foreground empty:hidden">
      {children}
    </p>
  );
}

/** Focus the first control inside a draft's fields: the picked option, else the first input. */
export const focusFirstControl = (fields: HTMLElement | null) =>
  fields
    ?.querySelector<HTMLElement>('button[aria-pressed="true"], input, textarea, select, button')
    ?.focus();
