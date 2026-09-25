import { Link } from "@tanstack/react-router";
import { ChevronRight, FolderGit2, Terminal } from "lucide-react";
import { useId, useState, type ReactElement, type ReactNode } from "react";

import { HiddenEndedSessionsNotice } from "#/components/project-detail/hidden-ended-sessions-notice";
import { baseLabel, type WorktreeGroup } from "#/components/project-detail/model";
import { NewWorktreeSession } from "#/components/project-detail/new-worktree-session";
import { ReviewLink, type DetailHandlers } from "#/components/project-detail/parts";
import { SessionStatusDot, StatusDot } from "#/components/status";
import type { SessionDto } from "#/lib/api";
import { worktreeDisplayName } from "#/lib/workbench-menus";

/** Render the project worktree empty state or its tree without hiding transcript capture gaps. */
export function ProjectWorktreeContent({
  hiddenEndedSessions,
  worktreeCount,
  onCreate,
  children,
}: {
  readonly hiddenEndedSessions: number;
  readonly worktreeCount: number;
  readonly onCreate: () => void;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <>
      <HiddenEndedSessionsNotice count={hiddenEndedSessions} />
      {worktreeCount === 0 ? (
        <div className="rounded-2xl bg-panel px-6 py-12 text-center shadow-sm">
          <h3 className="text-sm font-medium">No worktrees yet</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Create a worktree, then add sessions inside it.
          </p>
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={onCreate}
            className="mt-4 text-sm font-medium text-info hover:underline"
          >
            Create your first worktree
          </button>
        </div>
      ) : (
        children
      )}
    </>
  );
}

/** How the same tree is laid out: rows in one panel, or one panel per worktree. */
export type WorktreeTreeView = "list" | "cards";

/** What a session is called on its own line: its label, else its short id. */
const sessionName = (session: SessionDto): string =>
  session.label ?? `session ${session.id.slice(0, 8)}`;

/** The elbow and trunk that tie a session line back to its worktree. */
function Connector({ last }: { readonly last: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={`absolute top-0 left-0 w-px bg-rule-faint ${last ? "h-[19px]" : "h-full"}`}
      />
      <span aria-hidden="true" className="absolute top-[19px] left-0 h-px w-3.5 bg-rule-faint" />
    </>
  );
}

/** Sessions in a worktree, and how many have a live process (model.ts). */
function SessionCount({ total, live }: { readonly total: number; readonly live: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-mono text-[11.5px] text-faint">
      <span>
        {total} session{total === 1 ? "" : "s"}
      </span>
      {live > 0 && (
        <>
          <span className="size-[5px] shrink-0 rounded-full bg-success-dot" aria-hidden="true" />
          <span className="text-success">{live} live</span>
        </>
      )}
    </span>
  );
}

/** The worktree's machine facts: branch, base, open review work, follow-up. */
function WorktreeFactLine({ group }: { readonly group: WorktreeGroup }) {
  const { worktree, annotation } = group;
  return (
    <p className="mt-0.5 truncate font-mono text-xs text-faint" title={worktree.directory}>
      {worktree.branch} · base {baseLabel(worktree)}
      {annotation !== undefined && annotation.openComments > 0 && (
        <span className="text-ink-2">
          {" "}
          · {annotation.openComments} open comment{annotation.openComments === 1 ? "" : "s"}
        </span>
      )}
      {annotation?.pendingFollowUp === true && (
        <span className="text-warning"> · follow-up pending</span>
      )}
    </p>
  );
}

