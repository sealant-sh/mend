import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { AppShell } from "#/components/shell";
import { formatSkillBytes } from "#/components/skills-library";
import { removeSkill, updateSkill, type SkillDetailDto } from "#/lib/api";
import { dropRemovedSkill, settleRemovedSkill } from "#/lib/skill-removal";
import { useTRPC } from "#/lib/trpc";
import { useWorkbenchEvents } from "#/lib/workbench-events";

export const Route = createFileRoute("/skills/$skillId")({
  ssr: false,
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(
      context.trpc.skills.detail.queryOptions({ skillId: params.skillId }),
    );
  },
  component: SkillPage,
});

function SkillPage() {
  const { skillId } = Route.useParams();
  const trpc = useTRPC();
  const detail = useSuspenseQuery(trpc.skills.detail.queryOptions({ skillId })).data;
  useWorkbenchEvents();

  return (
    <AppShell projectId={detail.skill.projectId ?? undefined}>
      <div className="min-w-0">
        <Crumbs detail={detail} />
        <div className="flex items-start justify-between gap-4">
          <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground">
            {detail.skill.name}
          </h1>
          <DeleteSkillButton detail={detail} />
        </div>
        <p className="mt-2 font-mono text-xs text-faint">
          {detail.skill.scope === "user" ? "your library" : "project library"} · revision{" "}
          {detail.skill.revision} · {detail.skill.fileCount} file
          {detail.skill.fileCount === 1 ? "" : "s"} · {formatSkillBytes(detail.skill.bytes)}
        </p>
        <SkillEditor key={`${detail.skill.id}:${detail.skill.revision}`} detail={detail} />
      </div>
    </AppShell>
  );
}

function Crumbs({ detail }: { readonly detail: SkillDetailDto }) {
  if (detail.skill.projectId === null) {
    return (
      <p className="ev-eyebrow">
        <Link to="/skills" className="transition-colors hover:text-foreground">
          skills
        </Link>
        <span className="mx-1.5 text-faint">/</span>
        {detail.skill.name}
      </p>
    );
  }
  const projectId = detail.skill.projectId;
  return (
    <p className="ev-eyebrow">
      <Link
        to="/projects/$projectId"
        params={{ projectId }}
        className="transition-colors hover:text-foreground"
      >
        project
      </Link>
      <span className="mx-1.5 text-faint">/</span>
      <Link
        to="/projects/$projectId/setup"
        params={{ projectId }}
        hash="skills"
        className="transition-colors hover:text-foreground"
      >
        skills
      </Link>
      <span className="mx-1.5 text-faint">/</span>
      {detail.skill.name}
    </p>
  );
}

/**
 * The whole bundle as one editable draft: description, the file list, one
 * file's contents at a time. Save replaces the bundle at the loaded revision —
 * a concurrent edit surfaces as the server's stale-write refusal, never a
 * silent overwrite.
 */
function SkillEditor({ detail }: { readonly detail: SkillDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [description, setDescription] = useState(detail.skill.description);
  const [files, setFiles] = useState<ReadonlyArray<{ path: string; contents: string }>>(
    detail.files.map((file) => ({ path: file.path, contents: file.contents })),
  );
  const [selected, setSelected] = useState("SKILL.md");
  const [newFilePath, setNewFilePath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const selectedFile = files.find((file) => file.path === selected) ?? files[0];
  const dirty =
    description !== detail.skill.description ||
    files.length !== detail.files.length ||
    detail.files.some(
      (file, index) => files[index]?.path !== file.path || files[index]?.contents !== file.contents,
    );

  const save = async () => {
    setPending(true);
    setError(null);
    try {
      await updateSkill(detail.skill.id, {
        name: detail.skill.name,
        description,
        files,
        expectedRevision: detail.skill.revision,
      });
      await queryClient.invalidateQueries(trpc.skills.pathFilter());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setPending(false);
    }
  };

  const addFile = () => {
    const path = newFilePath.trim();
    if (path === "" || files.some((file) => file.path === path)) return;
    setFiles([...files, { path, contents: "" }]);
    setSelected(path);
    setNewFilePath("");
  };

  const removeFile = (path: string) => {
    setFiles(files.filter((file) => file.path !== path));
    if (selected === path) setSelected("SKILL.md");
  };

  return (
    <div className="mt-6 border-t border-rule pt-6">
      <input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="description — when should an agent reach for this?"
        className="w-full rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-faint"
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {files.map((file) => (
          <span key={file.path} className="inline-flex items-center">
            <button
              type="button"
              onClick={() => setSelected(file.path)}
              className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors ${
                selectedFile?.path === file.path
                  ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {file.path}
            </button>
            {file.path !== "SKILL.md" && (
              <button
                type="button"
                aria-label={`Remove ${file.path}`}
                onClick={() => removeFile(file.path)}
                className="ml-0.5 px-1 font-mono text-[11px] text-faint transition-colors hover:text-danger"
              >
                ×
              </button>
            )}
          </span>
        ))}
        <input
          value={newFilePath}
          onChange={(event) => setNewFilePath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") addFile();
          }}
          placeholder="add file (references/notes.md)"
          className="w-56 rounded-lg border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-faint"
        />
      </div>

      {selectedFile !== undefined && (
        <textarea
          value={selectedFile.contents}
          onChange={(event) =>
            setFiles(
              files.map((file) =>
                file.path === selectedFile.path ? { ...file, contents: event.target.value } : file,
              ),
            )
          }
          rows={24}
          spellCheck={false}
          className="mt-3 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground"
        />
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || !dirty}
          onClick={() => void save()}
          className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {dirty && !pending && <span className="font-mono text-xs text-faint">unsaved changes</span>}
      </div>
      {error !== null && (
        <p className="mt-3 border-l-2 border-[var(--sw-red)] pl-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function DeleteSkillButton({ detail }: { readonly detail: SkillDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [state, setState] = useState<"idle" | "armed" | "working">("idle");

  const act = async () => {
    if (state === "idle") {
      setState("armed");
      return;
    }
    setState("working");
    try {
      const projectId = detail.skill.projectId;
      await removeSkill(detail.skill.id);
      await dropRemovedSkill(queryClient, trpc, detail.skill);
      if (projectId === null) {
        await navigate({ to: "/skills" });
      } else {
        await navigate({ to: "/projects/$projectId/setup", params: { projectId }, hash: "skills" });
      }
      void settleRemovedSkill(queryClient, trpc, detail.skill);
    } catch {
      setState("idle");
    }
  };

  return (
    <button
      type="button"
      disabled={state === "working"}
      onClick={() => void act()}
      onBlur={() => setState((current) => (current === "armed" ? "idle" : current))}
      className={`mt-2 rounded-xl border px-3 py-1.5 font-sans text-xs font-medium transition-colors ${
        state === "armed"
          ? "border-[var(--sw-red)] text-danger"
          : "border-border bg-card text-muted-foreground shadow-xs hover:text-foreground"
      }`}
    >
      {state === "working" ? "Removing…" : state === "armed" ? "Really remove?" : "Remove"}
    </button>
  );
}
