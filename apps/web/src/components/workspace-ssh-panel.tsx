import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  removeWorkspaceSshKey,
  stopSession,
  stopSessionServices,
  type WorkspaceSshKeyDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

const QUIET_BUTTON =
  "font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60";

type RemovedKey = Awaited<ReturnType<typeof removeWorkspaceSshKey>>;

/** What removing a key did to the connections already open with it. */
const removalLine = (removed: RemovedKey): string =>
  removed.openConnections === "end"
    ? `removed ${removed.fingerprint} · the gateway refuses it from the next connection and ends the connections open with it within a minute`
    : `removed ${removed.fingerprint} · the gateway refuses it from the next connection · connections already open with it stay open until you stop your running sessions${removed.runningSessions.length === 0 ? " · none of yours is running" : ""}`;

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
  // The caller's running sessions a removal named, on a platform that keeps open connections.
  const [toStop, setToStop] = useState<RemovedKey["runningSessions"]>([]);
  const [stopping, setStopping] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);

  const remove = (key: WorkspaceSshKeyDto) => {
    setBusy(key.sshKeyId);
    setSaid(null);
    setError(null);
    setToStop([]);
    setConfirmingStop(false);
    void removeWorkspaceSshKey(key.sshKeyId)
      .then((removed) => {
        setConfirming(null);
        setSaid(removalLine(removed));
        setToStop(removed.openConnections === "stay" ? removed.runningSessions : []);
        return queryClient.invalidateQueries(trpc.platform.workspaceSsh.queryFilter());
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  // Each session's agent and its Services: a Service still running keeps the workspace up.
  const stopRunning = () => {
    setStopping(true);
    setError(null);
    void Promise.allSettled(
      toStop.map((session) =>
        stopSession(session.sessionId).then(() => stopSessionServices(session.sessionId)),
      ),
    )
      .then((results) => {
        const failed = results.filter((result) => result.status === "rejected").length;
        const stopped = results.length - failed;
        setToStop([]);
        setSaid(
          `stopped ${stopped} of ${results.length} sessions · their workspaces close, and the connections into them end, once nothing in them is live`,
        );
        if (failed > 0)
          setError(`${failed} could not be stopped · stop them from the session page`);
        return undefined;
      })
      .finally(() => {
        setStopping(false);
        setConfirmingStop(false);
      });
  };

  return (
    <section id="workspace-ssh" className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <h2 className="font-sans text-sm font-semibold">Workspace SSH</h2>
      <p className="mt-1 max-w-[62ch] text-[13px] leading-relaxed text-muted-foreground">
        Keys that open your workspaces over SSH, for VS Code Remote-SSH or plain{" "}
        <span className="font-mono text-[12px]">ssh</span>. A machine registers its key with{" "}
        <span className="font-mono text-[12px]">mend ssh setup</span>. The gateway looks a key up on
        every new connection, so a removed key is refused from the next one; removing it says what
        happens to connections already open. Yours alone.
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
        {toStop.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-3">
            {confirmingStop ? (
              <>
                <button
                  type="button"
                  disabled={stopping}
                  onClick={stopRunning}
                  className="font-sans text-xs font-medium text-danger transition-opacity hover:opacity-80 disabled:opacity-60"
                >
                  {stopping ? "Stopping…" : "Confirm stop"}
                </button>
                <button
                  type="button"
                  disabled={stopping}
                  onClick={() => setConfirmingStop(false)}
                  className={QUIET_BUTTON}
                >
                  Cancel
                </button>
                <span className="font-mono text-[12px] text-label">
                  stops each one&apos;s agent and Services · the record and the review remain
                </span>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingStop(true)}
                className={QUIET_BUTTON}
              >
                {`Stop ${toStop.length} running ${toStop.length === 1 ? "session" : "sessions"}…`}
              </button>
            )}
            <span className="truncate font-mono text-[12px] text-label">
              {toStop.map((session) => session.label ?? session.sessionId).join(" · ")}
            </span>
          </div>
        )}
        {error === null ? null : (
          <p className="font-mono text-[12.5px] text-warning" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
