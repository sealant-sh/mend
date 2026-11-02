import { useContextMenu } from "@mend/ui/context-menu";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type MouseEvent } from "react";

import { ComposerResources } from "#/components/composer-resources";
import { Button, focusRing } from "#/components/kit/button";
import { Menu, MenuGroup, MenuItem } from "#/components/kit/menu";
import { Dot, StatusWord } from "#/components/kit/status";
import { HiddenEndedSessionsNotice } from "#/components/project-detail/hidden-ended-sessions-notice";
import {
  baseLabel,
  handedOffFrom,
  settledGroups,
  worktreeGroups,
  type WorktreeGroup,
} from "#/components/project-detail/model";
import { NewWorktreeDialog } from "#/components/project-detail/new-worktree-dialog";
import {
  RemoveWorktreeAnywayDialog,
  type RefusedRemoval,
} from "#/components/project-detail/remove-worktree-anyway";
import { removeWorktree, type ProjectDetailDto, type SessionDto } from "#/lib/api";
import { HARNESSES, startComposedSessionInWorktree, type Harness } from "#/lib/session-launch";
import { useWorktreeJoinLine } from "#/lib/shared-workspace";
import { useTRPC } from "#/lib/trpc";
import { useViewer } from "#/lib/viewer";
import { sessionMenu, worktreeDisplayName, worktreeMenu } from "#/lib/workbench-menus";
import { keptNote, removalRefusalOf } from "#/lib/worktree-removal";

import { sessionName, sessionStatusWord } from "./sessions-status";

/** The harnesses a worktree offers, matching the worktree context menu. */
const WORKTREE_HARNESSES: ReadonlyArray<Harness> = HARNESSES.filter(
  (harness) => harness !== "shell",
);

/**
 * The Worktrees tab (screen K2): each worktree on its own panel with the sessions inside it,
 * newest live first. Review and New session sit on the worktree; right-click a worktree or a
 * session for copy, stop and remove. Clear settled removes every worktree with nothing live,
 * one at a time, after a second click, and never forces: what the store keeps is said once.
 */
export function WorktreesTab({ detail }: { readonly detail: ProjectDetailDto }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const viewer = useViewer();
  const launchContext = { queryClient, trpc };
  const { project, sessions, annotations, worktrees, worktreeAnnotations } = detail;
  const [newWorktreeOpen, setNewWorktreeOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  // A removal the store refused in words: the dialog shows them and offers the second step.
  const [refused, setRefused] = useState<RefusedRemoval | null>(null);
  const { openMenu, menuElement } = useContextMenu();

  const groups = worktreeGroups(worktrees, sessions, worktreeAnnotations, annotations);
  const settled = settledGroups(groups);

  // Sequential and never forced: a worktree the store refuses in words stays, and how many is
  // said once. Each one's own menu shows the words and, when force lifts them, the second step.
  const clear = useMutation({
    mutationFn: () =>
      settled.reduce(
        (chain, group) =>
          chain.then(async (refusals) => {
            const refusal = await removeWorktree(group.worktree.id).then(
              () => null,
              (cause: unknown) => removalRefusalOf(cause),
            );
            return refusal === null ? refusals : refusals + 1;
          }),
        Promise.resolve(0),
      ),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries(trpc.projects.pathFilter()),
        queryClient.invalidateQueries(trpc.worktrees.pathFilter()),
        queryClient.invalidateQueries(trpc.environment.pathFilter()),
      ]),
  });

  const onWorktreeMenu = (event: MouseEvent, group: WorktreeGroup) =>
    openMenu(
      event,
      worktreeMenu(
        group.worktree,
        group.members,
        group.annotation,
        navigate,
        launchContext,
        (refusal) =>
          setRefused({
            worktree: group.worktree,
            name: worktreeDisplayName(group.worktree, group.members),
            refusal,
          }),
      ),
    );
  const onSessionMenu = (event: MouseEvent, session: SessionDto) =>
    openMenu(
      event,
      sessionMenu(
        session,
        annotations.find((row) => row.sessionId === session.id),
        navigate,
        launchContext,
        viewer,
      ),
    );

  const keptLine = clear.isSuccess ? keptNote(clear.data) : null;

  return (
    <section aria-label="Worktrees">
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <p role="status" className="mr-auto font-mono text-[11.5px] text-faint empty:hidden">
          {clear.isError ? "" : (keptLine ?? "")}
        </p>
        {settled.length === 0 && !clear.isPending ? null : (
          <Button
            variant="ghost"
            size="sm"
            disabled={clear.isPending}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              setArmed(false);
              clear.mutate();
            }}
            onBlur={() => setArmed(false)}
            className={armed ? "text-warning" : ""}
          >
            {clear.isPending
              ? "Clearing…"
              : armed
                ? `Really remove ${settled.length} settled worktree${settled.length === 1 ? "" : "s"}? Sessions and changes go with them.`
                : "Clear settled"}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          aria-haspopup="dialog"
          onClick={() => setNewWorktreeOpen(true)}
        >
          New worktree
        </Button>
      </div>
      <HiddenEndedSessionsNotice count={detail.hiddenEndedSessions} />
      {groups.length === 0 ? (
        <div className="rounded-[22px] bg-panel px-6 py-12 text-center shadow-sm">
          <h3 className="font-sans text-[15px] font-semibold">No worktrees yet</h3>
          <p className="mt-2 text-[13.5px] text-muted-foreground">
            Create a worktree, then start sessions inside it.
          </p>
          <Button className="mt-4" aria-haspopup="dialog" onClick={() => setNewWorktreeOpen(true)}>
            Create your first worktree
          </Button>
        </div>
      ) : (
        <ul className="grid gap-2.5">
          {groups.map((group) => (
            <WorktreePanel
              key={group.worktree.id}
              group={group}
              onWorktreeMenu={onWorktreeMenu}
              onSessionMenu={onSessionMenu}
            />
          ))}
        </ul>
      )}
      <NewWorktreeDialog
        project={project}
        open={newWorktreeOpen}
        onOpenChange={setNewWorktreeOpen}
      />
      <RemoveWorktreeAnywayDialog
        refused={refused}
        onKeep={() => setRefused(null)}
        onRemoved={(worktreeId) => {
          // Only the refusal of the worktree that went; a later one of another stays on screen.
          setRefused((current) => (current?.worktree.id === worktreeId ? null : current));
          void queryClient.invalidateQueries(trpc.environment.pathFilter());
        }}
      />
      {menuElement}
    </section>
  );
}

