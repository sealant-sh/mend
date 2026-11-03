import { SKILL_ENTRY_FILE, validateSkillFilePath } from "@mend/domain/workbench";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Button, IconButton } from "#/components/kit/button";
import { CodeEditor, CodeLines } from "#/components/kit/code-lines";
import { Field, TextInput } from "#/components/kit/field";
import { Icon } from "#/components/kit/icons";
import { ModalDialog } from "#/components/kit/modal";
import { Page } from "#/components/kit/page";
import { Panel } from "#/components/kit/section";
import { Segment } from "#/components/kit/segment";
import { ErrorNote, errorText } from "#/components/kit/status";
import { VerticalTabLink, VerticalTabs, verticalTabClass } from "#/components/kit/vertical-tabs";
import { AppShell } from "#/components/shell";
import type { SkillDetailDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

import {
  bundleShape,
  changedFiles,
  changedFilesWords,
  changedLines,
  shownFile,
  type DraftFile,
} from "./model";
import { SkillActions } from "./remove-skill-dialog";
import type { SkillSearch } from "./search";

const fileSearch = (file: string | undefined, edit: boolean): SkillSearch => ({
  ...(file === undefined || file === SKILL_ENTRY_FILE ? {} : { file }),
  ...(edit ? { edit: true } : {}),
});

const formatDay = (at: Date) => at.toLocaleDateString([], { month: "short", day: "numeric" });

/**
 * A skill (M2) and editing it (M3), for a skill in the person's library or a project's. Reading
 * shows one file at a time with line numbers; Edit opens the same files as a draft, and Save makes
 * the next revision. A save over someone else's newer revision is refused by the server, never
 * written over.
 */
export function SkillPage({
  skillId,
  search,
}: {
  readonly skillId: string;
  readonly search: SkillSearch;
}) {
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.skills.detail.queryOptions({ skillId })).data;
  return (
    <AppShell layout="bare" projectId={detail.skill.projectId ?? undefined}>
      <Page>
        {search.edit === true ? (
          <SkillEditor
            key={`${detail.skill.id}:${detail.skill.revision}`}
            detail={detail}
            file={search.file}
          />
        ) : (
          <SkillReader detail={detail} file={search.file} />
        )}
      </Page>
    </AppShell>
  );
}

function SkillHeader({
  detail,
  actions,
}: {
  readonly detail: SkillDetailDto;
  readonly actions: ReactNode;
}) {
  const { skill } = detail;
  return (
    <>
      <Crumbs detail={detail} />
      <header className="mb-4 flex items-end gap-6">
        <div className="min-w-0">
          <h1 className="truncate font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.02em]">
            {skill.name}
          </h1>
          <p className="mt-1.5 font-mono text-[12px] text-muted-foreground">
            {skill.scope === "user" ? "your library" : "project skill"} · revision {skill.revision}{" "}
            · {bundleShape(skill)}
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      </header>
      {skill.description === "" ? null : (
        <p className="-mt-2 mb-4 max-w-[80ch] text-[13.5px] text-muted-foreground">
          {skill.description}
        </p>
      )}
    </>
  );
}

function Crumbs({ detail }: { readonly detail: SkillDetailDto }) {
  const crumb = "rounded-md text-muted-foreground no-underline hover:text-foreground";
  const projectId = detail.skill.projectId;
  return (
    <nav aria-label="Breadcrumb" className="mb-1.5 font-sans text-[13px] font-medium">
      <ol className="flex items-center gap-1.5">
        {projectId === null ? (
          <li>
            <Link to="/skills" className={crumb}>
              Skills
            </Link>
          </li>
        ) : (
          <>
            <li>
              <Link to="/projects/$projectId" params={{ projectId }} className={crumb}>
                Project
              </Link>
            </li>
            <li aria-hidden="true" className="text-faint">
              /
            </li>
            <li>
              <Link
                to="/projects/$projectId/configuration"
                params={{ projectId }}
                hash="skills"
                className={crumb}
              >
                Skills
              </Link>
            </li>
          </>
        )}
        <li aria-hidden="true" className="text-faint">
          /
        </li>
        <li aria-current="page" className="text-foreground">
          {detail.skill.name}
        </li>
      </ol>
    </nav>
  );
}

const FileBar = ({ children }: { readonly children: ReactNode }) => (
  <div className="flex min-h-[31px] items-center gap-2 border-b border-rule-faint bg-secondary py-1 pr-2.5 pl-3.5 font-mono text-[12px] text-ink-2">
    {children}
  </div>
);

