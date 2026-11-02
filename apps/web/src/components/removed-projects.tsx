import { Collapsible } from "@base-ui/react/collapsible";
import type { RemovedProject } from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button, focusRing } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { Icon } from "#/components/kit/icons";
import { ModalDialog } from "#/components/kit/modal";
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
    <li className="px-4 py-3.5 [&+&]:border-t [&+&]:border-rule-faint">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-sans text-[13.5px] font-medium">{project.name}</h3>
          <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
            {project.visibility} · removed {project.removedAt.toLocaleDateString()} · {project.id}
          </p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {project.state === "removed"
              ? "Files and history are kept. Restore starts nothing."
              : "Deletion stopped or is in progress. Purge again to finish."}
          </p>
        </div>
        {(project.rights.restore || project.rights.purge) && (
          <div className="flex flex-wrap items-center gap-2">
            {project.rights.restore && (
              <>
                <label className="sr-only" htmlFor={`restore-name-${project.id}`}>
                  Name on Restore
                </label>
                <TextInput
                  id={`restore-name-${project.id}`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-44 py-1.5"
                  disabled={pending}
                />
                <Button
                  size="sm"
                  onClick={() => void act(() => restore(name))}
                  disabled={pending || name.length === 0}
                >
                  {pending && !open ? "Restoring…" : "Restore"}
                </Button>
              </>
            )}
            {project.rights.purge && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirm("");
                  setOpen(true);
                }}
                disabled={pending}
              >
                Purge…
              </Button>
            )}
          </div>
        )}
      </div>
      {!project.rights.restore && !project.rights.purge && (
        <p className="mt-1 text-[12.5px] text-muted-foreground">
          An organization owner can restore or purge this project.
        </p>
      )}
      {error !== null && !open && (
        <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger">
          {error}
        </p>
      )}
      <ModalDialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
        title={`Purge ${project.name}?`}
        description="Deletes its files, sessions, reviews, settings and secrets for good. This cannot be undone. Instance audit and backups are unchanged."
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={confirm !== project.name || pending}
              onClick={() => void act(() => purge(confirm))}
            >
              {pending ? "Purging…" : "Purge"}
            </Button>
          </>
        }
      >
        <Field label={`Type ${project.name} to confirm`}>
          {(id) => (
            <TextInput
              id={id}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="off"
              disabled={pending}
            />
          )}
        </Field>
        {error !== null && (
          <p role="alert" className="font-mono text-[11.5px] text-danger">
            {error}
          </p>
        )}
      </ModalDialog>
    </li>
  );
}

/**
 * Removed projects, folded under the Projects table (`.fold`). Kept until someone purges them;
 * restore brings one back under the name you give it.
 */
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
  // A failed purge has still begun (Restore is refused from then on): re-read either way.
  const restore = useMutation(trpc.projects.restore.mutationOptions({ onSettled: refresh }));
  const purge = useMutation(trpc.projects.purge.mutationOptions({ onSettled: refresh }));
  return (
    <Collapsible.Root className="mt-4">
      <Collapsible.Trigger
        className={cn(
          "group flex items-center gap-1.5 rounded-[10px] px-2.5 py-[9px] font-sans text-[13px] font-medium text-ink-2 hover:text-foreground",
          focusRing,
        )}
      >
        <Icon
          name="chevronRight"
          size={13}
          className="transition-transform motion-reduce:transition-none group-data-[panel-open]:rotate-90"
        />
        Removed projects
        <span className="font-mono text-[11px] font-normal text-faint">
          {rows.data === undefined ? "" : rows.data.length}
        </span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="mt-1">
        <p className="px-2.5 pb-2 text-[12.5px] text-muted-foreground">
          Kept until you explicitly purge them.
        </p>
        {rows.isPending && (
          <p role="status" className="px-2.5 font-mono text-[12px] text-muted-foreground">
            Reading removed projects…
          </p>
        )}
        {rows.error !== null && (
          <p role="alert" className="px-2.5 font-mono text-[12px] text-danger">
            {failureWords(rows.error, "Removed projects could not be read.")}
          </p>
        )}
        {rows.data?.length === 0 && (
          <p className="px-2.5 font-mono text-[12px] text-faint">No removed projects.</p>
        )}
        {rows.data !== undefined && rows.data.length > 0 ? (
          <ul aria-label="Removed projects" className="rounded-[22px] bg-panel p-1.5 shadow-sm">
            {rows.data.map((project) => (
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
          </ul>
        ) : null}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
