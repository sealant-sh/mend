import { repositoryCloneUrlIssue } from "@mend/domain/workbench";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { GitKeyCard } from "#/components/git-key-card";
import { ScopePicker } from "#/components/scope-picker";
import {
  adoptProject,
  initGitKey,
  type GitAuthModeDto,
  type GitKeyDto,
  type ProjectScopeRequestDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * Adoption: a cloneable Git URL, an optional name, and the git
 * access this clone should use. It is the page's one consequential action but
 * a rare one, so the index keeps it behind a quiet toggle rather than putting
 * a form above every project.
 */
export function AdoptPanel({ onAdopted }: { readonly onAdopted: () => void }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  // The user's git access (Settings) is the default; the row below overrides it for this adopt.
  const access = useQuery(trpc.git.access.queryOptions()).data;
  const [authOverride, setAuthOverride] = useState<GitAuthModeDto | null>(null);
  const auth: GitAuthModeDto = authOverride ?? access?.mode ?? "mend-key";
  const [createdKey, setCreatedKey] = useState<GitKeyDto | null>(null);
  const gitKey = createdKey ?? (access?.key.exists === true ? access.key : null);
  // Where the project is visible (docs/adr/0002): the caller's own by default.
  const teams = useQuery(trpc.teams.list.queryOptions()).data ?? [];
  const [scope, setScope] = useState<ProjectScopeRequestDto>({ kind: "personal" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const trimmedSource = source.trim();
  const sourceIssue = trimmedSource === "" ? null : repositoryCloneUrlIssue(trimmedSource);
  const displayedError = error ?? sourceIssue;

  const submit = async () => {
    if (trimmedSource === "" || pending) return;
    if (sourceIssue !== null) {
      setError(sourceIssue);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await adoptProject(name === "" ? inferName(trimmedSource) : name, trimmedSource, auth, scope);
      await queryClient.invalidateQueries(trpc.projects.pathFilter());
      setName("");
      setSource("");
      onAdopted();
    } catch (adoptError) {
      setError(adoptError instanceof Error ? adoptError.message : String(adoptError));
    } finally {
      setPending(false);
    }
  };

  // Choosing the Mend key generates it up front: the public key must be on
  // the git host before a private clone can succeed, so show it now.
  const chooseAuth = (mode: GitAuthModeDto) => {
    setAuthOverride(mode);
    setError(null);
    if (mode !== "mend-key" || gitKey !== null) return;
    initGitKey()
      .then(setCreatedKey)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="rounded-2xl bg-card p-5 shadow-sm"
    >
      <p className="text-xs font-medium text-label">Adopt a repository</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          value={source}
          onChange={(event) => {
            setSource(event.target.value);
            setError(null);
          }}
          aria-label="Repository Git URL"
          placeholder="Git URL (HTTP(S), SSH, or git@host:owner/repo.git)"
          className="w-full min-w-0 flex-1 basis-64 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint"
        />
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Project name (optional)"
          placeholder="name (optional)"
          className="w-40 rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-faint"
        />
        <button
          type="submit"
          disabled={pending || trimmedSource === "" || sourceIssue !== null}
          className="rounded-xl bg-primary px-4 py-2 font-sans text-sm font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
        >
          {pending ? "Adopting…" : "Adopt"}
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-label">git access:</span>
        {(["mend-key", "bridge", "ambient"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={auth === mode}
            onClick={() => chooseAuth(mode)}
            className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition-colors ${
              auth === mode
                ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash text-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground"
            }`}
          >
            {mode === "mend-key" ? "mend key" : mode}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-label">visible to:</span>
        <ScopePicker value={scope} onChange={setScope} teams={teams} />
      </div>
      {auth === "mend-key" && gitKey !== null && (
        <div className="mt-3 max-w-[560px]">
          <GitKeyCard gitKey={gitKey} />
        </div>
      )}
      {displayedError !== null && (
        <p
          role="alert"
          className="mt-3 border-l-2 border-[var(--sw-red)] pl-2 font-mono text-xs text-danger"
        >
          {displayedError}
        </p>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Cloned into the store; your existing checkout is never the execution target.
      </p>
    </form>
  );
}

const inferName = (source: string) => {
  const trimmed = source.replace(/\/+$/, "").replace(/\.git$/, "");
  return trimmed.split("/").at(-1) ?? trimmed;
};