function FileList({
  files,
  edit,
  after,
  onRemove,
}: {
  readonly files: ReadonlyArray<DraftFile>;
  readonly edit: boolean;
  readonly after?: ReactNode;
  readonly onRemove?: (path: string) => void;
}) {
  return (
    <VerticalTabs label="Files">
      {files.map((file) => (
        <div key={file.path} className="group flex min-w-0 items-center">
          <VerticalTabLink
            from="/skills/$skillId"
            to="."
            search={fileSearch(file.path, edit)}
            // The whole search must match: SKILL.md's link carries no `file`, and a partial match
            // would mark it current beside whichever file is shown.
            activeOptions={{ exact: true, includeSearch: true }}
            className="min-w-0 flex-1"
          >
            {file.path}
          </VerticalTabLink>
          {onRemove === undefined || file.path === SKILL_ENTRY_FILE ? null : (
            <IconButton
              icon="close"
              size="sm"
              label={`Remove ${file.path}`}
              onClick={() => onRemove(file.path)}
            />
          )}
        </div>
      ))}
      {after}
    </VerticalTabs>
  );
}

function SkillReader({
  detail,
  file,
}: {
  readonly detail: SkillDetailDto;
  readonly file: string | undefined;
}) {
  const navigate = useNavigate({ from: "/skills/$skillId" });
  const shown = shownFile(detail.files, file);
  return (
    <>
      <SkillHeader
        detail={detail}
        actions={
          <>
            <SkillActions skill={detail.skill} />
            <Button onClick={() => void navigate({ search: fileSearch(shown?.path, true) })}>
              Edit
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
        <FileList files={detail.files} edit={false} />
        <Panel className="overflow-hidden p-0">
          <FileBar>
            <span className="truncate">{shown?.path ?? "no files"}</span>
            <span className="flex-1" />
            <span className="shrink-0 text-faint">
              revision {detail.skill.revision} · {formatDay(detail.skill.updatedAt)}
            </span>
          </FileBar>
          {shown === undefined ? null : <CodeLines text={shown.contents} />}
        </Panel>
      </div>
    </>
  );
}

interface Draft {
  readonly description: string;
  readonly files: ReadonlyArray<DraftFile>;
}

function SkillEditor({
  detail,
  file,
}: {
  readonly detail: SkillDetailDto;
  readonly file: string | undefined;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate({ from: "/skills/$skillId" });
  const [draft, setDraft] = useState<Draft>(() => ({
    description: detail.skill.description,
    files: detail.files.map(({ path, contents }) => ({ path, contents })),
  }));
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [adding, setAdding] = useState(false);
  const shown = shownFile(draft.files, file);
  const saved = detail.files.find((entry) => entry.path === shown?.path);
  const changed = changedFiles(detail.files, draft.files);
  const descriptionChanged = draft.description !== detail.skill.description;
  const dirty = changed.length > 0 || descriptionChanged;
  const marked =
    shown === undefined ? undefined : changedLines(saved?.contents ?? "", shown.contents);

  const save = useMutation(
    trpc.skills.update.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(trpc.skills.detail.queryKey({ skillId: next.skill.id }), next);
        void queryClient.invalidateQueries(trpc.skills.list.queryFilter());
        void queryClient.invalidateQueries(trpc.skills.forProject.queryFilter());
        await navigate({ search: fileSearch(file, false), ignoreBlocker: true });
      },
    }),
  );

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirty &&
      !save.isPending &&
      (next.pathname !== current.pathname || !("edit" in next.search) || next.search.edit !== true),
    enableBeforeUnload: () => dirty,
    withResolver: true,
  });

  const setContents = (contents: string) =>
    setDraft((current) => ({
      ...current,
      files: current.files.map((entry) =>
        entry.path === shown?.path ? { ...entry, contents } : entry,
      ),
    }));

  const removeFile = (path: string) => {
    setDraft((current) => ({
      ...current,
      files: current.files.filter((entry) => entry.path !== path),
    }));
    if (path === shown?.path) void navigate({ search: fileSearch(undefined, true) });
  };

  return (
    <>
      <SkillHeader
        detail={detail}
        actions={
          <>
            <span role="status" className="mr-2 font-mono text-[12px] text-muted-foreground">
              {save.isPending ? "Saving…" : changedFilesWords(changed.length, descriptionChanged)}
            </span>
            <Button
              variant="ghost"
              disabled={save.isPending}
              onClick={() =>
                void navigate({ search: fileSearch(file, false), ignoreBlocker: true })
              }
            >
              Discard
            </Button>
            <Button
              variant="primary"
              disabled={save.isPending || !dirty}
              onClick={() =>
                save.mutate({
                  skillId: detail.skill.id,
                  request: {
                    name: detail.skill.name,
                    description: draft.description,
                    files: draft.files,
                    expectedRevision: detail.skill.revision,
                  },
                })
              }
            >
              {save.isPending ? "Saving…" : `Save revision ${detail.skill.revision + 1}`}
            </Button>
          </>
        }
      />
      {save.error === null ? null : (
        <ErrorNote className="mb-4">Not saved: {errorText(save.error)}</ErrorNote>
      )}
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
        <FileList
          files={draft.files}
          edit
          onRemove={removeFile}
          after={
            <button
              type="button"
              onClick={() => setAdding(true)}
              className={`${verticalTabClass} flex items-center gap-1.5 text-info hover:text-info`}
            >
              <Icon name="plus" size={13} />
              Add a file
            </button>
          }
        />
        <div className="grid min-w-0 content-start gap-3">
          <Field label="Description">
            {(id) => (
              <TextInput
                id={id}
                sans
                value={draft.description}
                placeholder="When should an agent reach for this?"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            )}
          </Field>
          <Panel className="overflow-hidden p-0">
            <FileBar>
              <span className="truncate">{shown?.path ?? "no files"}</span>
              <span className="flex-1" />
              <Segment
                label={`Show ${shown?.path ?? "the file"} as`}
                value={mode}
                onChange={setMode}
                className="p-0.5 [&>*]:px-2.5 [&>*]:py-0.5 [&>*]:text-[12.5px]"
                options={[
                  { value: "edit", label: "Edit" },
                  { value: "preview", label: "Preview" },
                ]}
              />
            </FileBar>
            {shown === undefined ? null : mode === "edit" ? (
              <CodeEditor
                label={`Contents of ${shown.path}`}
                value={shown.contents}
                onValueChange={setContents}
                marked={marked}
              />
            ) : (
              <CodeLines text={shown.contents} marked={marked} />
            )}
          </Panel>
        </div>
      </div>
      <AddFileDialog
        open={adding}
        onOpenChange={setAdding}
        taken={draft.files.map((entry) => entry.path)}
        onAdd={(path) => {
          setDraft((current) => ({
            ...current,
            files: [...current.files, { path, contents: "" }],
          }));
          setAdding(false);
          void navigate({ search: fileSearch(path, true) });
        }}
      />
      <ModalDialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open && blocker.status === "blocked") blocker.reset();
        }}
        title="Leave without saving?"
        description={`${changedFilesWords(changed.length, descriptionChanged)} in ${detail.skill.name}. Leaving drops the draft.`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="primary" onClick={() => blocker.proceed?.()}>
              Leave
            </Button>
          </>
        }
      />
    </>
  );
}

