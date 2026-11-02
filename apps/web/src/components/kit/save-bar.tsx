import type { ReactNode } from "react";

import { Button } from "./button";
import { Panel } from "./section";
import { ErrorNote } from "./status";

/**
 * `.savebar`: the panel under a form that says what is unsaved, with Discard and the one primary
 * action. It shows only while there is something to save, a save is running, or one failed; the
 * failure is announced.
 *
 * ```tsx
 * <SaveBar dirty={dirty} summary="1 unsaved change" saveLabel="Save workspace" pending={save.isPending}
 *   error={save.error} onDiscard={reset} onSave={() => save.mutate(draft)} />
 * ```
 */
export function SaveBar({
  dirty,
  summary,
  saveLabel,
  pendingLabel = "Saving…",
  pending,
  error,
  onDiscard,
  onSave,
  canSave = true,
}: {
  readonly dirty: boolean;
  readonly summary: ReactNode;
  readonly saveLabel: string;
  readonly pendingLabel?: string;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
  /** False while the draft cannot be saved as it stands (a required field is empty). */
  readonly canSave?: boolean;
}) {
  if (!dirty && !pending && error === null) return null;
  return (
    <Panel className="mt-3.5 grid gap-2.5 py-3 pr-4 pl-5">
      <div className="flex items-center gap-2.5">
        <span role="status" className="font-mono text-[12px] text-muted-foreground">
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
      {error === null ? null : <ErrorNote>{error}</ErrorNote>}
    </Panel>
  );
}
