import { Link } from "@tanstack/react-router";
import type { MouseEvent } from "react";

import type { WorktreeGroup } from "#/components/project-detail/model";
import type { SessionDto } from "#/lib/api";

/** The page owns actions; worktree and session rows keep their own menus. */
export interface DetailHandlers {
  readonly onWorktreeMenu: (event: MouseEvent, group: WorktreeGroup) => void;
  readonly onSessionMenu: (event: MouseEvent, session: SessionDto) => void;
}

/** Clear settled requires a second, explicit confirmation click. */
export interface ClearSettled {
  readonly count: number;
  readonly state: "idle" | "armed" | "working";
  /** What the last sweep left standing, as a mono fact beside the button; null says nothing. */
  readonly note?: string | null;
  readonly onClear: () => void;
  readonly onBlur: () => void;
}

/** Review belongs to the worktree's change, not an arbitrary child session. */
export function ReviewLink({ group }: { readonly group: WorktreeGroup }) {
  const changeId = group.annotation?.changeId ?? null;
  if (changeId === null) return null;
  return (
    <Link
      to="/changes/$changeId"
      params={{ changeId }}
      className="shrink-0 font-sans text-xs font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
    >
      Review
    </Link>
  );
}

/** Preserve the existing two-click confirmation and cancel it on blur. */
export function ClearSettledButton({ clear }: { readonly clear: ClearSettled }) {
  if (clear.count === 0) return null;
  return (
    <div className="mt-4 flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1">
      {clear.note !== undefined && clear.note !== null && (
        <p role="status" className="font-mono text-[11.5px] text-faint">
          {clear.note}
        </p>
      )}
      <button
        type="button"
        disabled={clear.state === "working"}
        onClick={clear.onClear}
        onBlur={clear.onBlur}
        className={`font-sans text-xs font-medium transition-colors ${
          clear.state === "armed" ? "text-warning" : "text-muted-foreground hover:text-foreground"
        } disabled:opacity-50`}
      >
        {clear.state === "working"
          ? "Clearing…"
          : clear.state === "armed"
            ? `Really remove ${clear.count} settled worktree${clear.count === 1 ? "" : "s"}? Sessions and changes go with them.`
            : "Clear settled"}
      </button>
    </div>
  );
}
