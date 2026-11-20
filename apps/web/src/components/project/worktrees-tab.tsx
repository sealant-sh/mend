import { Button } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mend/ui/components/ui/table";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitBranchIcon } from "lucide-react";
import { useState } from "react";

import type { ProjectDetailDto } from "#/lib/api";
import { inboxRows } from "#/lib/inbox";
import { inboxQuery } from "#/lib/inbox-live";
import { usePhone } from "#/lib/phone";
import { projectSessionRows } from "#/lib/project-sessions";
import {
  holdingSessions,
  lastActiveWords,
  phoneLine,
  type WorktreeChange,
  type WorktreeRow,
  worktreeRows,
} from "#/lib/project-worktrees";
import { sessionLink } from "#/lib/session-sheet";
import { worktreeJoinLine } from "#/lib/shared-workspace";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";
import { useMinute } from "#/lib/use-inbox";

import { SessionStatus } from "../session-status.tsx";
import { ClearFinished } from "./clear-finished.tsx";
import { NewWorktree } from "./new-worktree.tsx";
import { type RemovalWords, RemoveWorktree } from "./remove-worktree.tsx";
import { PhoneWorktreeActions, WorktreeMenu } from "./worktree-actions.tsx";

/** Where landed work lives, as the refusals name it. */
const remoteOf = (originUrl: string | null): string | null =>
  originUrl === null ? null : /github\.com/i.test(originUrl) ? "GitHub" : "origin";

/** One row's menu needs: the join line and the removal to open. */
interface RowEntry {
  readonly row: WorktreeRow;
  readonly joinLine: string | null;
}

/**
 * The Worktrees tab (Doop "Project · Worktrees" and its states): every worktree of the project
 * with its branch, the sessions in it and their status words, what landing did with its change,
 * and when it was last active, most recent first. New worktree… makes one; a row's "…" opens its
 * session or change, starts a session or a shell in it, copies its names, and removes it; Clear
 * finished… removes the worktrees where nothing runs or saves.
 */
