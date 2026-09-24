import { Button } from "@mend/ui/components/ui/button";
import { useContextMenu, type ContextMenuSpec } from "@mend/ui/context-menu";
import { cn } from "@mend/ui/lib/utils";
import { useEffect, useState } from "react";

import { StatusDot, toneText } from "#/components/status-dot";
import {
  LIVE_PROCESS,
  removeSession,
  stopSession,
  type ProjectDto,
  type SessionProcessDto,
  currentAgentProcess,
} from "#/lib/api";
import { isAgentSession, type InboxRow, type TreeProject } from "#/lib/model";
import { queryClient } from "#/lib/queries";
import type { ServiceGlance } from "#/lib/services";
import { sessionActions, useViewer } from "#/lib/viewer";
import { ago, statusTone, type Tone } from "#/lib/words";

/**
 * The sidebar's tree face (BRIEF.md, Solo-style): projects are the top-level
 * rows, any number open at once; each session (one worktree) opens into what
 * runs in it — the harness process, every live supporting shell, and its
 * Services — so a shell is never hidden behind a tab that was closed. Settled
 * sessions recede in place. Right-click carries each row's actions; holding
 * Ctrl paints 1..9 jump pills on the visible session rows.
 */

function SectionLabel({ title, count }: { readonly title: string; readonly count: string }) {
  return (
    <div className="flex items-center gap-2 px-4 pt-2.5 pb-1">
      <span className="font-mono text-[10.5px] font-medium tracking-[0.8px] text-label uppercase">
        {title}
      </span>
      <span className="h-px min-w-3 flex-1 bg-[var(--sw-faint-rule)]" />
      <span className="font-mono text-[10.5px] text-faint">{count}</span>
    </div>
  );
}

const processTone = (process: SessionProcessDto): Tone =>
  process.status === "running" || process.status === "reachable"
    ? "accent"
    : process.status === "unreachable"
      ? "amber"
      : process.status === "exited" && process.exitCode !== null && process.exitCode !== 0
        ? "red"
        : "hollow";

/** One thing running in a worktree: the harness or a supporting shell. */
function ChildRow({
  label,
  tone,
  pulse,
  word,
  focused,
  onClick,
}: {
  readonly label: string;
  readonly tone: Tone;
  readonly pulse: boolean;
  readonly word: string | null;
  readonly focused: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={focused ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 py-[3px] pr-3 pl-10 text-left transition-colors",
        focused ? "bg-wash" : "hover:bg-[var(--sw-sunken)]",
      )}
    >
      <StatusDot tone={tone} size={6} pulse={pulse} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[12px]",
          focused ? "text-foreground" : "text-ink-2",
        )}
      >
        {label}
      </span>
      {word !== null && <span className="shrink-0 font-mono text-[10.5px] text-faint">{word}</span>}
    </button>
  );
}

