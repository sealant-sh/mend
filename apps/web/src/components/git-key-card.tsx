import { useState } from "react";

import { copyText } from "#/lib/workbench-menus";

/** `owner/repo` for a GitHub origin (https or ssh), else null. */
export function githubRepoOf(originUrl: string | null): string | null {
  if (originUrl === null) return null;
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      originUrl,
    );
  return match?.[1] ?? null;
}

/**
 * Your Mend key — the public half with a copy affordance and where to add it.
 * The private key never reaches the browser; there is deliberately nothing
 * else to show (docs/GIT-ACCESS.md). The recommendation is the account: one
 * key for every repository you can reach, working from detached sessions and
 * the phone. A deploy key on one repository is the scoped alternative.
 */
export function GitKeyCard({
  gitKey,
  originUrl = null,
}: {
  readonly gitKey: { readonly publicKey: string | null; readonly fingerprint: string | null };
  /** The project's origin, when the card sits on a project: names the deploy-key page. */
  readonly originUrl?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  if (gitKey.publicKey === null) return null;
  const publicKey = gitKey.publicKey;
  const repo = githubRepoOf(originUrl);

  const copy = () => {
    copyText(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    // `min-w-0` and a wrapping key: a key is one long word, and it must never widen its dialog.
    <div className="group min-w-0">
      <button
        type="button"
        onClick={copy}
        title="Copy public key"
        className="block w-full min-w-0 rounded-lg border border-rule bg-card p-2.5 text-left font-mono text-[11px] leading-relaxed break-all whitespace-normal text-ink-2 transition-colors hover:border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)]"
      >
        {publicKey}
      </button>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        {gitKey.fingerprint === null ? (
          <span />
        ) : (
          <p className="min-w-0 truncate font-mono text-[11px] text-faint">{gitKey.fingerprint}</p>
        )}
        <button
          type="button"
          onClick={copy}
          className={`shrink-0 font-sans text-xs transition-opacity ${
            copied
              ? "text-success opacity-100"
              : "text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-ink focus-visible:opacity-100"
          }`}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Add it to your git account&apos;s SSH keys
        {" ("}
        <a
          href="https://github.com/settings/ssh/new"
          target="_blank"
          rel="noreferrer"
          className="text-ink-2 underline decoration-rule underline-offset-2 hover:text-ink"
        >
          GitHub
        </a>
        {") and every repository you can reach works, from detached sessions and the phone too."}{" "}
        For one repository only, add it as that repository&apos;s deploy key
        {repo === null ? (
          " instead"
        ) : (
          <>
            {" "}
            (
            <a
              href={`https://github.com/${repo}/settings/keys/new`}
              target="_blank"
              rel="noreferrer"
              className="text-ink-2 underline decoration-rule underline-offset-2 hover:text-ink"
            >
              {repo}
            </a>
            ) instead
          </>
        )}
        ; grant write access if sessions should push.
      </p>
    </div>
  );
}
