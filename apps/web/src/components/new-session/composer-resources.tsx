import { WorktreeId } from "@mend/domain";
import { choicesFor, type WorktreeChoice } from "@mend/domain/workbench";
import { Segmented } from "@mend/ui/components/segmented";
import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  choiceInUse,
  choiceWords,
  chooseResource,
  resourcesQuery,
  type ResourceSettingView,
} from "#/lib/resources";
import { settleChoice } from "#/lib/resources-card";
import { choiceOptions } from "#/lib/resources-model";
import { useTRPC } from "#/lib/trpc";

/** The project resources a worktree chooses how to use: those with a choice to make. */
const chosenHere = (settings: ReadonlyArray<ResourceSettingView>) =>
  settings.filter((entry) => choicesFor(entry.spec).length > 0);

/** `@db own database`, `@redis project`: what the worktree uses, in database words for Postgres. */
const usedWords = (entry: ResourceSettingView): string =>
  `@${entry.spec.name} ${choiceWords(entry.spec, choiceInUse(entry).choice).label}`;

/**
 * The New session composer's resource line (ADR 0019, story 4), for a session starting in a
 * worktree that already exists: what that worktree uses of each project resource, such as
 * `Resources · @db own database · @redis project`. Whoever owns the worktree's change gets
 * "change", which opens the same Shared · Own · Off choice as the Resources tab; a switch restarts
 * the worktree's Services. A project with no resources, or a new worktree, shows nothing.
 */
export function ComposerResources({
  projectId,
  worktreeId,
  touch = false,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly touch?: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const options = resourcesQuery(trpc, projectId, WorktreeId.make(worktreeId));
  const read = useQuery(options);
  const choose = useMutation({
    mutationFn: async ({
      name,
      mode,
    }: {
      readonly name: string;
      readonly mode: WorktreeChoice;
    }) => {
      const outcome = await chooseResource(projectId, WorktreeId.make(worktreeId), name, mode);
      if (!outcome.ok) throw new Error(outcome.message);
      return settleChoice(queryClient, options.queryKey, outcome.result);
    },
  });
  // The line is extra: while it reads, or if it can't, the composer goes on without it.
  if (read.isPending || read.isError) return null;
  const entries = chosenHere(read.data.settings);
  if (entries.length === 0) return null;
  const mayChange = entries.some((entry) => entry.canChoose);

  return (
    <div
      data-slot="composer-resources"
      className={cn(
        "flex flex-col gap-2 text-row text-muted-foreground",
        touch ? "px-5 pb-3" : "px-4 py-2.5",
      )}
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span>Resources</span>
        <span className="font-mono text-meta text-foreground">
          {entries.map(usedWords).join(" · ")}
        </span>
        {mayChange ? (
          <Button
            variant="link"
            size="sm"
            aria-expanded={open}
            className="h-auto p-0 text-row"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? "done" : "change"}
          </Button>
        ) : null}
      </p>
      {open && mayChange
        ? entries.map((entry) => (
            <div key={entry.id} className="flex flex-wrap items-center gap-3">
              <span className="w-20 font-mono text-meta text-foreground">@{entry.spec.name}</span>
              <Segmented
                aria-label={`How this worktree uses @${entry.spec.name}`}
                size={touch ? "touch" : "default"}
                value={choiceInUse(entry).choice}
                disabled={!entry.canChoose || choose.isPending}
                options={choiceOptions(entry.spec)}
                onValueChange={(mode) => choose.mutate({ name: entry.spec.name, mode })}
              />
            </div>
          ))
        : null}
      {choose.isError ? (
        <p role="alert" className="text-row text-destructive">
          The worktree kept its choice: {choose.error.message}
        </p>
      ) : null}
    </div>
  );
}
