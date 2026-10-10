import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { removeWorkspaceSshKey, type WorkspaceSshKeyDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const QUIET_BUTTON =
  "font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60";

/**
 * The account setting "Workspace SSH" (docs/WORKSPACE-SSH.md): the keys the workspace SSH gateway
 * accepts for this account, from every machine that ran `mend ssh setup`, each removable. Read on
 * its own, so a platform that cannot answer leaves the rest of Settings standing.
 */
export function WorkspaceSshPanel() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const view = useQuery(trpc.platform.workspaceSsh.queryOptions());
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const remove = (key: WorkspaceSshKeyDto) => {
    setBusy(key.sshKeyId);
    setSaid(null);
    setError(null);
    void removeWorkspaceSshKey(key.sshKeyId)
      .then((removed) => {
        setConfirming(null);
        setSaid(`removed ${removed.fingerprint} · the gateway refuses it from the next connection`);
        return queryClient.invalidateQueries(trpc.platform.workspaceSsh.queryFilter());
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <section id="workspace-ssh" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Workspace SSH</h2>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-muted-foreground">
        Keys that open your workspaces over SSH, for VS Code Remote-SSH or plain{" "}
        <span className="font-mono text-[12px]">ssh</span>. A machine registers its key with{" "}
        <span className="font-mono text-[12px]">mend ssh setup</span>. The gateway looks a key up on
        every new connection, so a removed key is refused from the next one; a connection already
        open stays open until it ends. Yours alone.
      </p>

      <div className="mt-5 space-y-4 border-t border-[var(--sw-faint-rule)] pt-5">
        {view.isPending ? (
          <p className="font-mono text-[12px] text-label">reading keys…</p>
        ) : view.isError ? (
          <p className="font-mono text-[12.5px] text-warning" role="alert">
            keys not read · {view.error.message}
          </p>
        ) : (
          <>
            {view.data.gateway === null ? (
              <p className="font-mono text-[12px] text-label">
                this deployment exposes no workspace SSH gateway
              </p>
            ) : null}
            {view.data.keys.length === 0 ? (
              <p className="font-mono text-[12px] text-label">no keys registered</p>
            ) : (
              view.data.keys.map((key) => (
                <div key={key.sshKeyId} className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="font-sans text-sm font-medium text-foreground">{key.name}</p>
                    <p className="mt-1 truncate font-mono text-[12px] text-label">
                      {key.fingerprint} · {key.algorithm} · registered {key.createdAt.slice(0, 10)}
                    </p>
                  </div>
                  {confirming === key.sshKeyId ? (
                    <div className="flex shrink-0 items-center gap-3">
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => remove(key)}
                        className="font-sans text-xs font-medium text-danger transition-opacity hover:opacity-80 disabled:opacity-60"
                      >
                        {busy === key.sshKeyId ? "Removing…" : "Confirm remove"}
                      </button>
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => setConfirming(null)}
                        className={QUIET_BUTTON}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        setSaid(null);
                        setConfirming(key.sshKeyId);
                      }}
                      className={`${QUIET_BUTTON} shrink-0`}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))
            )}
          </>
        )}
        {said === null ? null : <p className="font-mono text-[12px] text-label">{said}</p>}
        {error === null ? null : (
          <p className="font-mono text-[12.5px] text-warning" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