export function WorktreesTab({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const phone = usePhone();
  const now = useMinute();
  const { project } = detail;
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const inbox = useQuery(inboxQuery(trpc));
  const membersRead = useQuery(trpc.organization.members.queryOptions());
  const [creating, setCreating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [removing, setRemoving] = useState<WorktreeRow | null>(null);
  // The inbox read names the sessions and says what their agents do; without it the rows still
  // list, with the project's own words.
  const inboxData = inbox.isPending || inbox.isError ? undefined : inbox.data;
  // A roster that failed to read again keeps the names it had; until then nobody is named.
  const members =
    membersRead.isPending || membersRead.isError ? (membersRead.data ?? []) : membersRead.data;
  const sessionRows = projectSessionRows(
    detail,
    inboxRows({
      rows: (inboxData ?? []).filter((row) => row.session.projectId === project.id),
      marks: [],
      now,
    }),
  );
  const names = new Map(members.map((member) => [member.userId, member.name]));
  const rows = worktreeRows(detail, sessionRows, holdingSessions(detail), names, viewer.userId);
  const entries: ReadonlyArray<RowEntry> = rows.map((row) => ({
    row,
    joinLine: worktreeJoinLine(detail.sessions, row.worktree.id, viewer.userId),
  }));
  const finished = rows.filter((row) => row.finished);
  const remote = remoteOf(project.originUrl);
  const wordsFor = (row: WorktreeRow | null): RemovalWords => {
    const owner = detail.worktrees.find(
      (worktree) => worktree.id === row?.worktree.id,
    )?.changeOwnerUserId;
    return {
      viewerId: viewer.userId,
      remote,
      sessionTitle: (id) => rows.flatMap((r) => r.sessions).find((s) => s.id === id)?.title ?? null,
      changeOwner:
        owner === null || owner === undefined
          ? null
          : (members.find((member) => member.userId === owner)?.name ?? null),
    };
  };
  const size = phone ? "touch" : "default";

  const dialogs = (
    <>
      <NewWorktree project={project} open={creating} onOpenChange={setCreating} />
      <ClearFinished
        finished={finished}
        wordsFor={wordsFor}
        open={clearing}
        onOpenChange={setClearing}
      />
      <RemoveWorktree row={removing} words={wordsFor(removing)} onClose={() => setRemoving(null)} />
    </>
  );

  if (rows.length === 0)
    return (
      <>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitBranchIcon aria-hidden />
            </EmptyMedia>
            <EmptyTitle>
              <h2>No worktrees yet</h2>
            </EmptyTitle>
            <EmptyDescription>
              A worktree is a branch where sessions work on one change. Create one here, or start a
              session and Mend creates its worktree for you.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size={size} onClick={() => setCreating(true)}>
              New worktree…
            </Button>
          </EmptyContent>
        </Empty>
        {dialogs}
      </>
    );

  return (
    <section aria-label="Worktrees" className="flex flex-1 flex-col lg:px-8 lg:pt-6 lg:pb-12">
      <div className="flex items-end gap-4 border-b pb-4 max-lg:hidden">
        <div className="min-w-0 flex-1">
          <h2 className="text-prose font-semibold">Worktrees in {project.name}</h2>
          <p className="mt-1 text-prose text-muted-foreground">
            Each worktree is a branch of its own. Every session started in it works on the same
            change.
          </p>
        </div>
        {finished.length === 0 ? null : (
          <Button variant="ghost" onClick={() => setClearing(true)}>
            Clear finished…
          </Button>
        )}
        <Button variant="outline" onClick={() => setCreating(true)}>
          New worktree…
        </Button>
      </div>
      <div className="flex min-h-14 items-center gap-3 border-b pl-4 lg:hidden">
        <p className="min-w-0 flex-1 py-2 text-prose text-muted-foreground">
          Each worktree is a branch of its own
        </p>
        {finished.length === 0 ? null : (
          <Button variant="ghost" size="touch" className="px-3" onClick={() => setClearing(true)}>
            Clear finished…
          </Button>
        )}
      </div>
      <div className="max-lg:hidden">
        <WorktreesTable projectId={project.id} entries={entries} now={now} onRemove={setRemoving} />
      </div>
      <div className="flex flex-1 flex-col lg:hidden">
        <WorktreesList
          projectId={project.id}
          defaultBranch={project.defaultBranch}
          entries={entries}
          now={now}
          onRemove={setRemoving}
        />
      </div>
      {/* Ended sessions with no record are left out of every list; say so. */}
      {detail.hiddenEndedSessions === 0 ? null : (
        <p className="mt-3 text-row text-muted-foreground max-lg:px-4">
          {detail.hiddenEndedSessions === 1
            ? "1 ended session isn't listed: Mend kept no record of it."
            : `${detail.hiddenEndedSessions} ended sessions aren't listed: Mend kept no record of them.`}
        </p>
      )}
      <div className="sticky bottom-0 mt-auto border-t bg-background px-4 pt-3 pb-[max(--spacing(4),env(safe-area-inset-bottom))] lg:hidden">
        <Button size="touch" className="w-full" onClick={() => setCreating(true)}>
          New worktree…
        </Button>
      </div>
      {dialogs}
    </section>
  );
}

/** "Pull request #412 open" as a link to it, or "Not landed". */
function ChangeWords({ change }: { readonly change: WorktreeChange }) {
  if (change.url === null) return <span className="text-muted-foreground">{change.words}</span>;
  return (
    <a
      href={change.url}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50",
        change.open ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {change.words}
    </a>
  );
}

const CELL = "px-3 py-3.5 align-middle";

function WorktreesTable({
  projectId,
  entries,
  now,
  onRemove,
}: {
  readonly projectId: string;
  readonly entries: ReadonlyArray<RowEntry>;
  readonly now: Date;
  readonly onRemove: (row: WorktreeRow) => void;
}) {
  return (
    <Table aria-label="Worktrees" className="text-prose">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-10 pl-0 font-normal text-muted-foreground">Worktree</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Sessions</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Change</TableHead>
          <TableHead className="px-3 font-normal text-muted-foreground">Last active</TableHead>
          <TableHead className="w-10 pr-0">
            <span className="sr-only">Menu</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody className="[&_tr:last-child]:border-b">
        {entries.map(({ row, joinLine }) => (
          <TableRow key={row.worktree.id} className="hover:bg-transparent">
            <TableCell className={cn(CELL, "max-w-80 pl-0")}>
              <span className="block truncate font-medium">{row.name}</span>
              <span className="block truncate font-mono text-meta text-muted-foreground">
                {row.branch} · from {row.base}
                {row.handedOffFrom === null ? "" : ` · handed off from ${row.handedOffFrom}`}
              </span>
            </TableCell>
            <TableCell className={cn(CELL, "max-w-110")}>
              {row.sessions.length === 0 ? (
                <span className="text-muted-foreground">No sessions yet</span>
              ) : (
                <ul aria-label={`Sessions in ${row.name}`} className="flex flex-col gap-1">
                  {row.sessions.map((session) => (
                    <li key={session.id} className="flex min-w-0 items-baseline gap-2">
                      <Link
                        {...sessionLink(session.id)}
                        className="min-w-0 truncate outline-none hover:underline focus-visible:rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {session.title}
                      </Link>
                      <SessionStatus status={session.status} className="shrink-0 text-row" />
                      {session.owner === null ? null : (
                        <span className="shrink-0 truncate text-muted-foreground">
                          {session.owner}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </TableCell>
            <TableCell className={cn(CELL, "whitespace-nowrap")}>
              <ChangeWords change={row.change} />
            </TableCell>
            <TableCell className={cn(CELL, "whitespace-nowrap text-muted-foreground")}>
              {lastActiveWords(row.lastActive, now)}
            </TableCell>
            <TableCell className={cn(CELL, "w-10 pr-0")}>
              <WorktreeMenu
                projectId={projectId}
                row={row}
                joinLine={joinLine}
                onRemove={() => onRemove(row)}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The phone's list (Doop "Phone · Project · Worktrees"): one row per worktree. */
function WorktreesList({
  projectId,
  defaultBranch,
  entries,
  now,
  onRemove,
}: {
  readonly projectId: string;
  readonly defaultBranch: string;
  readonly entries: ReadonlyArray<RowEntry>;
  readonly now: Date;
  readonly onRemove: (row: WorktreeRow) => void;
}) {
  return (
    <ul aria-label="Worktrees">
      {entries.map(({ row, joinLine }) => (
        <li
          key={row.worktree.id}
          aria-label={`Worktree ${row.name}`}
          className="flex items-center border-b"
        >
          <div className="flex min-h-16 min-w-0 flex-1 flex-col gap-0.5 py-3 pl-4">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-lead">{row.name}</span>
              {row.status === null ? null : (
                <SessionStatus status={row.status} className="shrink-0 text-sm" />
              )}
            </span>
            <span className="truncate text-prose text-muted-foreground">
              {phoneLine(row, defaultBranch, now)}
            </span>
          </div>
          <PhoneWorktreeActions
            projectId={projectId}
            row={row}
            joinLine={joinLine}
            onRemove={() => onRemove(row)}
          />
        </li>
      ))}
    </ul>
  );
}
