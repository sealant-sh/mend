import { Button } from "@mend/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mend/ui/components/ui/dialog";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { createWorktree, type ProjectDto, type WorktreeDto } from "#/lib/api";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

/**
 * The shape `WorktreeName` accepts (packages/api-contracts/src/project-environment.ts).
 * Mirrored here so the draft is judged before the round trip; the server stays
 * the authority.
 */
const NAME_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The contract's own guidance, in the reader's words. */
const NAME_GUIDANCE =
  "Start with a lowercase letter or digit. Use letters, digits, dots, underscores, or hyphens.";

/** Keep the field inside the contract's alphabet while it is being typed. */
const normalizeName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 64);

/** Plain copy for a refused create, by which refusal it was (`refusalTagOf`). */
const createFailureMessage = (cause: unknown): string => {
  const tag = refusalTagOf(cause);
  if (tag === "WorktreeNameTaken")
    return "That name is already used in this project. Choose another.";
  if (tag === "NotFound") return "This project is no longer in the store.";
  if (tag === "StoreFailure") return failureWords(cause, "The store refused the worktree.");
  return failureWords(cause, "The worktree was not created.");
};

/** How many branch suggestions the base field offers at once. */
const SUGGESTION_LIMIT = 6;

/**
 * Create a worktree in `project`. The caller owns the trigger and open state.
 * The dialog closes itself once the store has the
 * new worktree and the affected queries have been refetched. A refusal keeps
 * the draft on screen so the name can be edited and resubmitted.
 */
export function NewWorktreeDialog({
  project,
  open,
  onOpenChange,
  onCreated,
}: {
  readonly project: ProjectDto;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Select the new worktree after the affected lists have refetched. */
  readonly onCreated?: (worktree: WorktreeDto) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Branches are a convenience only, and only while the dialog is open. A
  // failed or slow read leaves the base field a plain text input.
  const branchesQuery = useQuery({
    ...trpc.projects.branches.queryOptions({ id: project.id }),
    enabled: open,
  });
  const typedBase = base.trim();
  const suggestions = (branchesQuery.data ?? [])
    .filter((branch) => branch.name !== typedBase && branch.name.includes(typedBase))
    .slice(0, SUGGESTION_LIMIT);

  const trimmedName = name.trim();
  const branchPreview = trimmedName === "" ? "mend/wt/…" : `mend/${trimmedName}`;

  const close = () => {
    setName("");
    setBase("");
    setError(null);
    onOpenChange(false);
  };

  const submit = () => {
    if (pending) return;
    if (trimmedName !== "" && !NAME_SHAPE.test(trimmedName)) {
      setError(NAME_GUIDANCE);
      return;
    }
    setPending(true);
    setError(null);
    void createWorktree(project.id, {
      name: trimmedName === "" ? null : trimmedName,
      base: typedBase === "" ? null : typedBase,
    })
      .then(async (worktree) => {
        // Refetch before closing so the new worktree is visible and selectable.
        await Promise.all([
          queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
          queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
          queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
        ]);
        setPending(false);
        close();
        onCreated?.(worktree);
        return null;
      })
      .catch((cause: unknown) => {
        setPending(false);
        setError(createFailureMessage(cause));
      });
  };

  return (
    <Dialog
      open={open}
      // A create in flight cannot be abandoned halfway: Escape, the scrim and
      // the close button all wait for it to settle.
      disablePointerDismissal={pending}
      onOpenChange={(next) => {
        if (pending) return;
        if (next) onOpenChange(true);
        else close();
      }}
    >
      {/* The close button stays mounted while pending — dropping it would take
          focus with it; the guard above is what refuses the close. */}
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            Create a worktree in {project.name}, then add sessions.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div>
            <Label htmlFor={`${fieldId}-name`}>Name</Label>
            <Input
              id={`${fieldId}-name`}
              autoFocus
              value={name}
              disabled={pending}
              placeholder="fix-auth (optional)"
              aria-describedby={`${fieldId}-branch`}
              onChange={(event) => setName(normalizeName(event.target.value))}
              className="mt-1.5 font-mono text-[12.5px]"
            />
            <p
              id={`${fieldId}-branch`}
              title={`branch ${branchPreview}`}
              className="mt-1.5 truncate font-mono text-[11.5px] text-faint"
            >
              branch {branchPreview}
            </p>
          </div>
          <div>
            <Label htmlFor={`${fieldId}-base`}>Base branch or ref</Label>
            <Input
              id={`${fieldId}-base`}
              list={`${fieldId}-branches`}
              value={base}
              disabled={pending}
              placeholder={project.defaultBranch}
              aria-describedby={`${fieldId}-base-help`}
              onChange={(event) => setBase(event.target.value)}
              className="mt-1.5 font-mono text-[12.5px]"
            />
            <p id={`${fieldId}-base-help`} className="mt-1.5 font-mono text-[11.5px] text-faint">
              Defaults to {project.defaultBranch}
            </p>
            <datalist id={`${fieldId}-branches`}>
              {suggestions.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.isDefault ? "Default branch" : branch.sha.slice(0, 7)}
                </option>
              ))}
            </datalist>
          </div>
          <div className="h-10 overflow-y-auto">
            {error !== null && (
              <p
                role="alert"
                className="border-l-2 border-[var(--sw-red)] pl-3 text-[13px] leading-relaxed text-danger break-words"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending} className="min-w-32">
              {pending ? "Creating…" : "Create worktree"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