function SessionRow({
  row,
  index,
  focused,
  now,
  showJumpHints,
  services,
  processes,
  focusedProcessId,
  onFocus,
  onOpenShell,
  onServiceFocus,
  onMenu,
  onDelete,
}: {
  readonly row: InboxRow;
  readonly index: number;
  readonly focused: boolean;
  readonly now: number;
  readonly showJumpHints: boolean;
  readonly services: ReadonlyArray<ServiceGlance>;
  /** What runs in this worktree: the agent process and its supporting shells. */
  readonly processes: ReadonlyArray<SessionProcessDto>;
  /** The shell whose tab is focused, when the focused tab is a shell of this session. */
  readonly focusedProcessId: string | null;
  readonly onFocus: () => void;
  readonly onOpenShell: (processId: string) => void;
  readonly onServiceFocus: () => void;
  readonly onMenu: (event: React.MouseEvent) => void;
  /** Present on settled rows only — deletes the session and its worktree. */
  readonly onDelete: (() => void) | null;
}) {
  const settled = row.section === "settled";
  const time = ago(row.session.settledAt ?? row.session.startedAt ?? row.session.createdAt, now);
  // The harness row is the session's own PTY (the session tab); shells are
  // their own tabs. Ended shells leave the tree — the server prunes them from
  // the tab strip for the same reason.
  const agent = currentAgentProcess(processes);
  const shells = processes.filter(
    (process) => process.kind === "shell" && LIVE_PROCESS.has(process.status),
  );
  return (
    <li className="group relative" onContextMenu={onMenu}>
      <button
        type="button"
        onClick={onFocus}
        aria-current={focused ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-2 py-[5px] pr-3 pl-[26px] text-left transition-colors",
          focused
            ? "border-l-2 border-[var(--sw-accent)] bg-wash pl-6 hover:bg-wash"
            : "hover:bg-[var(--sw-sunken)]",
          settled && !focused && "opacity-65 hover:opacity-100",
        )}
      >
        <StatusDot
          tone={statusTone(row.session.status)}
          pulse={row.session.status === "running"}
          size={6}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-sans text-[13.5px]",
            row.unseen ? "font-medium text-foreground" : "text-ink-2",
            focused && "text-foreground",
          )}
        >
          {row.title}
        </span>
        <span
          className={cn(
            "shrink-0",
            row.slot === null
              ? "font-mono text-[11px] text-faint"
              : `font-sans text-[11.5px] font-medium ${toneText(row.slot.tone)}`,
          )}
        >
          {row.slot?.word ?? time ?? ""}
        </span>
      </button>
      {agent !== null && (
        <ChildRow
          label={row.session.harness}
          tone={processTone(agent)}
          pulse={agent.status === "running" && !settled}
          word={agent.status === "exited" || agent.status === "stopped" ? agent.status : null}
          focused={focused && focusedProcessId === null}
          onClick={onFocus}
        />
      )}
      {shells.map((shell) => (
        <ChildRow
          key={shell.id}
          label={shell.label ?? "shell"}
          tone={processTone(shell)}
          pulse={false}
          word="shell"
          focused={focusedProcessId === shell.id}
          onClick={() => onOpenShell(shell.id)}
        />
      ))}
      {services.map((glance) => (
        <button
          key={glance.name}
          type="button"
          onClick={onServiceFocus}
          className="flex w-full items-center gap-2 py-[3px] pr-3 pl-10 text-left transition-colors hover:bg-[var(--sw-sunken)]"
        >
          <span className="min-w-0 flex-1 truncate font-sans text-[12px] text-ink-2">
            {glance.name}
          </span>
          <span
            className={cn(
              "shrink-0 truncate font-mono text-[10.5px]",
              glance.attention ? toneText(glance.tone) : "text-faint",
            )}
          >
            {glance.word}
          </span>
        </button>
      ))}
      {onDelete !== null && !showJumpHints && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onDelete}
          title="Delete session — the worktree remains"
          className="absolute top-[3px] right-2 hidden h-5 rounded-md bg-[var(--sw-sunken)] px-1.5 text-[11px] font-normal text-label group-hover:inline-flex hover:text-danger focus-visible:inline-flex"
        >
          delete
        </Button>
      )}
      {showJumpHints && index < 9 && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-[3px] right-2 rounded-md border border-rule bg-panel px-1.5 font-mono text-[11px] text-muted-foreground shadow-xs"
        >
          {index + 1}
        </span>
      )}
    </li>
  );
}

