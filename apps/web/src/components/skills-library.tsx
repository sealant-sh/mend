import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { createSkill, type SkillDto, type SkillScopeDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * One library, either scope: the list of skill bundles plus the inline create
 * form. A skill is a directory of instruction files delivered into every new
 * session's harness home; the pages differ only in whose library this is.
 */
export function SkillsLibrary({
  scope,
  projectId = null,
}: {
  readonly scope: SkillScopeDto;
  readonly projectId?: string | null;
}) {
  const trpc = useTRPC();
  const skills = useSuspenseQuery(
    scope === "project" && projectId !== null
      ? trpc.skills.forProject.queryOptions({ id: projectId })
      : trpc.skills.list.queryOptions(),
  ).data;

  return (
    <>
      <CreateSkillForm scope={scope} projectId={projectId} />

      <div className="mt-8 flex flex-col gap-3">
        {skills.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing here yet — create one above
            {scope === "user" ? (
              <>
                , or push your local library with{" "}
                <span className="font-mono text-xs">mend skills push</span>.
              </>
            ) : (
              <>
                , or push a local library with{" "}
                <span className="font-mono text-xs">mend skills push --project</span>.
              </>
            )}
          </p>
        ) : (
          skills.map((skill) => <SkillCard key={skill.id} skill={skill} />)
        )}
      </div>
    </>
  );
}

function SkillCard({ skill }: { readonly skill: SkillDto }) {
  return (
    <Link
      to="/skills/$skillId"
      params={{ skillId: skill.id }}
      className="rounded-2xl bg-card p-5 no-underline shadow-sm transition-shadow hover:shadow-md"
    >
      <div className="flex items-center justify-between gap-4">
        <p className="font-sans text-sm font-medium text-foreground">{skill.name}</p>
        <p className="font-mono text-xs text-faint">
          {skill.fileCount} file{skill.fileCount === 1 ? "" : "s"} · {formatSkillBytes(skill.bytes)}
        </p>
      </div>
      {skill.description !== "" && (
        <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{skill.description}</p>
      )}
    </Link>
  );
}

const SKILL_MD_TEMPLATE = `---
name: my-skill
description: One line saying when an agent should reach for this.
---

Instructions the agent loads when the skill applies.
`;

function CreateSkillForm({
  scope,
  projectId,
}: {
  readonly scope: SkillScopeDto;
  readonly projectId: string | null;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [contents, setContents] = useState(SKILL_MD_TEMPLATE);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (name === "") return;
    setPending(true);
    setError(null);
    try {
      await createSkill({
        scope,
        projectId,
        name,
        description,
        files: [{ path: "SKILL.md", contents }],
      });
      await queryClient.invalidateQueries(trpc.skills.pathFilter());
      setOpen(false);
      setName("");
      setDescription("");
      setContents(SKILL_MD_TEMPLATE);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setPending(false);
    }
  };

  if (!open) {
    return (
      <div className="mt-7">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-xl border border-border bg-card px-4 py-2 font-sans text-sm font-medium text-foreground shadow-xs transition-shadow hover:shadow-sm"
        >
          New skill
        </button>
      </div>
    );
  }

  return (
    <div className="mt-7 rounded-2xl bg-card p-5 shadow-sm">
      <p className="text-xs font-medium text-label">New skill</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          value={name}
          onChange={(event) => setName(event.target.value.toLowerCase())}
          placeholder="name (lowercase, dashes — becomes the directory name)"
          className="min-w-64 flex-1 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint"
        />
      </div>
      <input
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        placeholder="description — when should an agent reach for this?"
        className="mt-3 w-full rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground placeholder:text-faint"
      />
      <textarea
        value={contents}
        onChange={(event) => setContents(event.target.value)}
        rows={10}
        spellCheck={false}
        className="mt-3 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground"
      />
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={pending || name === ""}
          onClick={() => void submit()}
          className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
        >
          {pending ? "Creating…" : "Create"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="font-sans text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>
      {error !== null && (
        <p className="mt-3 border-l-2 border-[var(--sw-red)] pl-2 font-mono text-xs text-danger">
          {error}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        The bundle starts as one SKILL.md; support files can be added on the skill&apos;s page.
      </p>
    </div>
  );
}

export const formatSkillBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes}B` : `${(bytes / 1024).toFixed(1)}KB`;

/** The project rail's pointer into the project's skill library. */
export function ProjectSkillsCard({ projectId }: { readonly projectId: string }) {
  const trpc = useTRPC();
  const skills = useQuery(trpc.skills.forProject.queryOptions({ id: projectId })).data;
  return (
    <section className="rounded-2xl bg-panel shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between border-b border-rule-faint px-5 pt-4 pb-3">
        <p className="font-sans text-sm font-medium text-foreground">Skills</p>
        <Link
          to="/projects/$projectId/configuration"
          params={{ projectId }}
          hash="skills"
          className="font-sans text-xs font-medium text-muted-foreground no-underline transition-colors hover:text-foreground"
        >
          Open →
        </Link>
      </div>
      <p className="px-5 py-3 font-mono text-xs text-ink-2">
        {skills === undefined
          ? "…"
          : skills.length === 0
            ? "none"
            : `${skills.length} project · delivered at launch`}
      </p>
    </section>
  );
}