function AddFileDialog({
  open,
  onOpenChange,
  taken,
  onAdd,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly taken: ReadonlyArray<string>;
  readonly onAdd: (path: string) => void;
}) {
  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add a file"
      description="A path inside the skill, such as references/notes.md. It starts empty."
      width={440}
    >
      {open ? (
        <AddFileForm taken={taken} onAdd={onAdd} onCancel={() => onOpenChange(false)} />
      ) : null}
    </ModalDialog>
  );
}

function AddFileForm({
  taken,
  onAdd,
  onCancel,
}: {
  readonly taken: ReadonlyArray<string>;
  readonly onAdd: (path: string) => void;
  readonly onCancel: () => void;
}) {
  const [path, setPath] = useState("");
  const trimmed = path.trim();
  const problem =
    trimmed === ""
      ? null
      : taken.includes(trimmed)
        ? "The skill already has a file at this path."
        : validateSkillFilePath(trimmed);
  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed !== "" && problem === null) onAdd(trimmed);
      }}
    >
      <Field label="Path">
        {(id) => (
          <>
            <TextInput
              id={id}
              value={path}
              autoFocus
              spellCheck={false}
              placeholder="references/notes.md"
              aria-invalid={problem !== null}
              aria-describedby={problem === null ? undefined : `${id}-problem`}
              onChange={(event) => setPath(event.target.value)}
            />
            {problem === null ? null : (
              <p id={`${id}-problem`} role="alert" className="text-[12.5px] text-danger">
                {problem}
              </p>
            )}
          </>
        )}
      </Field>
      <div className="flex items-center justify-end gap-2.5">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={trimmed === "" || problem !== null}>
          Add file
        </Button>
      </div>
    </form>
  );
}
