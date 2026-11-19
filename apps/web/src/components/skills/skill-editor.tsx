import { SKILL_ENTRY_FILE } from "@mend/domain/workbench";
import { Alert, AlertDescription } from "@mend/ui/components/ui/alert";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Field, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { toast } from "@mend/ui/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { CircleAlertIcon, InfoIcon, PlusIcon, XIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import type { SkillDetailDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { doneWords, editorIntro, skillAt, type SkillOwner, skillsHome } from "#/lib/project-skills";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import {
  bundleIssue,
  changedFiles,
  changedLines,
  changedLinesWords,
  changedWhat,
  descriptionIssue,
  type DraftFile,
  fileIssue,
  fileMark,
  fileSearch,
  newFileIssue,
  orderedFiles,
  shownFile,
  unsavedWords,
} from "#/lib/skills";
import { useTRPC } from "#/lib/trpc";

import { SidebarToggle } from "../app-sidebar.tsx";
import { Overlay } from "../projects/overlay.tsx";
import { PhoneHeader } from "../workspace/phone-header.tsx";
import { CodeLines, SkillPreview } from "./code-lines.tsx";
import { FieldNote } from "./new-skill.tsx";

/**
 * Editing a skill (`/skills/<id>?edit=1`; Doop "Skills · editing a skill", "add a file", "saved
 * elsewhere first", "leave with unsaved changes"). It replaces the reading view: the description,
 * the files with what changed in each, and Save skill, which makes the next revision. Save sends
 * the revision the draft started from, so a revision saved elsewhere first refuses it and the page
 * says so; a newer revision that arrives before saving is said too, and the draft stays. A
 * project's skill (Doop "Project · Skills tab · editing") is the same editor, under the project.
 */
export function SkillEditorPage({
  skillId,
  file,
  owner,
}: {
  readonly skillId: string;
  readonly file: string | undefined;
  readonly owner: SkillOwner;
}) {
  const trpc = useTRPC();
  const detail = useQuery(trpc.skills.detail.queryOptions({ skillId }));
  switch (detail.status) {
    case "pending":
      return (
        <div aria-busy className="flex flex-col gap-3 px-8 pt-7">
          <span className="sr-only">Loading the skill…</span>
          <Skeleton className="h-5 w-64" />
          <Skeleton className="mt-6 h-9 w-full max-w-190" />
          <Skeleton className="mt-4 h-80 w-full" />
        </div>
      );
    case "error":
      return (
        <div className="px-8 pt-7 max-lg:px-4">
          <Alert tone="error">
            <CircleAlertIcon aria-hidden />
            <AlertDescription className="text-row text-muted-foreground">
              <p>
                <strong className="font-semibold text-foreground">
                  {refusalTagOf(detail.error) === "NotFound"
                    ? "This skill isn't here."
                    : "Couldn't load this skill."}
                </strong>{" "}
                {refusalTagOf(detail.error) === "NotFound"
                  ? "It was removed, from another browser or with mend skills push --prune."
                  : failureWords(detail.error, "Check your connection, then try again.")}
              </p>
              <div className="mt-2.5 flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={detail.isFetching}
                  onClick={() => void detail.refetch()}
                >
                  {detail.isFetching ? "Trying again…" : "Try again"}
                </Button>
                <Link
                  {...skillsHome(owner)}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {owner.kind === "you"
                    ? "Back to your skills"
                    : `Back to ${owner.projectName}'s skills`}
                </Link>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      );
    case "success":
      return <SkillEditor key={skillId} detail={detail.data} file={file} owner={owner} />;
  }
}

/** A draft and the revision it started from. Held only while it differs from that revision. */
interface HeldDraft {
  readonly base: SkillDetailDto;
  readonly files: ReadonlyArray<DraftFile>;
  readonly description: string;
}

