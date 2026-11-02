import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { GitKeyCard } from "#/components/git-key-card";
import { initGitKey, setGitAccess, type GitAccessModeDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const CHOICES: ReadonlyArray<{
  readonly value: GitAccessModeDto;
  readonly label: string;
  readonly detail: string;
}> = [
  {
    value: "mend-key",
    label: "A Mend key on your git account",
    detail:
      "Your own key, created on the server and never copied. Works whenever the server is up: detached sessions, the phone, the hot pool. Recommended.",
  },
  {
    value: "bridge",
    label: "Your machine's key",
    detail:
      "The server signs through the ssh-agent on your machine, so a hardware key never leaves your desk. Only while a mend command is running there.",
  },
];

/**
 * The one question about git access, asked once (first run) and kept in
 * Settings: does Mend reach your repositories with a key of yours held on the
 * server, or with the key on your machine? New projects adopt with the
 * answer; a project's Configuration page can override it. The facts beside it are
 * observations — the key to add, the signer's presence — never a judgment.
 */
export function GitAccessPanel({ compact = false }: { readonly compact?: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const access = useQuery(
    trpc.git.access.queryOptions(undefined, {
      refetchInterval: (query) => (query.state.data?.mode === "bridge" ? 5_000 : false),
    }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries(trpc.git.pathFilter());
  const choose = (mode: GitAccessModeDto) => {
    if (busy || access.data?.mode === mode) return;
    setBusy(true);
    setError(null);
    void setGitAccess(mode)
      .then(refresh)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const createKey = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void initGitKey()
      .then(refresh)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  if (access.data === undefined) return null;
  const { mode, key, bridge } = access.data;

  return (
    <div>
      <div className={compact ? "grid gap-2 sm:grid-cols-2" : "mt-4 grid gap-2 sm:grid-cols-2"}>
        {CHOICES.map((choice) => {
          const selected = mode === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              disabled={busy}
              onClick={() => choose(choice.value)}
              className={`rounded-xl border p-3 text-left shadow-xs transition-colors disabled:opacity-60 ${
                selected
                  ? "border-[color-mix(in_oklab,var(--sw-accent)_45%,transparent)] bg-wash"
                  : "border-border bg-card hover:border-input"
              }`}
            >
              <span className="block font-sans text-sm font-medium text-foreground">
                {choice.label}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {choice.detail}
              </span>
            </button>
          );
        })}
      </div>
      {error !== null && (
        <p className="mt-3 border-l-2 border-[var(--sw-red)] pl-2 text-xs text-danger">{error}</p>
      )}
      {mode === "mend-key" && (
        <div className="mt-3">
          {key.exists ? (
            <GitKeyCard gitKey={key} />
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={createKey}
              className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-xs font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-opacity disabled:opacity-50"
            >
              Create my Mend key
            </button>
          )}
        </div>
      )}
      {mode === "bridge" && (
        <div className="mt-3">
          <p className="flex items-center gap-2 font-mono text-xs">
            <span
              className={`inline-block size-2 rounded-full ${
                bridge.connected ? "bg-[var(--sw-green-dot)]" : "border-[1.5px] border-[#b3b0a8]"
              }`}
            />
            <span className={bridge.connected ? "text-ink-2" : "text-faint"}>
              {bridge.connected
                ? `signer connected · ${bridge.clientName ?? "unknown machine"}`
                : "no signer connected"}
            </span>
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Any attaching <span className="font-mono">mend</span> command and the dashboard share
            your machine&apos;s agent while they run. Until one does, git for bridge projects waits
            for no one: the base is not fetched, and pushes fail readably.
          </p>
        </div>
      )}
    </div>
  );
}