/** `base main@16f4f2d · 2 open comments · handed off from yiannis-mbp · follow-up pending`. */
function WorktreeFacts({ group }: { readonly group: WorktreeGroup }) {
  const { worktree, annotation } = group;
  const handedOff = handedOffFrom(worktree);
  const base =
    worktree.baseRef === null
      ? baseLabel(worktree)
      : `${worktree.baseRef}@${worktree.baseSha.slice(0, 7)}`;
  const open = annotation?.openComments ?? 0;
  return (
    <span
      className="block truncate font-mono text-[11.5px] text-muted-foreground"
      title={worktree.branch}
    >
      base {base}
      {open > 0 ? ` · ${open} open comment${open === 1 ? "" : "s"}` : ""}
      {handedOff === null ? "" : ` · ${handedOff}`}
      {annotation?.pendingFollowUp === true ? (
        <span className="text-warning"> · follow-up pending</span>
      ) : null}
    </span>
  );
}

/** What landing has done with the change: its pull request as GitHub last said, or not landed. */
function LandingWord({ group }: { readonly group: WorktreeGroup }) {
  const pullRequest = group.annotation?.pullRequest ?? null;
  if (pullRequest === null)
    return <span className="font-mono text-[12px] text-muted-foreground">not landed</span>;
  return (
    <a
      href={pullRequest.url}
      target="_blank"
      rel="noreferrer"
      title={`${pullRequest.title ?? `pull request #${pullRequest.number}`} · ${pullRequest.state} · observed ${new Date(pullRequest.observedAt).toLocaleString()}${pullRequest.adopted ? " · opened outside Mend" : ""}`}
      className={cn("text-[13px] text-info no-underline hover:underline", focusRing)}
    >
      pull request #{pullRequest.number} · {pullRequest.state}
    </a>
  );
}

function WorktreePanel({
  group,
  onWorktreeMenu,
  onSessionMenu,
}: {
  readonly group: WorktreeGroup;
  readonly onWorktreeMenu: (event: MouseEvent, group: WorktreeGroup) => void;
  readonly onSessionMenu: (event: MouseEvent, session: SessionDto) => void;
}) {
  const name = worktreeDisplayName(group.worktree, group.members);
  const changeId = group.annotation?.changeId ?? null;
  const total = group.members.length;
  return (
    <li aria-label={`Worktree ${name}`} className="rounded-[22px] bg-panel py-1 shadow-sm">
      <div
        onContextMenu={(event) => onWorktreeMenu(event, group)}
        className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3 px-4 py-3"
      >
        <span className="min-w-0">
          <span className="block truncate font-sans text-[14px] font-semibold" title={name}>
            {name}
          </span>
          <WorktreeFacts group={group} />
        </span>
        <span className="font-mono text-[12px] whitespace-nowrap text-ink-2">
          {total} session{total === 1 ? "" : "s"}
        </span>
        <LandingWord group={group} />
        <span className="flex items-center gap-1.5">
          {changeId === null ? (
            <Button
              size="sm"
              aria-disabled="true"
              title="Nothing to review yet: no session here has recorded a change"
              className="cursor-default opacity-50 hover:translate-y-0 hover:shadow-xs"
            >
              Review
            </Button>
          ) : (
            <Link
              to="/changes/$changeId"
              params={{ changeId }}
              aria-label={`Review ${name}`}
              className={cn(
                "inline-flex items-center rounded-[10px] border border-input bg-panel px-2.5 py-1.5 font-sans text-[12.5px] leading-none font-medium text-foreground no-underline shadow-xs transition-[translate,box-shadow] motion-reduce:transition-none hover:-translate-y-px hover:shadow-sm",
                focusRing,
              )}
            >
              Review
            </Link>
          )}
          <NewSessionMenu group={group} name={name} />
        </span>
      </div>
      {total === 0 ? (
        <p className="border-t border-rule-faint py-2.5 pr-4 pl-10 font-mono text-[11.5px] text-faint">
          No visible sessions
        </p>
      ) : (
        <ul aria-label={`Sessions in ${name}`}>
          {group.members.map((session) => (
            <SessionLine
              key={session.id}
              session={session}
              hold={group.holds.get(session.id) ?? null}
              onMenu={onSessionMenu}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionLine({
  session,
  hold,
  onMenu,
}: {
  readonly session: SessionDto;
  /** Its agent is no longer live and its Services keep the workspace up; null otherwise. */
  readonly hold: string | null;
  readonly onMenu: (event: MouseEvent, session: SessionDto) => void;
}) {
  const status = hold === null ? sessionStatusWord(session) : { tone: "off" as const, word: hold };
  const name = sessionName(session);
  return (
    <li
      onContextMenu={(event) => onMenu(event, session)}
      className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-center gap-3 border-t border-rule-faint py-2.5 pr-4 pl-10 transition-colors motion-reduce:transition-none hover:bg-secondary"
    >
      <Dot tone={status.tone} />
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: session.id }}
        className={cn(
          "min-w-0 truncate rounded-md text-[13.5px] text-foreground no-underline",
          focusRing,
        )}
      >
        {name}{" "}
        <span className="font-mono text-[11.5px] text-muted-foreground">
          · {session.harness}
          {session.model === null ? "" : ` · ${session.model}`}
        </span>
      </Link>
      <StatusWord tone={status.tone}>{status.word}</StatusWord>
    </li>
  );
}

/**
 * New session ▾: start a conversation in this worktree with a harness, then open it. When someone
 * else's session already runs here, the menu says so before the viewer joins its workspace
 * (docs/adr/0016, decision 13), and it says which resources the worktree uses.
 */
function NewSessionMenu({ group, name }: { readonly group: WorktreeGroup; readonly name: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const joinLine = useWorktreeJoinLine(group.worktree.id, group.members);
  const start = useMutation({
    mutationFn: (harness: Harness) =>
      startComposedSessionInWorktree(navigate, { queryClient, trpc }, group.worktree.id, {
        harness,
        prompt: "",
      }),
  });
  return (
    <span className="relative">
      <Menu
        align="end"
        width={300}
        trigger={
          <Button size="sm" disabled={start.isPending} aria-label={`New session in ${name}`}>
            {start.isPending ? "Starting…" : "New session ▾"}
          </Button>
        }
      >
        {joinLine === null ? null : (
          <p className="px-2.5 pt-1.5 pb-2 text-[12px] leading-relaxed text-ink-2">{joinLine}</p>
        )}
        <ComposerResources
          projectId={group.worktree.projectId}
          worktreeId={group.worktree.id}
          readOnly
        />
        <MenuGroup label="Agent">
          {WORKTREE_HARNESSES.map((harness) => (
            <MenuItem key={harness} onClick={() => start.mutate(harness)}>
              <span className="font-mono text-[12.5px]">{harness}</span>
            </MenuItem>
          ))}
        </MenuGroup>
      </Menu>
      <span
        role="alert"
        className="absolute top-full right-0 mt-1 w-max max-w-[260px] font-mono text-[11px] text-danger empty:hidden"
      >
        {start.isError ? `Could not start: ${start.error.message}` : ""}
      </span>
    </span>
  );
}