function SkillEditor({
  detail,
  file,
  owner,
}: {
  readonly detail: SkillDetailDto;
  readonly file: string | undefined;
  readonly owner: SkillOwner;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const phone = usePhone();
  const id = useId();
  const descriptionField = useRef<HTMLInputElement>(null);

  const [held, setHeld] = useState<HeldDraft | null>(null);
  const active =
    held !== null &&
    (changedFiles(held.base.files, held.files).length > 0 ||
      held.description !== held.base.skill.description)
      ? held
      : null;
  const base = active?.base ?? detail;
  const { skill } = base;
  const saved: ReadonlyArray<DraftFile> = base.files;
  const draft = active?.files ?? saved;
  const description = active?.description ?? skill.description;
  const setDraft = (files: ReadonlyArray<DraftFile>) => setHeld({ base, files, description });
  const setDescription = (next: string) => setHeld({ base, files: draft, description: next });
  // A revision saved after this draft began. The draft stays on its own until the person loads it.
  const newer = detail.skill.revision > skill.revision ? detail.skill.revision : null;

  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [tried, setTried] = useState(false);
  // Discard and Save end the draft on purpose; the blocker lets that navigation through.
  const leaving = useRef(false);

  const files = orderedFiles(draft);
  const current = shownFile(files, file);
  const changed = changedFiles(saved, draft).length;
  const descriptionChanged = description !== skill.description;
  const dirty = changed > 0 || descriptionChanged;
  const marked = changedLines(
    saved.find((entry) => entry.path === current?.path)?.contents ?? "",
    current?.contents ?? "",
  );
  const issues = {
    description: descriptionIssue(description),
    files: new Map(
      files.flatMap((entry) => {
        const issue = fileIssue(entry);
        return issue === null ? [] : [[entry.path, issue] as const];
      }),
    ),
    bundle: bundleIssue(draft),
  };

  const push = owner.kind === "you" ? "mend skills push" : "mend skills push --project";
  const select = (path: string) =>
    void navigate({ ...skillAt(owner, skill.id, fileSearch(path, true)), replace: true });
  const toReading = async () => {
    leaving.current = true;
    await navigate(skillAt(owner, skill.id, fileSearch(current?.path, false)));
    leaving.current = false;
  };

  const blocker = useBlocker({
    shouldBlockFn: ({ current: here, next }) =>
      dirty &&
      !leaving.current &&
      (next.pathname !== here.pathname || !("edit" in next.search) || next.search.edit !== 1),
    enableBeforeUnload: () => dirty && !leaving.current,
    withResolver: true,
  });

  const save = useMutation(
    trpc.skills.update.mutationOptions({
      onSuccess: async (updated) => {
        queryClient.setQueryData(trpc.skills.detail.queryKey({ skillId: skill.id }), updated);
        void queryClient.invalidateQueries(trpc.skills.list.queryFilter());
        void queryClient.invalidateQueries(trpc.skills.forProject.pathFilter());
        setHeld(null);
        await toReading();
        toast.add({ description: doneWords(owner, "Saved", updated.skill.name) });
      },
      onError: (error) => {
        // Read the revision that won, so the page can name it and load it.
        if (refusalTagOf(error) === "SkillStaleWrite")
          void queryClient.invalidateQueries(trpc.skills.detail.queryFilter({ skillId: skill.id }));
      },
    }),
  );
  const stale = save.isError && refusalTagOf(save.error) === "SkillStaleWrite";

  const submit = () => {
    setTried(true);
    if (issues.description !== null) return descriptionField.current?.focus();
    const tooBig = files.find((entry) => issues.files.has(entry.path));
    if (tooBig !== undefined) return select(tooBig.path);
    if (issues.bundle !== null) return;
    save.mutate({
      skillId: skill.id,
      request: { name: skill.name, description, files: draft, expectedRevision: skill.revision },
    });
  };
  const loadNewer = () => {
    setHeld(null);
    setTried(false);
    save.reset();
  };
  const removeFile = (path: string) => {
    setDraft(draft.filter((entry) => entry.path !== path));
    if (current?.path === path) select(SKILL_ENTRY_FILE);
  };
  const addFile = (path: string) => {
    setDraft([...draft, { path, contents: "" }]);
    setMode("edit");
    select(path);
  };

  const status = save.isPending ? "Saving…" : unsavedWords(changed, descriptionChanged);
  const fileProblem =
    current === undefined ? null : ((tried ? issues.files.get(current.path) : null) ?? null);
  const size = phone ? "touch" : "default";
  const discard = (
    <Button variant="ghost" size={size} disabled={save.isPending} onClick={() => void toReading()}>
      {dirty ? "Discard changes" : "Stop editing"}
    </Button>
  );
  const saveButton = (
    <Button size={size} disabled={save.isPending || !dirty} onClick={submit}>
      {save.isPending ? "Saving…" : "Save skill"}
    </Button>
  );

  return (
    <div className="flex min-w-0 flex-col max-lg:min-h-dvh max-lg:pb-20 lg:min-h-0 lg:flex-1">
      <PhoneHeader
        className="sticky top-0 z-10 lg:hidden"
        title={skill.name}
        sub={status}
        back={{ link: skillAt(owner, skill.id), label: `Back to ${skill.name}` }}
      />
      <header className="flex h-header shrink-0 items-center gap-3 border-b bg-background pr-2.5 pl-3 max-lg:hidden">
        <SidebarToggle />
        <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-baseline gap-2 text-prose">
            {owner.kind === "you" ? null : (
              <>
                <li>
                  <Link to="/projects" className="text-muted-foreground hover:text-foreground">
                    Projects
                  </Link>
                </li>
                <li aria-hidden className="text-faint">
                  /
                </li>
                <li className="min-w-0 truncate">
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: owner.projectId }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {owner.projectName}
                  </Link>
                </li>
                <li aria-hidden className="text-faint">
                  /
                </li>
              </>
            )}
            <li>
              <Link {...skillsHome(owner)} className="text-muted-foreground hover:text-foreground">
                Skills
              </Link>
            </li>
            <li aria-hidden className="text-faint">
              /
            </li>
            <li aria-current="page" className="min-w-0 truncate font-mono text-meta font-medium">
              <h1 className="truncate">{skill.name}</h1>
            </li>
          </ol>
        </nav>
        <p role="status" className="shrink-0 text-row text-muted-foreground">
          {status}
        </p>
        {discard}
        {saveButton}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-5 pb-10 max-lg:px-0 max-lg:pt-0">
        <p className="mb-4 text-row text-muted-foreground max-lg:hidden">
          {editorIntro(owner, skill.revision)}
        </p>
        <div className="flex max-w-190 flex-col gap-3 empty:hidden max-lg:px-4 max-lg:pt-4">
          {stale ? (
            <Notice tone="error" lead="Not saved.">
              {owner.kind === "you" ? "You saved" : "Someone saved"}{" "}
              {newer === null ? "a newer revision" : `revision ${newer}`} of {skill.name} somewhere
              else, from another browser or with <code className="font-mono text-meta">{push}</code>
              , while you were editing here. Your changes are still on this page. Copy what you want
              to keep, then load {newer === null ? "it" : `revision ${newer}`}.
              {newer === null ? null : <LoadButton revision={newer} onLoad={loadNewer} />}
            </Notice>
          ) : newer === null ? null : (
            <Notice tone="info" lead={`Revision ${newer} was saved somewhere else.`}>
              It came from another browser or from{" "}
              <code className="font-mono text-meta">{push}</code> while you were editing here, so
              saving this draft will be refused. Copy what you want to keep, then load revision{" "}
              {newer}.
              <LoadButton revision={newer} onLoad={loadNewer} />
            </Notice>
          )}
          {tried && issues.bundle !== null ? (
            <Notice tone="error" lead="Not saved.">
              {issues.bundle}
            </Notice>
          ) : null}
          {save.isError && !stale ? (
            <Notice tone="error" lead="Not saved.">
              {failureWords(save.error, "Mend couldn't save the skill. Try again.")}
            </Notice>
          ) : null}
        </div>
        <Field
          data-invalid={(tried && issues.description !== null) || undefined}
          className="mt-1 max-w-190 max-lg:px-4 max-lg:pt-4"
        >
          <FieldLabel htmlFor={`${id}-description`}>Description</FieldLabel>
          <Input
            ref={descriptionField}
            id={`${id}-description`}
            value={description}
            disabled={save.isPending}
            autoComplete="off"
            aria-invalid={(tried && issues.description !== null) || undefined}
            aria-describedby={`${id}-description-note`}
            onChange={(event) => setDescription(event.target.value)}
            className="h-9 max-lg:h-11 max-lg:text-base"
          />
          <FieldNote id={`${id}-description-note`} issue={tried ? issues.description : null} />
        </Field>
        <div className="mt-6 grid gap-7 max-lg:mt-4 max-lg:gap-0 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <FileList
            files={files}
            saved={saved}
            current={current?.path}
            problems={tried ? issues.files : new Map()}
            onSelect={select}
            onRemove={removeFile}
            onAdd={addFile}
            phone={phone}
          />
          {current === undefined ? null : (
            <section
              aria-label={current.path}
              className="min-w-0 self-start overflow-hidden rounded-lg border max-lg:rounded-none max-lg:border-x-0 max-lg:border-b-0"
            >
              <div className="flex min-h-10 items-center gap-3 border-b bg-muted/50 px-4 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-meta">{current.path}</span>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {changedLinesWords(marked.size)}
                </span>
                <ToggleGroup
                  aria-label={`Show ${current.path} as`}
                  variant="outline"
                  size="sm"
                  spacing={0}
                  value={[mode]}
                  onValueChange={(value: ReadonlyArray<string>) => {
                    const next = value[0];
                    if (next === "edit" || next === "preview") setMode(next);
                  }}
                >
                  <ToggleGroupItem value="edit" className="max-lg:h-9 max-lg:px-3">
                    Edit
                  </ToggleGroupItem>
                  <ToggleGroupItem value="preview" className="max-lg:h-9 max-lg:px-3">
                    Preview
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              {fileProblem === null ? null : (
                <FieldNote
                  id={`${id}-file-note`}
                  issue={fileProblem}
                  className="border-b px-4 py-2.5"
                />
              )}
              {mode === "edit" ? (
                <CodeLines
                  key={current.path}
                  label={`Contents of ${current.path}`}
                  value={current.contents}
                  marked={marked}
                  disabled={save.isPending}
                  invalid={fileProblem !== null}
                  {...(fileProblem === null ? {} : { describedBy: `${id}-file-note` })}
                  onChange={(contents) =>
                    setDraft(
                      draft.map((entry) =>
                        entry.path === current.path ? { ...entry, contents } : entry,
                      ),
                    )
                  }
                />
              ) : (
                <SkillPreview source={current.contents} />
              )}
            </section>
          )}
        </div>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-20 flex gap-3 border-t bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden [&>*]:flex-1">
        {discard}
        {saveButton}
      </div>
      <Overlay
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title="Leave without saving?"
        description={`You changed ${changedWhat(changed, descriptionChanged)} in ${skill.name} and haven't saved ${changed + (descriptionChanged ? 1 : 0) === 1 ? "it" : "them"}. Leaving drops those changes.`}
        size="sm"
        footer={
          <>
            <Button variant="outline" size={size} onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="destructive" size={size} onClick={() => blocker.proceed?.()}>
              Leave without saving
            </Button>
          </>
        }
      />
    </div>
  );
}

