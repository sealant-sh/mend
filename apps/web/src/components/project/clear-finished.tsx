import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { removeWorktree } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import type { WorktreeRow } from "#/lib/project-worktrees";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import {
  clearedWords,
  keptBecause,
  type KeptWorktree,
  removalRefusalOf,
} from "#/lib/worktree-removal";

import { Overlay } from "../projects/overlay.tsx";
import type { RemovalWords } from "./remove-worktree.tsx";

/**
 * Clear finished… (Doop "Project · Worktrees · clear finished", "cleared"): removes, one at a
 * time, every worktree where no session is running or saving. It never forces, so a worktree
 * whose change isn't landed stays, and the toast names what stayed and why.
 */
export function ClearFinished({
  finished,
  wordsFor,
  open,
  onOpenChange,
}: {
  readonly finished: ReadonlyArray<WorktreeRow>;
  readonly wordsFor: (row: WorktreeRow) => RemovalWords;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const clear = useMutation({
    mutationFn: async (rows: ReadonlyArray<WorktreeRow>) => {
      const kept: Array<KeptWorktree> = [];
      let removed = 0;
      for (const row of rows) {
        try {
          // One at a time: each removal locks the project's worktrees while it checks them.
          // oxlint-disable-next-line no-await-in-loop -- removals of one project run in turn
          await removeWorktree(row.worktree.id);
          removed += 1;
        } catch (cause) {
          const refusal = removalRefusalOf(cause);
          kept.push({
            name: row.name,
            because: refusal === null ? null : keptBecause(refusal, wordsFor(row)),
          });
        }
      }
      return { removed, kept };
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.projects.pathFilter()),
        queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
        queryClient.invalidateQueries(trpc.sessions.pathFilter()),
      ]),
  });
  const size = phone ? "touch" : "default";
  const close = () => {
    if (clear.isPending) return;
    clear.reset();
    onOpenChange(false);
  };

  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      title="Clear finished worktrees?"
      description="Mend removes the worktrees where no session is running or saving, and those with no sessions. Each one's sessions, checkpoints and change go with it."
      size="md"
      footer={
        <>
          <Button variant="secondary" size={size} disabled={clear.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={clear.isPending || finished.length === 0}
            onClick={() =>
              clear.mutate(finished, {
                onSuccess: ({ removed, kept }) => {
                  toast.add({ description: clearedWords(removed, kept) });
                  clear.reset();
                  onOpenChange(false);
                },
              })
            }
          >
            {clear.isPending ? "Clearing…" : "Clear finished worktrees"}
          </Button>
        </>
      }
    >
      <ul aria-label="Finished worktrees" className="border-y">
        {finished.map((row) => (
          <li
            key={row.worktree.id}
            className="flex items-baseline justify-between gap-6 border-b py-2.5 last:border-b-0"
          >
            <span className="min-w-0 truncate font-mono text-meta">{row.name}</span>
            <span className="shrink-0 text-muted-foreground">
              {row.sessions.length === 0 ? "No sessions yet" : row.change.words}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        A worktree whose change was never landed stays, so no work is lost. You can remove it from
        its own menu.
      </p>
      {clear.isError ? (
        <InlineAlert size={size}>
          {failureWords(clear.error, "Mend couldn't clear the worktrees. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}
