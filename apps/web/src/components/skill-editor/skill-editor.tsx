import { SKILL_ENTRY_FILE, validateSkillBundle } from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { useId, useRef, useState, type ReactNode } from "react";

import { Button, focusRing, IconButton } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { Icon } from "#/components/kit/icons";
import { ModalDialog } from "#/components/kit/modal";
import { Segment } from "#/components/kit/segment";
import { removeSkill, updateSkill, type SkillDetailDto } from "#/lib/api";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

import { changedFiles, newFileIssue, orderedFiles, skillDate, type DraftFile } from "./model";
import { SkillPreview } from "./preview";

/**
 * A skill, read and edited (screens K8, M2, M3): its files on the left, one file on the right with
 * line numbers. Edit turns the page into a draft held here until Save makes a new revision;
 * sessions that already loaded the skill keep theirs. Save sends the revision it started from, so
 * a skill someone else saved first is refused and said, never overwritten. Leaving with unsaved
 * edits asks first.
 *
 * Key it by the skill's id and revision, so a saved revision starts a fresh draft.
 */
export function SkillEditor({
  detail,
  crumb,
  scopeLine,
  editing,
  onEditingChange,
  afterDelete,
}: {
  readonly detail: SkillDetailDto;
  /** The breadcrumb over the title, ending in the skill's name. */
  readonly crumb: ReactNode;
  /** The mono line under the title: `project skill · mend · revision 7 · 6 files · 38 KB`. */
  readonly scopeLine: string;
  readonly editing: boolean;
  readonly onEditingChange: (editing: boolean) => Promise<void>;
  /** Where the page goes once the skill is deleted: back to the library that listed it. */
  readonly afterDelete: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { skill } = detail;
  const saved: ReadonlyArray<DraftFile> = detail.files;
  const [draft, setDraft] = useState<ReadonlyArray<DraftFile>>(saved);
  const [description, setDescription] = useState(skill.description);
  const [selected, setSelected] = useState(SKILL_ENTRY_FILE);
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [newPath, setNewPath] = useState<string | null>(null);
  const [newPathTried, setNewPathTried] = useState(false);
  const [bundleIssue, setBundleIssue] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Discard and Save end the draft on purpose; the blocker lets that navigation through.
  const leaving = useRef(false);

  const files = orderedFiles(editing ? draft : saved);
  const current = files.find((file) => file.path === selected) ?? files[0];
  const changed = changedFiles(saved, draft);
  const dirty = editing && (changed > 0 || description !== skill.description);

  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !leaving.current,
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const save = useMutation({
    mutationFn: () =>
      updateSkill(skill.id, {
        name: skill.name,
        description,
        files: draft,
        expectedRevision: skill.revision,
      }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(trpc.skills.detail.queryKey({ skillId: skill.id }), updated);
      leaving.current = true;
      void queryClient.invalidateQueries(trpc.skills.list.queryFilter());
      void queryClient.invalidateQueries(trpc.skills.forProject.queryFilter());
      await onEditingChange(false);
    },
  });
  const stale = save.isError && refusalTagOf(save.error) === "SkillStaleWrite";

  const remove = useMutation({
    mutationFn: () => removeSkill(skill.id),
    onSuccess: async () => {
      leaving.current = true;
      await afterDelete();
    },
  });

  const submit = () => {
    const issue = validateSkillBundle({ name: skill.name, description, files: draft });
    setBundleIssue(issue);
    if (issue === null) save.mutate();
  };

  const discard = () => {
    leaving.current = true;
    setDraft(saved);
    setDescription(skill.description);
    setNewPath(null);
    save.reset();
    void onEditingChange(false).finally(() => {
      leaving.current = false;
    });
  };

  const addFile = () => {
    if (newPath === null) return;
    const path = newPath.trim();
    setNewPathTried(true);
    if (newFileIssue(path, draft) !== null) return;
    setDraft([...draft, { path, contents: "" }]);
    setSelected(path);
    setView("edit");
    setNewPath(null);
    setNewPathTried(false);
  };

  const startAdding = () => {
    setNewPath("");
    setNewPathTried(false);
    if (!editing) void onEditingChange(true);
  };

  const pathIssue = newPath === null ? null : newFileIssue(newPath.trim(), draft);
  const newPathId = useId();

  return (
    <>
      {crumb}
      <header className="mb-4 flex items-end gap-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.02em]">
            {skill.name}
          </h1>
          <p className="mt-1.5 font-mono text-[12px] text-muted-foreground">{scopeLine}</p>
          {!editing && skill.description !== "" ? (
            <p className="mt-1.5 max-w-[72ch] text-[13.5px] text-ink-2">{skill.description}</p>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2.5">
          {editing ? (
            <>
              <span aria-live="polite" className="font-mono text-[12px] text-muted-foreground">
                {changed === 0
                  ? description === skill.description
                    ? "no changes"
                    : "description changed"
                  : `${changed} file${changed === 1 ? "" : "s"} changed`}
              </span>
              <Button variant="ghost" onClick={discard} disabled={save.isPending}>
                Discard
              </Button>
              <Button variant="primary" onClick={submit} disabled={save.isPending || !dirty}>
                {save.isPending ? "Saving…" : `Save revision ${skill.revision + 1}`}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => setDeleting(true)}>
                Delete…
              </Button>
              <Button onClick={() => void onEditingChange(true)}>Edit</Button>
            </>
          )}
        </div>
      </header>
      <div role="alert" className="mb-3 font-mono text-[12px] text-danger empty:hidden">
        {bundleIssue !== null ? (
          `Not saved: ${bundleIssue}`
        ) : stale ? (
          <>
            Someone saved a newer revision of {skill.name} first, so this one was not saved. Your
            edits stay here until you reload.{" "}
            <button
              type="button"
              className={cn("text-info underline underline-offset-2", focusRing)}
              onClick={() => {
                leaving.current = true;
                void queryClient.invalidateQueries(
                  trpc.skills.detail.queryFilter({ skillId: skill.id }),
                );
              }}
            >
              Reload and drop my edits
            </button>
          </>
        ) : save.isError ? (
          `Not saved: ${failureWords(save.error, "the server refused the revision")}`
        ) : null}
      </div>
      {editing ? (
        <div className="mb-4 max-w-[640px]">
          <Field label="Description">
            {(id) => (
              <TextInput
                id={id}
                sans
                value={description}
                disabled={save.isPending}
                placeholder="When should an agent reach for this?"
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </Field>
        </div>
      ) : null}

      <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4">
        <nav aria-label={`Files in ${skill.name}`} className="flex flex-col gap-0.5">
          {files.map((file) => (
            <div key={file.path} className="group/file flex items-center gap-1">
              <button
                type="button"
                aria-current={file.path === current?.path ? "true" : undefined}
                onClick={() => setSelected(file.path)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-[10px] px-2.5 py-[7px] text-left font-sans text-[13px] leading-[1.3] font-medium text-ink-2 transition-colors hover:text-foreground aria-[current=true]:bg-panel aria-[current=true]:text-foreground aria-[current=true]:shadow-xs",
                  focusRing,
                )}
              >
                {file.path}
              </button>
              {editing && file.path !== SKILL_ENTRY_FILE ? (
                <IconButton
                  icon="close"
                  size="sm"
                  label={`Remove ${file.path}`}
                  onClick={() => {
                    setDraft(draft.filter((entry) => entry.path !== file.path));
                    if (selected === file.path) setSelected(SKILL_ENTRY_FILE);
                  }}
                />
              ) : null}
            </div>
          ))}
          {newPath === null ? (
            <button
              type="button"
              onClick={startAdding}
              className={cn(
                "flex items-center gap-1.5 rounded-[10px] px-2.5 py-[7px] text-left font-sans text-[13px] font-medium text-info",
                focusRing,
              )}
            >
              <Icon name="plus" size={13} />
              Add a file
            </button>
          ) : (
            <form
              className="mt-1 grid gap-1.5 px-0.5"
              onSubmit={(event) => {
                event.preventDefault();
                addFile();
              }}
            >
              <label htmlFor={newPathId} className="font-sans text-[12px] font-medium text-ink-2">
                New file path
              </label>
              <TextInput
                id={newPathId}
                autoFocus
                value={newPath}
                placeholder="references/notes.md"
                aria-invalid={newPathTried && pathIssue !== null ? true : undefined}
                aria-describedby={`${newPathId}-issue`}
                onChange={(event) => setNewPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setNewPath(null);
                }}
              />
              <p
                id={`${newPathId}-issue`}
                role="alert"
                className="font-mono text-[11px] text-danger empty:hidden"
              >
                {newPathTried && pathIssue !== null ? pathIssue : ""}
              </p>
              <div className="flex gap-1.5">
                <Button size="sm" type="submit">
                  Add
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewPath(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </nav>

        {current === undefined ? null : (
          <section
            aria-label={current.path}
            className="overflow-hidden rounded-[22px] bg-panel shadow-sm"
          >
            <div className="flex items-center gap-2 border-b border-rule-faint bg-secondary py-[7px] pr-2.5 pl-3.5 font-mono text-[12px] text-ink-2">
              <span className="min-w-0 truncate">{current.path}</span>
              <span className="flex-1" />
              {editing ? (
                <Segment
                  label={`Show ${current.path} as`}
                  value={view}
                  onChange={setView}
                  className="p-0.5"
                  options={[
                    { value: "edit", label: "Edit", className: "px-2.5 py-0.5 text-[12.5px]" },
                    {
                      value: "preview",
                      label: "Preview",
                      className: "px-2.5 py-0.5 text-[12.5px]",
                    },
                  ]}
                />
              ) : (
                <span className="text-faint">
                  revision {skill.revision} · {skillDate(skill.updatedAt)}
                </span>
              )}
            </div>
            {editing && view === "preview" ? (
              <SkillPreview source={current.contents} />
            ) : (
              <NumberedSource
                path={current.path}
                contents={current.contents}
                onChange={
                  editing
                    ? (contents) =>
                        setDraft(
                          draft.map((file) =>
                            file.path === current.path ? { ...file, contents } : file,
                          ),
                        )
                    : null
                }
                disabled={save.isPending}
              />
            )}
          </section>
        )}
      </div>

      <ModalDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title="Leave without saving?"
        description={`Your edits to ${skill.name} are not saved. Leaving drops them.`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={() => blocker.proceed?.()}>
              Leave and drop my edits
            </Button>
          </>
        }
      />

      <ModalDialog
        open={deleting}
        onOpenChange={(open) => {
          if (!remove.isPending) setDeleting(open);
        }}
        title={`Delete ${skill.name}?`}
        description="New sessions stop loading it. Sessions that already loaded it keep theirs."
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)} disabled={remove.isPending}>
              Keep it
            </Button>
            <Button variant="primary" onClick={() => remove.mutate()} disabled={remove.isPending}>
              {remove.isPending ? "Deleting…" : "Delete skill"}
            </Button>
          </>
        }
      >
        <p role="alert" className="font-mono text-[12px] text-danger empty:hidden">
          {remove.isError ? `Not deleted: ${failureWords(remove.error, "the server refused")}` : ""}
        </p>
      </ModalDialog>
    </>
  );
}

/**
 * The file with its line numbers in a gutter. Lines never wrap, so each number stays beside its
 * line; a long line scrolls sideways. Editing grows the field with its contents for the same
 * reason.
 */
function NumberedSource({
  path,
  contents,
  onChange,
  disabled,
}: {
  readonly path: string;
  readonly contents: string;
  readonly onChange: ((contents: string) => void) | null;
  readonly disabled: boolean;
}) {
  const lines = contents.split("\n").length;
  const text = "py-3.5 font-mono text-[12.5px] leading-[1.7]";
  return (
    <div className="grid grid-cols-[34px_minmax(0,1fr)] overflow-x-auto">
      <pre
        aria-hidden="true"
        className={cn(text, "bg-secondary pr-2.5 text-right text-faint select-none")}
      >
        {Array.from({ length: lines }, (_, index) => index + 1).join("\n")}
      </pre>
      {onChange === null ? (
        <pre aria-label={path} className={cn(text, "px-3.5 whitespace-pre text-ink-2")}>
          {contents}
        </pre>
      ) : (
        <textarea
          aria-label={`Contents of ${path}`}
          value={contents}
          disabled={disabled}
          wrap="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            text,
            "field-sizing-content min-h-[240px] w-full resize-none overflow-hidden bg-transparent px-3.5 whitespace-pre text-ink-2 outline-none focus-visible:bg-wash/40",
          )}
        />
      )}
    </div>
  );
}
