import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { removeWorktree } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import type { WorktreeRow } from "#/lib/project-worktrees";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import {
  explainRefusal,
  forcedRemovalFailureOf,
  type RefusalContext,
  removalRefusalOf,
  removedWords,
  type UnlandedFacts,
  type WorktreeRemovalRefusal,
} from "#/lib/worktree-removal";

import { Overlay } from "../projects/overlay.tsx";

/** What the dialogs need to word a refusal, beyond the row. */
export type RemovalWords = Omit<RefusalContext, "worktreeName">;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One line of the confirmation's list: what goes with the worktree. */
function GoesWith({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b py-2.5 last:border-b-0">
      <dt className="shrink-0">{label}</dt>
      <dd className="min-w-0 truncate text-right text-muted-foreground">{value}</dd>
    </div>
  );
}

/** "3 files, +40 −12", read once the dialog opens. */
function ChangeSize({ changeId }: { readonly changeId: string | null }) {
  const trpc = useTRPC();
  const stats = useQuery({
    ...trpc.changes.stats.queryOptions({ id: changeId ?? "" }),
    enabled: changeId !== null,
  });
  const value =
    changeId === null
      ? "No changes"
      : stats.isPending
        ? "…"
        : stats.isError
          ? "Couldn't be read"
          : stats.data.files === 0
            ? "No changes"
            : `${plural(stats.data.files, "file", "files")}, +${stats.data.additions} −${stats.data.deletions}`;
  return <GoesWith label="Its change" value={value} />;
}

function Checkpoints({ worktreeId }: { readonly worktreeId: string }) {
  const trpc = useTRPC();
  const detail = useQuery(trpc.worktrees.detail.queryOptions({ id: worktreeId }));
  const value = detail.isPending
    ? "…"
    : detail.isError
      ? "Couldn't be read"
      : String(detail.data.checkpoints.length);
  return <GoesWith label="Its checkpoints" value={value} />;
}

/** The files not on origin: the total first, then each named file, then how many more. */
function NotOnOrigin({ facts }: { readonly facts: UnlandedFacts }) {
  return (
    <ul aria-label="Not on origin" className="divide-y rounded-lg border font-mono text-meta">
      <li className="flex items-baseline justify-between gap-4 px-3 py-2">
        <span>{plural(facts.files, "file", "files")}</span>
        <Lines additions={facts.additions} deletions={facts.deletions} />
      </li>
      {facts.named.map((file) => (
        <li key={file.path} className="flex items-baseline justify-between gap-4 px-3 py-2">
          <span className="min-w-0 truncate" title={file.path}>
            {file.path}
          </span>
          <Lines additions={file.additions} deletions={file.deletions} />
        </li>
      ))}
      {facts.more === 0 ? null : (
        <li className="px-3 py-2 text-muted-foreground">
          {plural(facts.more, "more file", "more files")}
        </li>
      )}
    </ul>
  );
}

