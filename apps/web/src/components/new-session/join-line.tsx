import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { UsersIcon } from "lucide-react";

import { worktreeJoinLine } from "#/lib/shared-workspace";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

/**
 * The join line (`join-line`, ADR 0026 decision 7, ADR 0016 decision 13), before a session starts
 * in a workspace where someone else's session runs: the workspace is shared, the new session runs
 * as the person starting it, on their own logins and Git identity (`runs-as-yourself`), and either
 * person can read the other's files. The words are the domain's; nobody else's session there, or a
 * project not read yet, shows nothing. A project that didn't read says so, since the line is a
 * warning a person should see before they start.
 */
export function JoinLine({
  projectId,
  worktreeId,
  className,
}: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly className?: string;
}) {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const detail = useQuery(trpc.projects.detail.queryOptions({ id: projectId }));
  if (detail.isPending) return null;
  if (detail.isError)
    return (
      <p className={cn("text-meta text-muted-foreground", className)}>
        Mend couldn't read who else works in this workspace.{" "}
        <button
          type="button"
          className="font-medium text-primary hover:underline"
          onClick={() => void detail.refetch()}
        >
          {detail.isRefetching ? "Trying again…" : "Try again"}
        </button>
      </p>
    );
  const line = worktreeJoinLine(detail.data.sessions, worktreeId, viewer.userId);
  if (line === null) return null;
  return (
    <p className={cn("flex items-start gap-2 text-meta text-muted-foreground", className)}>
      <UsersIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span>{line}</span>
    </p>
  );
}
