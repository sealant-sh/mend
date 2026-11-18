import { WORKTREE_NAME_PATTERN } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@mend/ui/components/ui/autocomplete";
import { Button } from "@mend/ui/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { createWorktree, type ProjectDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";

/** Keep the name inside the worktree name's alphabet while it is typed. */
export const normalizeWorktreeName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64);

/** A refused create, in words, by which refusal it was. */
const createFailure = (cause: unknown): string => {
  const tag = refusalTagOf(cause);
  if (tag === "WorktreeNameTaken")
    return "That name is already used in this project. Choose another.";
  if (tag === "NotFound") return "This project is no longer in Mend.";
  return failureWords(cause, "The worktree wasn't created. Try again.");
};

/**
 * New worktree… (Doop "Project · Worktrees · new worktree", "Phone · … new worktree"): an
 * optional name and the commit it starts from, which suggests the project's branches and takes
 * any branch, tag or commit typed whole. It closes once Mend has the worktree and the project has
 * been read again, and says so in a toast; a refusal stays in the dialog with what was typed.
 */
export function NewWorktree({
  project,
  open,
  onOpenChange,
}: {
  readonly project: ProjectDto;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const ids = useId();
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [nameProblem, setNameProblem] = useState<string | null>(null);
  const branches = useQuery({
    ...trpc.projects.branches.queryOptions({ id: project.id }),
    enabled: open,
  });
  const trimmed = name.trim();
  const create = useMutation({
    mutationFn: () =>
      createWorktree(project.id, {
        name: trimmed === "" ? null : trimmed,
        base: base.trim() === "" ? null : base.trim(),
      }),
    // Read the project again before closing, so the new worktree is in the list it returns to.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
        queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
      ]),
  });
  const close = () => {
    setName("");
    setBase("");
    setNameProblem(null);
    create.reset();
    onOpenChange(false);
  };
  const submit = () => {
    if (create.isPending) return;
    if (trimmed !== "" && !WORKTREE_NAME_PATTERN.test(trimmed)) {
      setNameProblem("Start with a lowercase letter or a digit.");
      return;
    }
    setNameProblem(null);
    create.mutate(undefined, {
      onSuccess: (worktree) => {
        close();
        toast.add({ description: `Created ${worktree.name} on ${worktree.branch}.` });
      },
    });
  };
  const size = phone ? "touch" : "default";
  const branchNames =
    branches.isPending || branches.isError ? [] : branches.data.map((branch) => branch.name);

  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (create.isPending) return;
        if (next) onOpenChange(true);
        else close();
      }}
      title="New worktree"
      description={`A worktree in ${project.name}, on a branch of its own. Sessions you start in it work on its change.`}
      size="md"
      footer={
        <>
          {phone ? null : (
            <Button variant="ghost" size={size} disabled={create.isPending} onClick={close}>
              Cancel
            </Button>
          )}
          <Button type="submit" form={`${ids}-form`} size={size} disabled={create.isPending}>
            {create.isPending ? "Creating…" : "Create worktree"}
          </Button>
        </>
      }
    >
      <form
        id={`${ids}-form`}
        className="flex flex-col gap-5"
        aria-busy={create.isPending || undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field data-invalid={nameProblem === null ? undefined : true}>
          <FieldLabel htmlFor={`${ids}-name`}>
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </FieldLabel>
          <Input
            id={`${ids}-name`}
            autoFocus
            value={name}
            disabled={create.isPending}
            placeholder="fix-auth"
            aria-invalid={nameProblem === null ? undefined : true}
            onChange={(event) => setName(normalizeWorktreeName(event.target.value))}
            className={cn("font-mono", phone && "h-11 text-lead")}
          />
          <FieldDescription>
            Branch{" "}
            <span className="font-mono">{trimmed === "" ? "mend/wt/…" : `mend/${trimmed}`}</span>.
            Leave it empty and Mend names it for you. Letters, digits, dots, dashes and underscores.
          </FieldDescription>
          {nameProblem === null ? null : <FieldError>{nameProblem}</FieldError>}
        </Field>
        <Field>
          <FieldLabel htmlFor={`${ids}-base`}>Start from</FieldLabel>
          <Autocomplete items={branchNames} value={base} onValueChange={setBase}>
            <AutocompleteInput
              id={`${ids}-base`}
              placeholder={project.defaultBranch}
              disabled={create.isPending}
              className={cn("w-full font-mono", phone && "h-11 text-lead")}
            />
            <AutocompleteContent>
              <AutocompleteEmpty>
                {branches.isPending
                  ? "Reading branches…"
                  : branches.isError
                    ? "Branches didn't load. Mend tries what you typed."
                    : "No branch matches. Mend tries what you typed."}
              </AutocompleteEmpty>
              <AutocompleteList>
                {(branch: string) => (
                  <AutocompleteItem key={branch} value={branch} className="font-mono">
                    {branch}
                  </AutocompleteItem>
                )}
              </AutocompleteList>
            </AutocompleteContent>
          </Autocomplete>
          <FieldDescription>
            Any branch, tag or commit. Empty starts from {project.defaultBranch}.
          </FieldDescription>
        </Field>
        {create.isError ? (
          <InlineAlert size={size}>{createFailure(create.error)}</InlineAlert>
        ) : null}
      </form>
    </Overlay>
  );
}
