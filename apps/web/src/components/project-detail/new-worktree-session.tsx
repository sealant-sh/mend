import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";

import type { SessionDto, WorktreeDto } from "#/lib/api";
import { HARNESSES, startComposedSessionInWorktree, type Harness } from "#/lib/session-launch";
import { useWorktreeJoinLine } from "#/lib/shared-workspace";
import { useTRPC } from "#/lib/trpc";

/**
 * Start a conversation inside a worktree that already exists — the worktree
 * header's own verb. It never provisions a worktree and never composes a
 * prompt: pick a harness, land on the session.
 */

/** The harnesses a worktree offers, matching the worktree context menu. */
const WORKTREE_HARNESSES: ReadonlyArray<Harness> = HARNESSES.filter(
  (harness) => harness !== "shell",
);

/**
 * A compact "New session" control for one worktree row or card. The choice of
 * harness creates and launches the session in `worktreeId`, then opens it; a refusal
 * stays beside the button so the worktree keeps its place on the page.
 *
 * `worktreeName` only names the button for screen readers — several of these
 * sit on one page, and "New session" alone does not say where.
 *
 * `sessions` are the worktree's sessions the page holds: when someone else's runs there, the menu
 * says so before the viewer joins its workspace (docs/adr/0016, decision 13).
 */
export function NewWorktreeSession({
  worktreeId,
  worktreeName,
  sessions = [],
}: {
  readonly worktreeId: WorktreeDto["id"];
  readonly worktreeName?: string;
  readonly sessions?: ReadonlyArray<SessionDto>;
}) {
  const navigate = useNavigate();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const joinLine = useWorktreeJoinLine(worktreeId, sessions);

  const start = (harness: Harness) => {
    if (pending) return;
    setPending(true);
    setError(null);
    void startComposedSessionInWorktree(navigate, { queryClient, trpc }, worktreeId, {
      harness,
      prompt: "",
    })
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error ? `Could not start — ${cause.message}` : "Could not start.",
        );
      })
      .finally(() => setPending(false));
  };

  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {error !== null && (
        <span role="alert" title={error} className="max-w-56 truncate text-[11.5px] text-danger">
          {error}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="xs" disabled={pending} />}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          {pending ? "Starting…" : "New session"}
          {/* Several of these sit on one page; the worktree's name is what
              tells them apart, without repeating it in the visible row. */}
          {worktreeName !== undefined && <span className="sr-only"> in {worktreeName}</span>}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={joinLine === null ? "w-40" : "w-80"}>
          {joinLine === null ? null : (
            <p className="px-2 pt-1.5 pb-2 text-[12px] leading-relaxed text-ink-2">{joinLine}</p>
          )}
          {WORKTREE_HARNESSES.map((harness) => (
            <DropdownMenuItem
              key={harness}
              disabled={pending}
              onClick={() => start(harness)}
              className="font-mono text-[12.5px]"
            >
              {harness}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
