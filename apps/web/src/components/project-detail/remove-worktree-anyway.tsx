import type { WorktreeRemovalRefusal } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mend/ui/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { removeWorktree, type WorktreeDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";
import { removalRefusalOf } from "#/lib/worktree-removal";

/**
 * The second step after the store refused a worktree removal (docs/adr/0007-landing.md,
 * "Worktree removal"). The ordinary removal already happened and was refused in words; this shows
 * those words verbatim, lays out what the change holds, and only then offers "Remove anyway", the
 * same endpoint with `force=true`. A refusal force does not lift, a capture still saving, shows
 * its words and offers nothing.
 */

/** A removal the store refused, with the worktree it named. */
export interface RefusedRemoval {
  readonly worktree: WorktreeDto;
  /** What the page calls the worktree. */
  readonly name: string;
  readonly sessions: number;
  readonly refusal: WorktreeRemovalRefusal;
}

export interface RemoveWorktreeAnywayBodyProps {
  readonly refused: RefusedRemoval;
  readonly pending: boolean;
  readonly onKeep: () => void;
  readonly onRemoveAnyway: () => void;
}

/** What goes with the worktree, in the menu's own words. */
const goesWithIt = (sessions: number): string =>
  sessions === 0
    ? "The change and its checkpoints go with it."
    : `${sessions} session${sessions === 1 ? "" : "s"}, the change and its review go with it.`;

/** The server's words, what they name, and the one consequential action. Pure: the page owns state. */
export function RemoveWorktreeAnywayBody({
  refused,
  pending,
  onKeep,
  onRemoveAnyway,
}: RemoveWorktreeAnywayBodyProps) {
  const { refusal, sessions } = refused;
  const facts = refusal.unlanded;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p
        role="alert"
        className="border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-ink-2 break-words"
      >
        {refusal.words}
      </p>
      {facts !== null && (
        <ul
          aria-label="Not on origin"
          className="divide-y divide-rule-faint rounded-lg border border-rule-faint font-mono text-[12px]"
        >
          <li className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-ink-2">
            <span>
              {facts.files} file{facts.files === 1 ? "" : "s"}
            </span>
            <span className="shrink-0">
              <span className="text-success">+{facts.additions}</span>{" "}
              <span className="text-danger">−{facts.deletions}</span>
            </span>
          </li>
          {facts.named.map((file) => (
            <li
              key={file.path}
              className="flex items-baseline justify-between gap-4 px-3 py-1.5 text-ink-2"
            >
              <span className="min-w-0 truncate" title={file.path}>
                {file.path}
              </span>
              <span className="shrink-0 text-faint">
                +{file.additions} −{file.deletions}
              </span>
            </li>
          ))}
          {facts.more > 0 && (
            <li className="px-3 py-1.5 text-faint">
              {facts.more} more file{facts.more === 1 ? "" : "s"}
            </li>
          )}
        </ul>
      )}
      {refusal.forceable && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Remove anyway discards this change. {goesWithIt(sessions)}
        </p>
      )}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" disabled={pending} onClick={onKeep}>
          Keep worktree
        </Button>
        {refusal.forceable && (
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onRemoveAnyway}
            className="min-w-32"
          >
            {pending ? "Removing…" : "Remove anyway"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The dialog around the body. Open while `refused` is set; the page clears it on keep, and
 * `onRemoved` once the forced removal went through. A second refusal replaces the first.
 */
export function RemoveWorktreeAnywayDialog({
  refused,
  onKeep,
  onRemoved,
}: {
  readonly refused: RefusedRemoval | null;
  readonly onKeep: () => void;
  readonly onRemoved: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const [again, setAgain] = useState<RefusedRemoval | null>(null);
  // A later refusal of the same worktree stands in for the page's; another worktree resets it.
  const shown =
    refused === null ? null : again?.worktree.id === refused.worktree.id ? again : refused;

  const keep = () => {
    if (pending) return;
    setAgain(null);
    onKeep();
  };

  const removeAnyway = () => {
    if (shown === null || pending || !shown.refusal.forceable) return;
    setPending(true);
    void removeWorktree(shown.worktree.id, true)
      .then(async () => {
        await Promise.all([
          queryClient.invalidateQueries(trpc.projects.pathFilter()),
          queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
          queryClient.invalidateQueries(trpc.sessions.pathFilter()),
        ]);
        setPending(false);
        setAgain(null);
        onRemoved();
        return null;
      })
      .catch((cause: unknown) => {
        setPending(false);
        const refusal = removalRefusalOf(cause);
        setAgain(
          refusal === null
            ? {
                ...shown,
                refusal: {
                  words: "The worktree was not removed. Try again.",
                  forceable: true,
                  unlanded: shown.refusal.unlanded,
                },
              }
            : { ...shown, refusal },
        );
      });
  };

  return (
    <Dialog
      open={shown !== null}
      disablePointerDismissal={pending}
      onOpenChange={(next) => {
        if (!next) keep();
      }}
    >
      {shown !== null && (
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Not removed</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-[12.5px]">{shown.name}</span> stays in the store.
            </DialogDescription>
          </DialogHeader>
          <RemoveWorktreeAnywayBody
            refused={shown}
            pending={pending}
            onKeep={keep}
            onRemoveAnyway={removeAnyway}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