function Lines({
  additions,
  deletions,
}: {
  readonly additions: number;
  readonly deletions: number;
}) {
  return (
    <span
      aria-label={`${additions} lines added, ${deletions} removed`}
      className="shrink-0 tabular-nums"
    >
      <span className="text-success">+{additions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  );
}

/** What Remove anyway takes with it, said before it is pressed. */
const anywayWords = (sessions: number): string =>
  sessions === 0
    ? "Remove anyway discards this change. Its checkpoints and its review go with it."
    : sessions === 1
      ? "Remove anyway discards this change. The session, its checkpoints and its review go with it."
      : `Remove anyway discards this change. Its ${sessions} sessions, their checkpoints and the review go with it.`;

/**
 * Remove worktree… (Doop "Project · Worktrees · remove", "can't remove" and its siblings). It asks
 * first, listing what goes with the worktree. A refusal turns the dialog into "Not removed": the
 * worktree is still here, why in plain words, the files not on origin, and "Remove anyway" only
 * when the server says force would lift every reason. Removing says so in a toast.
 */
export function RemoveWorktree({
  row,
  words,
  onClose,
}: {
  /** The worktree to remove, or null while nothing is being removed. */
  readonly row: WorktreeRow | null;
  readonly words: RemovalWords;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [refusal, setRefusal] = useState<WorktreeRemovalRefusal | null>(null);
  // The last row stays while the dialog closes, so its words don't blank out as it fades.
  const [last, setLast] = useState(row);
  if (row !== null && row !== last) setLast(row);
  const shown = row ?? last;
  const remove = useMutation({
    mutationFn: ({ id, force }: { readonly id: string; readonly force: boolean }) =>
      removeWorktree(id, force),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.projects.pathFilter()),
        queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
        queryClient.invalidateQueries(trpc.sessions.pathFilter()),
      ]),
  });
  const size = phone ? "touch" : "default";
  if (shown === null) return null;

  const close = () => {
    if (remove.isPending) return;
    setRefusal(null);
    remove.reset();
    onClose();
  };
  const run = (force: boolean) =>
    remove.mutate(
      { id: shown.worktree.id, force },
      {
        onSuccess: () => {
          const discarded =
            force &&
            (refusal?.blockers.some(
              (blocker) => blocker._tag === "Unlanded" || blocker._tag === "NestedRepositories",
            ) ??
              false);
          toast.add({ description: removedWords(shown.name, shown.sessions.length, discarded) });
          close();
        },
        // A refusal turns the dialog into "Not removed". Any other failure of the first removal
        // stays on the confirmation, said there: nothing says force would help.
        onError: (cause) => {
          const next = force ? forcedRemovalFailureOf(cause) : removalRefusalOf(cause);
          if (next !== null) setRefusal(next);
        },
      },
    );

  if (refusal !== null) {
    const explained = explainRefusal(refusal, { ...words, worktreeName: shown.name });
    return (
      <Overlay
        open={row !== null}
        onOpenChange={(open) => {
          if (!open) close();
        }}
        title="Not removed"
        description={explained.lead}
        size="md"
        footer={
          <>
            <Button variant="secondary" size={size} disabled={remove.isPending} onClick={close}>
              Keep worktree
            </Button>
            {refusal.forceable ? (
              <Button
                variant="destructive"
                size={size}
                disabled={remove.isPending}
                onClick={() => run(true)}
              >
                {remove.isPending ? "Removing…" : "Remove anyway"}
              </Button>
            ) : null}
          </>
        }
      >
        {explained.reasons.map((reason) => (
          <InlineAlert
            key={`${reason.title}${reason.body}`}
            tone={reason.tone}
            size={size}
            {...(reason.title === "" ? {} : { title: reason.title })}
          >
            {reason.body}
          </InlineAlert>
        ))}
        {refusal.unlanded === null ? null : <NotOnOrigin facts={refusal.unlanded} />}
        {refusal.forceable ? (
          <p className="text-muted-foreground">{anywayWords(shown.sessions.length)}</p>
        ) : null}
      </Overlay>
    );
  }

  const [only] = shown.sessions;
  return (
    <Overlay
      open={row !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={`Remove ${shown.name}?`}
      description={
        words.remote === null
          ? "Mend removes the worktree and everything in it, and this can't be undone."
          : `Mend removes the worktree and everything in it. Nothing on ${words.remote} changes, and this can't be undone.`
      }
      size="md"
      footer={
        <>
          <Button variant="secondary" size={size} disabled={remove.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={remove.isPending}
            onClick={() => run(false)}
          >
            {remove.isPending ? "Removing…" : "Remove worktree"}
          </Button>
        </>
      }
    >
      <dl className="border-y">
        <GoesWith
          label={shown.sessions.length === 1 ? "Its session" : "Its sessions"}
          value={
            shown.sessions.length === 0
              ? "None"
              : only !== undefined && shown.sessions.length === 1
                ? only.title
                : plural(shown.sessions.length, "session", "sessions")
          }
        />
        <Checkpoints worktreeId={shown.worktree.id} />
        <ChangeSize changeId={shown.changeId} />
      </dl>
      {remove.isError ? (
        <InlineAlert size={size}>
          {failureWords(remove.error, "The worktree wasn't removed. Try again.")}
        </InlineAlert>
      ) : null}
    </Overlay>
  );
}
