import type { RemovedProject } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mend/ui/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon } from "lucide-react";
import { useId, useState } from "react";

import type { OrganizationMemberDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "./overlay.tsx";

const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * Removed projects, folded under the list: each can be restored, under its old name or a new one
 * when that name was taken since, or purged for good once its name is typed. Who may do either is
 * the server's to say (`rights`): an owner for a shared project, its creator for a private one.
 * Nothing shows until something has been removed.
 */
export function RemovedProjects({
  organizationName,
  members,
  onRestored,
}: {
  readonly organizationName: string;
  readonly members: ReadonlyArray<OrganizationMemberDto>;
  readonly onRestored: (name: string) => void;
}) {
  const trpc = useTRPC();
  const removed = useQuery(trpc.projects.removed.queryOptions());
  if (removed.isPending || (removed.isSuccess && removed.data.length === 0)) return null;
  if (removed.isError)
    return (
      <p role="alert" className="mt-6 flex items-center gap-2 text-row text-muted-foreground">
        Removed projects couldn't be read.
        <Button variant="link" onClick={() => void removed.refetch()}>
          Try again
        </Button>
      </p>
    );
  return (
    <Collapsible className="mt-6">
      <CollapsibleTrigger
        className={cn(
          "group flex min-h-8 items-center gap-1.5 rounded-md text-row font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11",
        )}
      >
        <ChevronRightIcon
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        Removed projects
        <span className="font-normal text-muted-foreground">{removed.data.length}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="pt-1 pb-2 text-row text-muted-foreground">
          Mend keeps a removed project until someone purges it.
        </p>
        <ul aria-label="Removed projects" className="border-t">
          {removed.data.map((project) => (
            <RemovedProjectRow
              key={project.id}
              project={project}
              organizationName={organizationName}
              removedBy={
                members.find((member) => member.userId === project.removedByUserId)?.name ?? null
              }
              onRestored={onRestored}
            />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * One removed project in a list: when and by whom, Restore (asking for a new name when its old one
 * was taken since) and Purge… with its typed confirmation. A removed project's settings page shows
 * the same row.
 */
export function RemovedProjectRow({
  project,
  organizationName,
  removedBy,
  onRestored,
}: {
  readonly project: RemovedProject;
  readonly organizationName: string;
  readonly removedBy: string | null;
  readonly onRestored: (name: string) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.projects.removed.queryKey() }),
    ]);
  const restore = useMutation(trpc.projects.restore.mutationOptions({ onSuccess: refresh }));
  // A purge that fails has still begun (restore is refused from then on): read both lists again.
  const purge = useMutation(trpc.projects.purge.mutationOptions({ onSettled: refresh }));
  // The name was taken since: restore asks for another.
  const conflict = restore.isError && refusalTagOf(restore.error) === "ProjectNameConflict";
  const [newName, setNewName] = useState(project.name);
  const [purging, setPurging] = useState(false);
  const [confirm, setConfirm] = useState("");
  const size = phone ? "touch" : "sm";
  const stopped = project.state !== "removed";
  const canAct = project.rights.restore || project.rights.purge;
  return (
    <li className="flex flex-col gap-2 border-b py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{project.name}</p>
          <p className="text-meta text-muted-foreground">
            {stopped
              ? "A purge stopped partway. Purge it again to finish."
              : `Removed ${DAY.format(project.removedAt)}${removedBy === null ? "" : ` by ${removedBy}`}`}
          </p>
        </div>
        {canAct ? (
          <div className="flex gap-2 max-sm:w-full max-sm:*:flex-1">
            {project.rights.restore && !stopped && !conflict ? (
              <Button
                variant="secondary"
                size={size}
                disabled={restore.isPending || purge.isPending}
                onClick={() =>
                  restore.mutate(
                    { id: project.id },
                    { onSuccess: (restored) => onRestored(restored.name) },
                  )
                }
              >
                {restore.isPending ? "Restoring…" : "Restore"}
              </Button>
            ) : null}
            {project.rights.purge ? (
              <Button
                variant="destructive"
                size={size}
                disabled={restore.isPending || purge.isPending}
                onClick={() => {
                  setConfirm("");
                  purge.reset();
                  setPurging(true);
                }}
              >
                Purge…
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-meta text-muted-foreground">
            An owner of {organizationName} can restore or purge it.
          </p>
        )}
      </div>
      {conflict ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            restore.mutate(
              { id: project.id, name: newName.trim() },
              { onSuccess: (restored) => onRestored(restored.name) },
            );
          }}
        >
          <Field data-invalid className="min-w-0 max-w-96 flex-1 basis-60">
            <FieldLabel htmlFor={`${ids}-name`}>Restore as</FieldLabel>
            <Input
              id={`${ids}-name`}
              value={newName}
              aria-invalid
              className={cn(phone && "h-11")}
              onChange={(event) => setNewName(event.target.value)}
            />
            <FieldError>{failureWords(restore.error, "That name is taken.")}</FieldError>
          </Field>
          <Button type="submit" size={size} disabled={restore.isPending || newName.trim() === ""}>
            {restore.isPending ? "Restoring…" : "Restore"}
          </Button>
        </form>
      ) : restore.isError ? (
        <InlineAlert size={phone ? "touch" : "default"} title={`${project.name} wasn't restored.`}>
          {failureWords(restore.error, "Mend didn't answer. Try again.")}
        </InlineAlert>
      ) : null}
      <Overlay
        open={purging}
        onOpenChange={(open) => {
          if (!purge.isPending) setPurging(open);
        }}
        title={`Purge ${project.name}?`}
        description="Mend deletes its repository copy, sessions, reviews, settings, secrets and resource data for good. You can't undo this."
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              size={phone ? "touch" : "default"}
              disabled={purge.isPending}
              onClick={() => setPurging(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size={phone ? "touch" : "default"}
              disabled={confirm !== project.name || purge.isPending}
              onClick={() =>
                purge.mutate({ id: project.id, confirm }, { onSuccess: () => setPurging(false) })
              }
            >
              {purge.isPending ? "Purging…" : "Purge project"}
            </Button>
          </>
        }
      >
        <Field>
          <FieldLabel htmlFor={`${ids}-confirm`}>
            Type <span className="font-mono">{project.name}</span> to confirm
          </FieldLabel>
          <Input
            id={`${ids}-confirm`}
            value={confirm}
            autoComplete="off"
            spellCheck={false}
            className={cn("font-mono", phone && "h-11")}
            disabled={purge.isPending}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </Field>
        {purge.isError ? (
          <InlineAlert size={phone ? "touch" : "default"} title={`${project.name} wasn't purged.`}>
            {failureWords(purge.error, "Mend didn't answer. Try again.")}
          </InlineAlert>
        ) : null}
      </Overlay>
    </li>
  );
}
