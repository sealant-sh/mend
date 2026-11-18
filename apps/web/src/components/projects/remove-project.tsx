import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ProjectDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { projectRemovalFailureOf } from "#/lib/project-removal";
import { repositoryWords } from "#/lib/projects";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "./overlay.tsx";

/**
 * Remove project… (Doop "Project · remove ledger?", "Phone · Remove project sheet"). Asks first,
 * and says what Mend keeps: removing takes the project out of the list but deletes nothing, so it
 * can be restored or purged from Removed projects. A refusal (a session still running in it, a
 * change not on its origin) says why, and nothing changes.
 */
export function RemoveProject({
  project,
  onOpenChange,
  onRemoved,
}: {
  /** The project to remove, or null while nothing is being removed. */
  readonly project: ProjectDto | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemoved: (project: ProjectDto) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const remove = useMutation(
    trpc.projects.remove.mutationOptions({
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: trpc.projects.list.queryKey() }),
          queryClient.invalidateQueries({ queryKey: trpc.projects.removed.queryKey() }),
        ]);
      },
    }),
  );
  const failure = remove.isError ? projectRemovalFailureOf(remove.error) : null;
  const size = phone ? "touch" : "default";
  // The last project stays while the dialog closes, so its words don't blank out as it fades.
  const [last, setLast] = useState(project);
  if (project !== null && project !== last) setLast(project);
  const shown = project ?? last;
  const name = shown?.name ?? "";
  return (
    <Overlay
      open={project !== null}
      onOpenChange={(open) => {
        if (remove.isPending) return;
        if (!open) remove.reset();
        onOpenChange(open);
      }}
      title={`Remove ${name}?`}
      description={
        shown === null
          ? undefined
          : shown.originUrl === null
            ? `${name} leaves the Projects list. Mend keeps its repository, its sessions' history and its resource data, so you can restore it from Removed projects.`
            : `${name} leaves the Projects list. Mend keeps its copy of ${repositoryWords(shown)}, its sessions' history and its resource data, so you can restore it from Removed projects. The repository on the Git host doesn't change.`
      }
      size="sm"
      footer={
        <>
          <Button
            variant="secondary"
            size={size}
            disabled={remove.isPending}
            onClick={() => {
              remove.reset();
              onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size={size}
            disabled={remove.isPending || project === null}
            onClick={() => {
              if (project === null) return;
              remove.mutate(
                { id: project.id },
                {
                  onSuccess: () => {
                    onRemoved(project);
                    remove.reset();
                  },
                },
              );
            }}
          >
            {remove.isPending ? "Removing…" : "Remove project"}
          </Button>
        </>
      }
    >
      {failure === null ? null : (
        // Mend's words already say it wasn't removed, and why.
        <InlineAlert size={size}>{failure.words}</InlineAlert>
      )}
    </Overlay>
  );
}
