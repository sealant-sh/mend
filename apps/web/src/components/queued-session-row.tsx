import { Lump } from "@mend/ui/components/lump";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { SidebarMenuItem } from "@mend/ui/components/ui/sidebar";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { EllipsisIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { adoptionProgressOptions, useAdoptionAttempt } from "#/lib/adoptions";
import { age, type QueuedRow } from "#/lib/inbox";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

/**
 * A session started while its project clones, in the inbox before it is a session: under Running
 * while it waits ("Waiting for the clone"), under To review in red with why once it failed. It
 * has no page yet, so the row opens nothing. Its × cancels it; a failed one with somewhere to start
 * has a "…" with Start again and Cancel: in its project when the clone worked and the start failed,
 * or on a new clone of the project this browser is running.
 */

type Target = { readonly projectId: string } | { readonly adoptionId: string };

/** Where a failed one can start again, if anywhere. */
const useStartAgain = (row: QueuedRow): Target | null => {
  const trpc = useTRPC();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const projects = useQuery(trpc.projects.list.queryOptions());
  const attempt = useAdoptionAttempt(viewer.userId);
  const progress = useQuery({
    ...adoptionProgressOptions(trpc, attempt?.id ?? ""),
    enabled: attempt !== null && row.failure?.step === "clone",
  });
  if (row.failure === null) return null;
  if (row.failure.step === "start") {
    if (projects.isPending || projects.isError) return null;
    const project = projects.data.find((each) => each.name === row.projectName);
    return project === undefined ? null : { projectId: project.id };
  }
  if (progress.isPending || progress.isError) return null;
  return attempt !== null && attempt.name === row.projectName && progress.data?.state === "running"
    ? { adoptionId: attempt.id }
    : null;
};

/**
 * The row's actions: Cancel as its own button while it is the only one (a "…" for one item was a
 * menu for nothing, SLNT-1229); a "…" with Start again and Cancel once a failed one has somewhere
 * to start.
 */
function QueuedActions({
  row,
  size,
  onFailure,
}: {
  readonly row: QueuedRow;
  readonly size: "default" | "touch";
  readonly onFailure: (message: string | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const target = useStartAgain(row);
  const reread = () =>
    queryClient.invalidateQueries({ queryKey: trpc.queuedSessions.list.queryKey() });
  const fail = (what: string) => (error: unknown) =>
    onFailure(`${what} ${error instanceof Error ? error.message : ""}`.trim());
  const cancel = useMutation(
    trpc.queuedSessions.cancel.mutationOptions({
      onMutate: () => onFailure(null),
      onSuccess: reread,
      onError: fail("It wasn't cancelled."),
    }),
  );
  const start = useMutation(
    trpc.queuedSessions.start.mutationOptions({
      onMutate: () => onFailure(null),
      onSuccess: reread,
      onError: fail("It didn't start again."),
    }),
  );
  const busy = cancel.isPending || start.isPending;
  const iconSize = size === "touch" ? "icon-touch" : "icon-sm";
  if (target === null)
    return (
      <Button
        type="button"
        variant="ghost"
        size={iconSize}
        aria-label={`Cancel ${row.title}`}
        title="Cancel session"
        disabled={busy}
        className="text-muted-foreground hover:text-destructive"
        onClick={() => cancel.mutate({ id: row.id })}
      >
        <XIcon aria-hidden />
      </Button>
    );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size={iconSize}
            aria-label={`Actions for ${row.title}`}
            disabled={busy}
            className="text-muted-foreground"
          >
            <EllipsisIcon aria-hidden />
          </Button>
        }
      />
      <DropdownMenuContent align="end" width="sm">
        {target === null ? null : (
          <DropdownMenuItem onClick={() => start.mutate({ id: row.id, target })}>
            Start again
          </DropdownMenuItem>
        )}
        <DropdownMenuItem variant="destructive" onClick={() => cancel.mutate({ id: row.id })}>
          Cancel session
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The line under the title: project, status (red when it failed) and age. */
function MetaLine({ row, now }: { readonly row: QueuedRow; readonly now: Date }) {
  return (
    <>
      {row.projectName} ·{" "}
      <span className={cn(row.status.failed && "text-destructive")}>{row.status.word}</span> ·{" "}
      {age(row.at, now)}
    </>
  );
}

/** The sidebar's row: the session row's look, with its "…" always there. */
export function QueuedSidebarRow({ row, now }: { readonly row: QueuedRow; readonly now: Date }) {
  // What went wrong with the person's last cancel or start again, shown on the row.
  const [failure, onFailure] = useState<string | null>(null);
  const note = failure ?? row.failure?.message ?? null;
  return (
    <SidebarMenuItem className="relative" data-queued-session-id={row.id}>
      <div className="relative rounded-lg pt-1.5 pr-9 pb-1.75 pl-6 leading-snug">
        <Lump status={row.lump} className="absolute top-2.25 left-1.5 size-3.5" />
        <span className="block truncate text-row text-foreground opacity-86">{row.title}</span>
        <span className="mt-px block truncate text-meta text-muted-foreground">
          <MetaLine row={row} now={now} />
        </span>
        {note === null ? null : (
          <span className="mt-px line-clamp-2 text-meta text-muted-foreground" title={note}>
            {note}
          </span>
        )}
      </div>
      <span className="absolute top-1 right-1.5">
        <QueuedActions row={row} size="default" onFailure={onFailure} />
      </span>
    </SidebarMenuItem>
  );
}

/** The phone inbox's row: the touch session row's look, with a 44px "…". */
export function QueuedPhoneRow({ row, now }: { readonly row: QueuedRow; readonly now: Date }) {
  // What went wrong with the person's last cancel or start again, shown on the row.
  const [failure, onFailure] = useState<string | null>(null);
  const note = failure ?? row.failure?.message ?? null;
  return (
    <li
      className="flex items-start gap-3 border-b border-border py-3 pr-1 pl-4"
      data-queued-session-id={row.id}
    >
      <Lump status={row.lump} className="mt-0.75 size-4" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
          <span className="min-w-0 truncate text-row font-medium text-foreground">{row.title}</span>
          <span className="shrink-0 text-meta whitespace-nowrap text-muted-foreground">
            {row.projectName}
          </span>
        </span>
        <span
          className={cn(
            "mt-0.5 block text-meta",
            row.status.failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {row.status.word}
        </span>
        {note === null ? null : (
          <span className="mt-0.5 line-clamp-3 text-meta text-muted-foreground" title={note}>
            {note}
          </span>
        )}
      </span>
      <span className="mt-0.5 shrink-0 text-meta text-muted-foreground tabular-nums">
        {age(row.at, now)}
      </span>
      <QueuedActions row={row} size="touch" onFailure={onFailure} />
    </li>
  );
}
