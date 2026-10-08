import { REPLACE_WORKSPACE_ACTION } from "@mend/domain/workbench";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mend/ui/components/ui/alert-dialog";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { refusalWords, replaceWorkspace, type SessionDto } from "#/lib/api";
import { queryClient } from "#/lib/queries";
import {
  keyedLines,
  readsRetirement,
  retirementViewOf,
  sharedWorkspaceLineOf,
  workspaceRetirementQuery,
  type RetirementView,
} from "#/lib/shared-workspace";
import { membersQuery } from "#/lib/viewer";

/**
 * Two facts about the session's workspace, each a strip under the header (docs/adr/0016,
 * decisions 13 and 14): who else is live in it ("Shared workspace with Anna · …"), and an executor
 * started before per-person homes waiting to be replaced, with "Replace this workspace now" and
 * what would stop for the change's owner. Nothing shows when neither applies, and the retirement
 * is read only while the session's own view says its executor waits to be replaced.
 */
export function WorkspaceFacts({
  sessionId,
  session,
  viewerId,
}: {
  readonly sessionId: string;
  /**
   * The session's own view (`GET /api/sessions/:id`): a project list's row carries no
   * `livePeople` and no `workspaceRetirement`. Undefined until it answers.
   */
  readonly session: SessionDto | undefined;
  readonly viewerId: string | null;
}) {
  const retiring = readsRetirement(session);
  const retirementRead = useQuery(workspaceRetirementQuery(sessionId, retiring));
  const members = useQuery(membersQuery);
  const names = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.userId, member.name])),
    [members.data],
  );
  // What the owner was asked about: its lines, and the fingerprint of the read they came from.
  const [confirming, setConfirming] = useState<RetirementView | null>(null);
  const replace = useMutation({
    mutationFn: (seen: string) => replaceWorkspace(sessionId, seen),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
  });
  const shared = sharedWorkspaceLineOf(session?.livePeople, viewerId);
  const retirement = retiring ? retirementViewOf(retirementRead.data, names) : null;
  if (shared === null && retirement === null) return null;

  return (
    <>
      {shared !== null && (
        <div className="flex h-7 shrink-0 items-center border-b border-rule-faint bg-background px-3">
          <span className="truncate font-sans text-[12.5px] text-ink-2" title={shared}>
            {shared}
          </span>
        </div>
      )}
      {retirement !== null && (
        <div className="flex shrink-0 flex-col gap-1 border-b border-rule-faint bg-background px-3 py-1.5">
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 font-sans text-[12.5px] text-ink-2">
              {retirement.line}
            </span>
            {retirement.canReplace && (
              <button
                type="button"
                disabled={replace.isPending}
                onClick={() => setConfirming(retirement)}
                className="shrink-0 font-sans text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {replace.isPending ? "Replacing…" : REPLACE_WORKSPACE_ACTION}
              </button>
            )}
          </div>
          {retirement.stops.length > 0 && (
            <ul className="flex flex-col font-mono text-[11.5px] text-faint">
              {keyedLines(retirement.stops).map(({ key, line }) => (
                <li key={key}>{line}</li>
              ))}
            </ul>
          )}
          {replace.isError && (
            <span className="font-mono text-[11.5px] text-danger">
              {refusalWords(replace.error, "the workspace was not replaced")}
            </span>
          )}
        </div>
      )}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{REPLACE_WORKSPACE_ACTION}?</AlertDialogTitle>
            {/* What would stop, from the read whose fingerprint the replacement sends. */}
            <AlertDialogDescription
              render={<div />}
              className="flex flex-col gap-0.5 font-mono text-[11.5px]"
            >
              {keyedLines(confirming?.stops ?? []).map(({ key, line }) => (
                <span key={key}>{line}</span>
              ))}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming !== null) replace.mutate(confirming.seen);
                setConfirming(null);
              }}
            >
              {REPLACE_WORKSPACE_ACTION}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