function Notice({
  tone,
  lead,
  children,
}: {
  readonly tone: "error" | "info";
  readonly lead: string;
  readonly children: ReactNode;
}) {
  return (
    <Alert tone={tone} role={tone === "error" ? "alert" : "status"}>
      {tone === "error" ? <CircleAlertIcon aria-hidden /> : <InfoIcon aria-hidden />}
      <AlertDescription className="text-row text-muted-foreground">
        <div>
          <strong className="font-semibold text-foreground">{lead}</strong> {children}
        </div>
      </AlertDescription>
    </Alert>
  );
}

function LoadButton({
  revision,
  onLoad,
}: {
  readonly revision: number;
  readonly onLoad: () => void;
}) {
  return (
    <div className="mt-2.5">
      <Button variant="outline" size="sm" className="max-lg:h-11 max-lg:px-4" onClick={onLoad}>
        Load revision {revision}
      </Button>
    </div>
  );
}

/**
 * The skill's files: each with what changed in it (new, edited), a way to remove any file but
 * SKILL.md, and Add a file, which asks for a path inline on a desk and in a sheet on a phone.
 */
function FileList({
  files,
  saved,
  current,
  problems,
  onSelect,
  onRemove,
  onAdd,
  phone,
}: {
  readonly files: ReadonlyArray<DraftFile>;
  readonly saved: ReadonlyArray<DraftFile>;
  readonly current: string | undefined;
  readonly problems: ReadonlyMap<string, string>;
  readonly onSelect: (path: string) => void;
  readonly onRemove: (path: string) => void;
  readonly onAdd: (path: string) => void;
  readonly phone: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="min-w-0 max-lg:px-4 max-lg:pb-4">
      <p className="px-2.5 pb-1.5 text-row text-muted-foreground max-lg:hidden">Files</p>
      <ul
        aria-label="Files"
        className="flex flex-col gap-0.5 max-lg:flex-row max-lg:flex-wrap max-lg:gap-2"
      >
        {files.map((entry) => {
          const mark = problems.has(entry.path) ? "too big" : fileMark(saved, entry);
          const selected = entry.path === current;
          return (
            <li
              key={entry.path}
              className="group/file flex min-w-0 items-center max-lg:rounded-lg max-lg:border"
            >
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                onClick={() => onSelect(entry.path)}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11 max-lg:px-3",
                  selected && "bg-muted hover:bg-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-meta max-lg:text-row">
                  {entry.path}
                </span>
                {mark === null ? null : (
                  <span
                    className={cn(
                      "shrink-0 text-meta",
                      mark === "too big" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {mark}
                  </span>
                )}
              </button>
              {entry.path === SKILL_ENTRY_FILE ? null : (
                <Button
                  variant="ghost"
                  size={phone ? "icon-touch" : "icon-xs"}
                  aria-label={`Remove ${entry.path}`}
                  className="ml-0.5 text-muted-foreground lg:opacity-0 lg:group-hover/file:opacity-100 lg:group-focus-within/file:opacity-100"
                  onClick={() => onRemove(entry.path)}
                >
                  <XIcon aria-hidden />
                </Button>
              )}
            </li>
          );
        })}
        {phone || !adding ? (
          <li>
            <Button
              variant="link"
              className="h-auto gap-1.5 px-2.5 py-2 text-row no-underline max-lg:min-h-11 max-lg:rounded-lg max-lg:border max-lg:border-dashed max-lg:px-3"
              onClick={() => setAdding(true)}
            >
              <PlusIcon aria-hidden className="size-4" />
              Add a file
            </Button>
          </li>
        ) : null}
      </ul>
      {phone ? (
        <AddFileSheet open={adding} onOpenChange={setAdding} files={files} onAdd={onAdd} />
      ) : adding ? (
        <AddFileForm
          files={files}
          onAdd={(path) => {
            onAdd(path);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

/** The path a new file takes, with its rule; Enter adds it and Escape cancels. */
function usePathField(files: ReadonlyArray<DraftFile>, onAdd: (path: string) => void) {
  const id = useId();
  const [path, setPath] = useState("");
  const [tried, setTried] = useState(false);
  const issue = newFileIssue(path.trim(), files);
  const submit = () => {
    setTried(true);
    if (issue === null) onAdd(path.trim());
  };
  const field = (cancel: () => void) => (
    <Field data-invalid={(tried && issue !== null) || undefined}>
      <FieldLabel htmlFor={`${id}-path`}>{"New file path"}</FieldLabel>
      <Input
        id={`${id}-path`}
        value={path}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder="references/notes.md"
        aria-invalid={(tried && issue !== null) || undefined}
        aria-describedby={`${id}-path-note`}
        onChange={(event) => setPath(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        className="h-9 font-mono max-lg:h-11"
      />
      <FieldNote
        id={`${id}-path-note`}
        issue={tried ? issue : null}
        hint="A path inside the skill. The file starts empty."
      />
    </Field>
  );
  return { field, submit };
}

function AddFileForm({
  files,
  onAdd,
  onCancel,
}: {
  readonly files: ReadonlyArray<DraftFile>;
  readonly onAdd: (path: string) => void;
  readonly onCancel: () => void;
}) {
  const { field, submit } = usePathField(files, onAdd);
  return (
    <div className="mt-3 flex flex-col gap-2.5 px-1">
      {field(onCancel)}
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" onClick={submit}>
          Add file
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddFileSheet({
  open,
  onOpenChange,
  files,
  onAdd,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly files: ReadonlyArray<DraftFile>;
  readonly onAdd: (path: string) => void;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Add a file" size="sm" footer={null}>
      {open ? (
        <AddFileSheetBody
          files={files}
          onAdd={(path) => {
            onAdd(path);
            onOpenChange(false);
          }}
          onCancel={() => onOpenChange(false)}
        />
      ) : null}
    </Overlay>
  );
}

function AddFileSheetBody({
  files,
  onAdd,
  onCancel,
}: {
  readonly files: ReadonlyArray<DraftFile>;
  readonly onAdd: (path: string) => void;
  readonly onCancel: () => void;
}) {
  const { field, submit } = usePathField(files, onAdd);
  return (
    <>
      {field(onCancel)}
      <div className="flex flex-col gap-2 pt-2">
        <Button size="touch" onClick={submit}>
          Add file
        </Button>
        <Button variant="ghost" size="touch" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}
