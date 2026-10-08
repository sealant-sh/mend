import { REPLACE_WORKSPACE_ACTION } from "@mend/domain/workbench";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { refusalWords, replaceWorkspace, type LivePersonDto } from "#/lib/api";
import { queryClient } from "#/lib/queries";
import {
  retirementViewOf,
  sharedWorkspaceLineOf,
  workspaceRetirementQuery,
} from "#/lib/shared-workspace";
import { membersQuery } from "#/lib/viewer";

/**
 * Two facts about the session's workspace, each a strip under the header (docs/adr/0016,
 * decisions 13 and 14): who else is live in it ("Shared workspace with Anna · …"), and an executor
 * started before per-person homes waiting to be replaced, with "Replace this workspace now" and
 * what would stop for the change's owner. Nothing shows when neither applies.
 */
export function WorkspaceFacts({
  sessionId,
  livePeople,
  viewerId,
}: {
  readonly sessionId: string;
  /** From the session's own view; a project list's row carries none. */
  readonly livePeople: ReadonlyArray<LivePersonDto> | undefined;
  readonly viewerId: string | null;
}) {
  const retirementRead = useQuery(workspaceRetirementQuery(sessionId));
  const members = useQuery(membersQuery);
  const names = useMemo(
    () => new Map((members.data ?? []).map((member) => [member.userId, member.name])),
    [members.data],
  );
  const replace = useMutation({
    mutationFn: () => replaceWorkspace(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["session", sessionId] }),
  });
  const shared = sharedWorkspaceLineOf(livePeople, viewerId);
  const retirement = retirementViewOf(retirementRead.data, names);
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
                onClick={() => {
                  if (
                    window.confirm(`${REPLACE_WORKSPACE_ACTION}?\n\n${retirement.stops.join("\n")}`)
                  )
                    replace.mutate();
                }}
                className="shrink-0 font-sans text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {replace.isPending ? "Replacing…" : REPLACE_WORKSPACE_ACTION}
              </button>
            )}
          </div>
          {retirement.stops.length > 0 && (
            <ul className="flex flex-col font-mono text-[11.5px] text-faint">
              {retirement.stops.map((stop) => (
                <li key={stop}>{stop}</li>
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
    </>
  );
}
