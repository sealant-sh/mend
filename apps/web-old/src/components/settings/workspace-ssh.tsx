import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { ModalClose, ModalDialog } from "#/components/kit/modal";
import { FoldSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type { WorkspaceSshKeyDto } from "#/lib/api";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** A list longer than this starts folded. */
const FOLD_AFTER = 5;

interface RemovedKey {
  readonly fingerprint: string;
  readonly openConnections: "end" | "stay";
  readonly runningSessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly label: string | null;
  }>;
}

/** What removing a key did to the connections already open with it. */
export const removalLine = (removed: RemovedKey): string =>
  removed.openConnections === "end"
    ? `removed ${removed.fingerprint} · the gateway refuses it from the next connection and ends the connections open with it within a minute`
    : `removed ${removed.fingerprint} · the gateway refuses it from the next connection · connections already open with it stay open until you stop your running sessions${removed.runningSessions.length === 0 ? " · none of yours is running" : ""}`;

const dayOf = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/**
 * Workspace SSH (docs/WORKSPACE-SSH.md): the keys the workspace SSH gateway accepts for this
 * person, from every machine that ran `mend ssh setup`. Read on its own, so a platform that cannot
 * answer leaves the rest of the tab standing.
 */
export function WorkspaceSshSection() {
  const trpc = useTRPC();
  const view = useQuery(trpc.platform.workspaceSsh.queryOptions());
  const [confirming, setConfirming] = useState<WorkspaceSshKeyDto | null>(null);
  const remove = useMutation(
    trpc.platform.removeWorkspaceSshKey.mutationOptions({
      onSuccess: (_removed, _variables, _result, { client }) => {
        setConfirming(null);
        return client.invalidateQueries(trpc.platform.workspaceSsh.queryFilter());
      },
    }),
  );
  const keys = view.data?.keys ?? [];

  return (
    <FoldSection
      title="Workspace SSH"
      count={view.isSuccess ? `${keys.length} ${keys.length === 1 ? "key" : "keys"}` : ""}
      why={
        <>
          Keys that can open a shell in your workspaces, for VS Code Remote-SSH or plain ssh. A
          computer registers its key with{" "}
          <code className="font-mono text-[12px]">mend ssh setup</code>.
        </>
      }
      summary={keys.map((key) => key.name).join(" · ") || "no keys registered"}
      defaultOpen={keys.length <= FOLD_AFTER}
    >
      {view.isError ? (
        <ErrorNote>{`Keys not read · ${errorText(view.error)}`}</ErrorNote>
      ) : (
        <>
          {view.data?.gateway === null ? (
            <p className="mb-1 px-4 font-mono text-[11.5px] text-faint">
              this deployment exposes no workspace SSH gateway
            </p>
          ) : null}
          <DataTable
            label="Workspace SSH keys"
            columns={[
              { head: "Key", width: "2fr" },
              { head: "Added", width: "0.6fr" },
              { head: "", width: "auto" },
            ]}
            rows={keys.map((key) => ({
              key: key.sshKeyId,
              cells: [
                <span key="key" className="grid">
                  <span className="font-mono text-[12px] text-ink-2">
                    {key.algorithm} · {key.name}
                  </span>
                  <span className="truncate font-mono text-[11px] text-faint">
                    {key.fingerprint}
                  </span>
                </span>,
                <span key="added" className="font-mono text-[12px] text-muted-foreground">
                  {dayOf(key.createdAt)}
                </span>,
                <Button
                  key="remove"
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove the key ${key.name}`}
                  onClick={() => {
                    remove.reset();
                    setConfirming(key);
                  }}
                >
                  Remove
                </Button>,
              ],
            }))}
            empty={view.isPending ? "reading keys…" : "no keys registered"}
          />
        </>
      )}
      {remove.data === undefined ? null : (
        <div className="mt-3 grid gap-2">
          <p role="status" className="px-4 font-mono text-[11.5px] text-muted-foreground">
            {removalLine(remove.data)}
          </p>
          {remove.data.openConnections === "stay" && remove.data.runningSessions.length > 0 ? (
            <StopRunning sessions={remove.data.runningSessions} />
          ) : null}
        </div>
      )}
      <ModalDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        width={460}
        title={confirming === null ? "" : `Remove ${confirming.name}?`}
        description="The gateway refuses this key from the next connection. Mend says what happens to connections already open with it."
        footer={
          <>
            <ModalClose render={<Button variant="ghost" disabled={remove.isPending} />}>
              Cancel
            </ModalClose>
            <Button
              variant="primary"
              disabled={remove.isPending || confirming === null}
              onClick={() => {
                if (confirming !== null) remove.mutate({ sshKeyId: confirming.sshKeyId });
              }}
            >
              {remove.isPending ? "Removing…" : "Remove key"}
            </Button>
          </>
        }
      >
        {confirming === null ? null : (
          <p className="font-mono text-[12px] break-all text-ink-2">{confirming.fingerprint}</p>
        )}
        {remove.error === null ? null : <ErrorNote>{errorText(remove.error)}</ErrorNote>}
      </ModalDialog>
    </FoldSection>
  );
}

/**
 * On a platform that keeps open connections, the person's running sessions a removal named:
 * stopping them closes their workspaces, which ends the connections into them. Each session's
 * Services stop too, since a running Service keeps its workspace up.
 */
function StopRunning({ sessions }: { readonly sessions: RemovedKey["runningSessions"] }) {
  const client = useTRPCClient();
  const [confirming, setConfirming] = useState(false);
  const stop = useMutation({
    mutationFn: async () => {
      const results = await Promise.allSettled(
        sessions.map(async (session) => {
          await client.sessions.stop.mutate({ id: session.sessionId });
          await client.sessions.stopServices.mutate({ id: session.sessionId });
        }),
      );
      const failed = results.filter((result) => result.status === "rejected").length;
      if (failed > 0) {
        throw new Error(
          `${failed} of ${results.length} could not be stopped · stop them from the session page`,
        );
      }
      return results.length;
    },
    onSettled: () => setConfirming(false),
  });
  const names = sessions.map((session) => session.label ?? session.sessionId).join(" · ");
  if (stop.isSuccess) {
    return (
      <p role="status" className="px-4 font-mono text-[11.5px] text-muted-foreground">
        stopped {stop.data} · their workspaces close, and the connections into them end, once
        nothing in them is live
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 px-4">
      {confirming ? (
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            {stop.isPending ? "Stopping…" : "Stop them"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={stop.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
          <span className="font-mono text-[11.5px] text-faint">
            stops each one&apos;s agent and Services · the record and the review remain
          </span>
        </>
      ) : (
        <Button size="sm" onClick={() => setConfirming(true)}>
          {`Stop ${sessions.length} running ${sessions.length === 1 ? "session" : "sessions"}…`}
        </Button>
      )}
      <span className="min-w-0 truncate font-mono text-[11.5px] text-faint">{names}</span>
      {stop.error === null ? null : (
        <ErrorNote className="basis-full">{errorText(stop.error)}</ErrorNote>
      )}
    </div>
  );
}
