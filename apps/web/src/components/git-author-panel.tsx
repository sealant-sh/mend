import { gitAuthorIssue, normalizeGitAuthor } from "@mend/domain/workbench";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";

import { clearGitAuthor, setGitAuthor, type GitAuthorDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const INPUT =
  "mt-1.5 w-full rounded-xl border border-input bg-card px-3.5 py-2.5 font-mono text-[12.5px] text-foreground outline-none transition-colors focus:border-[var(--sw-accent)] focus:ring-2 focus:ring-[color-mix(in_oklab,var(--sw-accent)_18%,transparent)] disabled:opacity-60";

/**
 * The account setting "Git author" (docs/GIT-ACCESS.md): the name and email the commits in this
 * account's workspaces name. Until saved, the account's own registration name and email apply.
 */
export function GitAuthorPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const author = useSuspenseQuery(trpc.git.author.queryOptions()).data;
  const [name, setName] = useState(author.name);
  const [email, setEmail] = useState(author.email);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft = normalizeGitAuthor({ name, email });
  const dirty = draft.name !== author.name || draft.email !== author.email;
  const issue = dirty ? gitAuthorIssue(draft) : null;

  const settle = (next: GitAuthorDto) => {
    queryClient.setQueryData(trpc.git.author.queryOptions().queryKey, next);
    setName(next.name);
    setEmail(next.email);
    setSaved(true);
  };
  const act = (work: () => Promise<GitAuthorDto>) => {
    setBusy(true);
    setSaved(false);
    setError(null);
    void work()
      .then(settle)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <section id="git-author" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Git author</h2>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        The name and email that commits made in your workspaces name. Written as system git config
        before the agent starts, so a <span className="font-mono text-xs text-ink-2">user</span>{" "}
        section in your dotfiles&apos;{" "}
        <span className="font-mono text-xs text-ink-2">.gitconfig</span> or in a repository&apos;s
        own config still decides. Applies to sessions launched from now on.
      </p>
      <div className="mt-5 grid gap-4 border-t border-[var(--sw-faint-rule)] pt-5 sm:grid-cols-2">
        <label className="block">
          <span className="font-sans text-[13px] font-medium text-foreground">Name</span>
          <input
            type="text"
            value={name}
            disabled={busy}
            spellCheck={false}
            autoComplete="name"
            onChange={(event) => {
              setSaved(false);
              setName(event.target.value);
            }}
            className={INPUT}
          />
        </label>
        <label className="block">
          <span className="font-sans text-[13px] font-medium text-foreground">Email</span>
          <input
            type="email"
            value={email}
            disabled={busy}
            spellCheck={false}
            autoComplete="email"
            onChange={(event) => {
              setSaved(false);
              setEmail(event.target.value);
            }}
            className={INPUT}
          />
        </label>
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <p className="font-mono text-xs text-faint">
          {saved
            ? "saved"
            : author.source === "setting"
              ? "your setting"
              : "your account's name and email · not set"}
        </p>
        <div className="flex items-center gap-3">
          {author.source === "setting" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => act(clearGitAuthor)}
              className="font-sans text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
            >
              Use my account&apos;s
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy || !dirty || issue !== null}
            onClick={() => act(() => setGitAuthor(draft.name, draft.email))}
            className="inline-flex min-h-9 shrink-0 items-center justify-center rounded-xl bg-primary px-4 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-transform hover:-translate-y-0.5 disabled:pointer-events-none disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save author"}
          </button>
        </div>
      </div>
      {issue === null && error === null ? null : (
        <p className="mt-4 border-l-2 border-danger pl-3 text-[13px] text-danger">
          {error ?? issue}
        </p>
      )}
    </section>
  );
}