/** One session child: lighter than its parent, with its own right-click verbs. */
function SessionLine({
  session,
  hold,
  last,
  handlers,
}: {
  readonly session: SessionDto;
  /** Its agent is no longer live and its Services keep the workspace up; null otherwise. */
  readonly hold: string | null;
  readonly last: boolean;
  readonly handlers: DetailHandlers;
}) {
  const name = sessionName(session);
  return (
    <li className="relative pl-5">
      <Connector last={last} />
      <div
        onContextMenu={(event) => handlers.onSessionMenu(event, session)}
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg py-2 pr-2 pl-2 transition-colors hover:bg-secondary"
      >
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: session.id }}
          title={`${name} · ${session.harness}`}
          className="flex min-w-0 flex-1 basis-[200px] items-center gap-2 no-underline"
        >
          <Terminal className="size-3.5 shrink-0 text-faint" aria-hidden="true" />
          <span className="truncate font-sans text-[13px] text-ink-2">{name}</span>
          <span className="shrink-0 font-mono text-[11.5px] text-faint">{session.harness}</span>
        </Link>
        {hold === null ? (
          <SessionStatusDot status={session.status} recorded={session.sealantRunId !== null} />
        ) : (
          <StatusDot tone="hollow" word={hold} />
        )}
      </div>
    </li>
  );
}

/** One worktree and the sessions inside it — the only card this view has. */
function WorktreeNode({
  group,
  view,
  open,
  onToggle,
  handlers,
}: {
  readonly group: WorktreeGroup;
  readonly view: WorktreeTreeView;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly handlers: DetailHandlers;
}) {
  const listId = useId();
  const name = worktreeDisplayName(group.worktree, group.members);
  return (
    <li
      className={
        view === "cards"
          ? "flex min-w-0 flex-col rounded-2xl bg-panel shadow-[var(--shadow-sm)] transition-transform hover:-translate-y-0.5"
          : "min-w-0 border-t border-rule-faint first:border-t-0"
      }
    >
      <div
        onContextMenu={(event) => handlers.onWorktreeMenu(event, group)}
        className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-3.5 pb-1.5"
      >
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
          className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ChevronRight
            className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden="true"
          />
          <span className="sr-only">
            {open ? "Hide" : "Show"} sessions in {name}
          </span>
        </button>
        <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-[160px]">
          <p className="truncate font-sans text-sm font-medium text-foreground" title={name}>
            {name}
          </p>
          <WorktreeFactLine group={group} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3 pt-0.5">
          <SessionCount total={group.members.length} live={group.live} />
          <ReviewLink group={group} />
          <NewWorktreeSession worktreeId={group.worktree.id} worktreeName={name} />
        </div>
      </div>
      <ul id={listId} hidden={!open} className="list-none pb-2.5 pl-7">
        {group.members.length === 0 ? (
          <li className="relative pl-5">
            <Connector last />
            <p className="py-2 font-mono text-xs text-faint">No visible sessions</p>
          </li>
        ) : (
          group.members.map((session, index) => (
            <SessionLine
              key={session.id}
              session={session}
              hold={group.holds.get(session.id) ?? null}
              last={index === group.members.length - 1}
              handlers={handlers}
            />
          ))
        )}
      </ul>
    </li>
  );
}

/**
 * Worktree → sessions, as one tree. Both views render the same list of
 * worktrees with the same nested session children; `view` only changes whether
 * the worktrees share one panel or each get their own. Expansion is per
 * worktree, defaults open, and survives a view switch.
 */
export function WorktreeTree({
  groups,
  view,
  handlers,
}: {
  readonly groups: ReadonlyArray<WorktreeGroup>;
  readonly view: WorktreeTreeView;
  readonly handlers: DetailHandlers;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = (worktreeId: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(worktreeId)) next.add(worktreeId);
      return next;
    });

  if (groups.length === 0) return null;
  return (
    <ul
      className={
        view === "cards"
          ? "grid list-none gap-4 sm:grid-cols-2"
          : "list-none overflow-hidden rounded-2xl bg-panel shadow-[var(--shadow-sm)]"
      }
    >
      {groups.map((group) => (
        <WorktreeNode
          key={group.worktree.id}
          group={group}
          view={view}
          open={!collapsed.has(group.worktree.id)}
          onToggle={() => toggle(group.worktree.id)}
          handlers={handlers}
        />
      ))}
    </ul>
  );
}
