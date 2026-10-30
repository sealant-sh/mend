import type { RemovedProject } from "@mend/domain/workbench";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@mend/ui/components/ui/dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

export function RemovedProjectRow({
  project,
  restore,
  purge,
}: {
  readonly project: RemovedProject;
  readonly restore: (name?: string) => Promise<void>;
  readonly purge: (confirm: string) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [confirm, setConfirm] = useState("");
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (operation: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await operation();
      setOpen(false);
    } catch (cause) {
      setError(failureWords(cause, "The request did not finish. Try again."));
    } finally {
      setPending(false);
    }
  };
  return (
    <article className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="font-sans text-sm font-medium">{project.name}</h3>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {project.visibility} · removed {project.removedAt.toLocaleDateString()} · {project.id}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {project.state === "removed"
              ? "Files and history are kept. Restore starts nothing."
              : "Deletion stopped or is in progress. Purge again to finish."}
          </p>
        </div>
        {(project.rights.restore || project.rights.purge) && (
          <div className="flex flex-wrap items-center gap-3">
            {project.rights.restore && (
              <>
                <label className="sr-only" htmlFor={`restore-name-${project.id}`}>
                  Name on Restore
                </label>
                <input
                  id={`restore-name-${project.id}`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="rounded-lg border border-input bg-background px-3 py-2 text-sm"
                  disabled={pending}
                />
                <button
                  type="button"
                  onClick={() => void act(() => restore(name))}
                  disabled={pending || name.length === 0}
                  className="rounded-xl bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
                >
                  Restore
                </button>
              </>
            )}
            {project.rights.purge && (
              <button
                type="button"
                onClick={() => {
                  setConfirm("");
                  setOpen(true);
                }}
                disabled={pending}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Purge…
              </button>
            )}
          </div>
        )}
      </div>
      {!project.rights.restore && !project.rights.purge && (
        <p className="mt-2 text-sm text-muted-foreground">
          An organization owner can restore or purge this project.
        </p>
      )}
      {error !== null && !open && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogContent>
          <DialogTitle>Purge {project.name}?</DialogTitle>
          <DialogDescription>
            Deletes its files, sessions, reviews, settings and secrets for good. This cannot be
            undone. Instance audit and backups are unchanged.
          </DialogDescription>
          <label htmlFor={`purge-name-${project.id}`} className="text-sm">
            Type {project.name} to confirm
          </label>
          <input
            id={`purge-name-${project.id}`}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="off"
            className="rounded-lg border border-input bg-background px-3 py-2"
            disabled={pending}
          />
          {error !== null && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </button>
            <button
              type="button"
              disabled={confirm !== project.name || pending}
              onClick={() => void act(() => purge(confirm))}
              className="rounded-xl bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            >
              {pending ? "Purging…" : "Purge"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}

export function RemovedProjects() {
  const trpc = useTRPC();
  const client = useQueryClient();
  const rows = useQuery(trpc.projects.removed.queryOptions());
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries(trpc.projects.list.queryFilter()),
      client.invalidateQueries(trpc.projects.removed.queryFilter()),
    ]);
  };
  const restore = useMutation(trpc.projects.restore.mutationOptions({ onSuccess: refresh }));
  const purge = useMutation(trpc.projects.purge.mutationOptions({ onSuccess: refresh }));
  return (
    <details className="mt-10 rounded-2xl bg-card px-5 py-4 shadow-sm">
      <summary className="cursor-pointer text-sm font-medium">
        Removed projects{rows.data === undefined ? "" : ` · ${rows.data.length}`}
      </summary>
      <p className="mt-4 text-sm text-muted-foreground">
        Kept indefinitely until you explicitly purge them.
      </p>
      {rows.isPending && <p className="mt-4 text-sm">Loading removed projects…</p>}
      {rows.error !== null && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {failureWords(rows.error, "Removed projects could not be read.")}
        </p>
      )}
      {rows.data?.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No removed projects.</p>
      )}
      <div className="divide-y divide-border">
        {rows.data?.map((project) => (
          <RemovedProjectRow
            key={project.id}
            project={project}
            restore={async (name) => {
              await restore.mutateAsync({
                id: project.id,
                ...(name === undefined ? {} : { name }),
              });
            }}
            purge={async (confirm) => {
              await purge.mutateAsync({ id: project.id, confirm });
            }}
          />
        ))}
      </div>
    </details>
  );
}
