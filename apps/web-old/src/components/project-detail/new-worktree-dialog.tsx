import { WORKTREE_NAME_PATTERN } from "@mend/domain/workbench";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import { Button } from "#/components/kit/button";
import { Field, FieldSource, TextInput } from "#/components/kit/field";
import { fuzzyMatch } from "#/components/kit/fuzzy";
import { ModalDialog } from "#/components/kit/modal";
import { SearchCombobox } from "#/components/kit/search-combobox";
import { createWorktree, type ProjectDto, type WorktreeDto } from "#/lib/api";
import { ago } from "#/lib/inbox";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

/** The contract's own guidance, in the reader's words. */
const NAME_GUIDANCE =
  "Start with a lowercase letter or digit. Use letters, digits, dots, underscores, or hyphens.";

/** Keep the field inside the contract's alphabet while it is being typed. */
export const normalizeWorktreeName = (value: string): string =>
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

/** The create in flight for a project, so the dialog refuses to close halfway through it. */
const createKey = (projectId: ProjectDto["id"]) => ["new-worktree", projectId] as const;

type BranchDto = NonNullable<ReturnType<typeof useBranches>["data"]>[number];

const useBranches = (projectId: ProjectDto["id"], enabled: boolean) => {
  const trpc = useTRPC();
  return useQuery({ ...trpc.projects.branches.queryOptions({ id: projectId }), enabled });
};

/** `default · e36c017 · 2 h ago` / `branch · 4f19a2c · Oct 17`. */
const branchMeta = (branch: BranchDto, now: Date): string =>
  `${branch.isDefault ? "default" : "branch"} · ${branch.sha.slice(0, 7)} · ${ago(new Date(branch.committedAt), now)}`;

/**
 * New worktree (screen K3): an optional name and the base it starts from. The base is a field that
 * finds a branch by a few of its letters, like `mend` in the terminal, and still takes any ref
 * typed whole. The caller owns the open state. The dialog closes once the store has the worktree
 * and the lists that show it have been read again; a refusal keeps the draft on screen, said where
 * a screen reader hears it, and a create in flight cannot be dismissed halfway.
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
  const creating = useIsMutating({ mutationKey: createKey(project.id) }) > 0;
  return (
    <ModalDialog
      open={open}
      onOpenChange={(next) => {
        if (!creating) onOpenChange(next);
      }}
      title="New worktree"
      width={480}
      description={`A worktree in ${project.name}, on its own branch. Sessions you start in it share its change.`}
    >
      {open ? (
        <NewWorktreeForm
          project={project}
          onClose={() => onOpenChange(false)}
          onCreated={onCreated}
        />
      ) : null}
    </ModalDialog>
  );
}

function NewWorktreeForm({
  project,
  onClose,
  onCreated,
}: {
  readonly project: ProjectDto;
  readonly onClose: () => void;
  readonly onCreated: ((worktree: WorktreeDto) => void) | undefined;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorId = useId();
  const [name, setName] = useState("");
  const [base, setBase] = useState("");
  const [nameIssue, setNameIssue] = useState<string | null>(null);
  const branches = useBranches(project.id, true);
  const now = new Date();
  const trimmedName = name.trim();
  const typedBase = base.trim();
  const create = useMutation({
    mutationKey: createKey(project.id),
    mutationFn: () =>
      createWorktree(project.id, {
        name: trimmedName === "" ? null : trimmedName,
        base: typedBase === "" ? null : typedBase,
      }),
    onSuccess: async (worktree) => {
      // Read the lists again before closing, so the new worktree is there to pick.
      await Promise.all([
        queryClient.invalidateQueries(trpc.projects.detail.queryFilter({ id: project.id })),
        queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
        queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
      ]);
      onClose();
      onCreated?.(worktree);
    },
  });

  const submit = () => {
    if (create.isPending) return;
    if (trimmedName !== "" && !WORKTREE_NAME_PATTERN.test(trimmedName)) {
      setNameIssue(NAME_GUIDANCE);
      return;
    }
    setNameIssue(null);
    create.mutate();
  };

  const list = branches.data ?? [];
  const error = nameIssue ?? (create.isError ? createFailureMessage(create.error) : null);
  const matched =
    typedBase === ""
      ? list.length
      : list.filter((branch) => fuzzyMatch(typedBase, branch.name) !== null).length;

  return (
    <form
      className="grid gap-4"
      aria-busy={create.isPending || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="Name" source={<FieldSource>optional</FieldSource>}>
        {(id) => (
          <>
            <TextInput
              id={id}
              autoFocus
              value={name}
              disabled={create.isPending}
              placeholder="fix-auth"
              aria-invalid={nameIssue !== null || undefined}
              aria-describedby={`${id}-branch ${errorId}`}
              onChange={(event) => setName(normalizeWorktreeName(event.target.value))}
            />
            <p id={`${id}-branch`} className="truncate font-mono text-[11px] text-faint">
              branch {trimmedName === "" ? "mend/wt/…" : `mend/${trimmedName}`}
            </p>
          </>
        )}
      </Field>
      <Field label="Base branch or ref">
        {(id) => (
          <>
            <SearchCombobox
              id={id}
              items={list}
              itemKey={(branch) => branch.name}
              itemText={(branch) => branch.name}
              meta={(branch) => branchMeta(branch, now)}
              value={base}
              onValueChange={setBase}
              filter="fuzzy"
              placeholder={project.defaultBranch}
              disabled={create.isPending}
              describedBy={`${id}-help`}
              trailing={branches.data === undefined ? undefined : `${matched} / ${list.length}`}
              status={branches.isPending ? "Reading branches…" : undefined}
              footer={<span>↑↓ move · ↵ pick · fuzzy, like mend in the terminal</span>}
            />
            <p id={`${id}-help`} className="font-mono text-[11px] text-faint">
              {branches.isError
                ? `Branches did not load, so nothing is suggested. Type a branch, tag or sha; empty starts from ${project.defaultBranch}.`
                : `Empty starts from ${project.defaultBranch}. Any branch, tag or sha works.`}
            </p>
          </>
        )}
      </Field>
      <p
        id={errorId}
        role="alert"
        className="border-l-2 border-danger pl-3 text-[13px] leading-relaxed break-words text-danger empty:hidden"
      >
        {error}
      </p>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" disabled={create.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create worktree"}
        </Button>
      </div>
    </form>
  );
}