export function Sidebar({
  tree,
  rowsByProject,
  expandedIds,
  focusedProjectId,
  focusedSessionId,
  now,
  serviceGlances,
  processesBySession,
  focusedProcessId,
  onToggleProject,
  onLaunch,
  onFocus,
  onOpenShell,
  onServiceFocus,
}: {
  readonly tree: ReadonlyArray<TreeProject>;
  /** Display-ordered rows (active then settled) per project. */
  readonly rowsByProject: ReadonlyMap<string, ReadonlyArray<InboxRow>>;
  /** Any number of projects may hold their tree open at once. */
  readonly expandedIds: ReadonlySet<string>;
  readonly focusedProjectId: string | null;
  readonly focusedSessionId: string | null;
  readonly now: number;
  readonly serviceGlances: ReadonlyMap<string, ReadonlyArray<ServiceGlance>>;
  /** Every known process, by session — the tree's children. */
  readonly processesBySession: ReadonlyMap<string, ReadonlyArray<SessionProcessDto>>;
  /** The focused shell tab's process, when the focused tab is a shell. */
  readonly focusedProcessId: string | null;
  readonly onToggleProject: (id: string) => void;
  readonly onLaunch: (projectId: string) => void;
  readonly onFocus: (row: InboxRow) => void;
  readonly onOpenShell: (row: InboxRow, processId: string) => void;
  readonly onServiceFocus: (row: InboxRow) => void;
}) {
  const { openMenu, menuElement } = useContextMenu();
  const viewer = useViewer();
  const [jumpHints, setJumpHints] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Hold-Ctrl index overlay, t3's JumpHintBadge: only while the exact jump
  // modifier is down, so Ctrl+Shift combos don't flash the pills.
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === "Control" && !event.shiftKey && !event.altKey && !event.metaKey) {
        setJumpHints(true);
      } else if (event.key !== "Control") {
        setJumpHints(false);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === "Control") setJumpHints(false);
    };
    const blur = () => setJumpHints(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Sequential on purpose: each removal deletes a worktree; hammering the
  // store with parallel deletes buys nothing and muddies failure reporting.
  const deleteRows = async (rows: ReadonlyArray<InboxRow>) => {
    setDeleting(true);
    setDeleteError(null);
    let failed = 0;
    let reason: string | null = null;
    for (const row of rows) {
      try {
        await removeSession(row.session.id);
        queryClient.removeQueries({ queryKey: ["session", row.session.id] });
      } catch (cause) {
        failed += 1;
        reason = cause instanceof Error ? cause.message : String(cause);
      }
    }
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
    for (const projectId of new Set(rows.map((row) => row.session.projectId))) {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    }
    if (failed > 0) {
      // The server's own words for the last failure — "1 of 1 could not be
      // deleted" hides a stopped session whose supporting shell still runs.
      setDeleteError(
        `${failed} of ${rows.length} could not be deleted${reason === null ? "" : ` — ${reason}`}`,
      );
    }
    setDeleting(false);
  };

  const deleteOne = (row: InboxRow) => {
    if (deleting) return;
    if (!window.confirm(`Really delete "${row.title}" and its worktree?`)) return;
    void deleteRows([row]);
  };

  const stopRow = async (row: InboxRow) => {
    try {
      await stopSession(row.session.id);
      void queryClient.invalidateQueries({ queryKey: ["session", row.session.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", row.session.projectId] });
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Stop for whoever may stop it, delete for its owner; nothing the server would refuse. */
  const sessionMenu = (row: InboxRow): ContextMenuSpec => {
    const actions = sessionActions(row.session, viewer);
    const last =
      row.section === "active"
        ? actions.stop
          ? {
              label: "Stop",
              // The tree lists `shell` sessions too, which run no coding agent.
              confirm: isAgentSession(row.session) ? "Stop the coding agent?" : "Stop the shell?",
              danger: true,
              onSelect: () => void stopRow(row),
            }
          : null
        : actions.own
          ? {
              label: "Delete",
              confirm:
                "Really delete this session? The worktree, its change, and checkpoints remain.",
              danger: true,
              onSelect: () => void deleteRows([row]),
            }
          : null;
    return {
      title: row.session.branch,
      entries: [
        { label: "Open", onSelect: () => onFocus(row) },
        { label: "Services", onSelect: () => onServiceFocus(row) },
        {
          label: "Copy branch",
          flash: "Copied",
          onSelect: () => void navigator.clipboard.writeText(row.session.branch),
        },
        ...(last === null ? [] : (["separator", last] as const)),
      ],
    };
  };

  const projectMenu = (project: ProjectDto, settled: ReadonlyArray<InboxRow>): ContextMenuSpec => ({
    title: project.storePath,
    entries: [
      { label: "New session", onSelect: () => onLaunch(project.id) },
      {
        label: "Copy store path",
        flash: "Copied",
        onSelect: () => void navigator.clipboard.writeText(project.storePath),
      },
      ...(settled.length > 0
        ? ([
            "separator",
            {
              label: `Clear ${settled.length} settled`,
              confirm: "Really delete them and their worktrees?",
              danger: true,
              onSelect: () => void deleteRows(settled),
            },
          ] as const)
        : []),
    ],
  });

  // Jump pills number the visible session rows across every open tree, in
  // tree order — the same order the keybindings walk.
  const indexOffsets = new Map<string, number>();
  let indexAccumulator = 0;
  for (const entry of tree) {
    if (!expandedIds.has(entry.project.id)) continue;
    indexOffsets.set(entry.project.id, indexAccumulator);
    indexAccumulator += (rowsByProject.get(entry.project.id) ?? []).length;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {menuElement}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {tree.length === 0 && (
          <p className="px-4 py-3 font-sans text-[13px] leading-relaxed text-label">
            no projects — adopt one with <span className="text-foreground">mend adopt</span>
          </p>
        )}
        {tree.map(({ project }) => {
          const expanded = expandedIds.has(project.id);
          const focusedHere = project.id === focusedProjectId;
          const rows = rowsByProject.get(project.id) ?? [];
          const indexOffset = indexOffsets.get(project.id) ?? 0;
          const live = rows.filter((row) => row.section === "active");
          // Clearing deletes, which is the owner's alone: only the viewer's own settled rows.
          const settled = rows.filter(
            (row) => row.section === "settled" && sessionActions(row.session, viewer).own,
          );
          return (
            <section key={project.id} className="border-b border-rule-faint">
              <div
                onContextMenu={(event) => openMenu(event, projectMenu(project, settled))}
                className={cn(
                  "group/project flex items-center gap-2 pr-2 transition-colors",
                  focusedHere && "border-l-2 border-[var(--sw-accent)]",
                  !expanded && "hover:bg-[var(--sw-sunken)]",
                )}
              >
                <button
                  type="button"
                  onClick={() => onToggleProject(project.id)}
                  aria-expanded={expanded}
                  className="flex h-11 min-w-0 flex-1 items-center gap-2 pl-3 text-left"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "font-mono text-[11px] text-faint transition-transform",
                      expanded && "rotate-90",
                    )}
                  >
                    ›
                  </span>
                  <span className="truncate font-sans text-[14.5px] font-semibold text-foreground">
                    {project.name}
                  </span>
                  <span className="truncate font-mono text-[11.5px] text-faint">
                    {project.defaultBranch}
                  </span>
                  <span className="flex-1" />
                  {!expanded && (
                    <span className="font-mono text-[11px] text-faint">{rows.length}</span>
                  )}
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={`New session in ${project.name}`}
                  aria-label={`New session in ${project.name}`}
                  onClick={() => onLaunch(project.id)}
                  className="size-6 shrink-0 rounded-md font-mono text-[15px] text-label opacity-0 transition-opacity group-hover/project:opacity-100 focus-visible:opacity-100"
                >
                  +
                </Button>
              </div>
              {expanded && (
                <div className="pb-2">
                  <SectionLabel title="sessions" count={`${live.length}/${rows.length}`} />
                  {rows.length === 0 && (
                    <p className="px-[26px] py-1 font-sans text-[12.5px] text-label">
                      none yet — press + to launch
                    </p>
                  )}
                  <ul>
                    {rows.map((row, index) => (
                      <SessionRow
                        key={row.session.id}
                        row={row}
                        index={indexOffset + index}
                        focused={row.session.id === focusedSessionId}
                        now={now}
                        showJumpHints={jumpHints}
                        services={serviceGlances.get(row.session.id) ?? []}
                        processes={processesBySession.get(row.session.id) ?? []}
                        focusedProcessId={
                          row.session.id === focusedSessionId ? focusedProcessId : null
                        }
                        onFocus={() => onFocus(row)}
                        onOpenShell={(processId) => onOpenShell(row, processId)}
                        onServiceFocus={() => onServiceFocus(row)}
                        onMenu={(event) => openMenu(event, sessionMenu(row))}
                        onDelete={
                          row.section === "settled" && sessionActions(row.session, viewer).own
                            ? () => deleteOne(row)
                            : null
                        }
                      />
                    ))}
                  </ul>
                </div>
              )}
            </section>
          );
        })}
        {deleteError !== null && (
          <p className="px-4 py-1.5 font-mono text-[11px] text-danger">{deleteError}</p>
        )}
        {deleting && (
          <p className="px-4 py-1.5 font-mono text-[11px] text-label">deleting settled sessions…</p>
        )}
      </div>
    </div>
  );
}
