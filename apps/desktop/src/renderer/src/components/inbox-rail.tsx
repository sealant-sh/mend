import { Button } from "@mend/ui/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { useContextMenu, type ContextMenuEntry, type ContextMenuSpec } from "@mend/ui/context-menu";
import { cn } from "@mend/ui/lib/utils";
import { AlarmClock, AlarmClockOff } from "lucide-react";
import { useEffect, useState } from "react";

import { ComposerMenu, ComposerPill, MenuRadioGroup, type MenuState } from "#/components/launcher";
import { FilesPane, PullRequestsPane, ServicesPane } from "#/components/project-panes";
import { StatusDot, toneText } from "#/components/status-dot";
import {
  removeSession,
  stopSession,
  stopSessionServices,
  type ProjectDto,
  type ServiceViewDto,
  type SessionDto,
} from "#/lib/api";
import { inboxShelves, SETTLED_PAGE, type InboxShelves } from "#/lib/inbox-shelves";
import type { Inbox, InboxRow } from "#/lib/model";
import { queryClient } from "#/lib/queries";
import { sidebarView, type ProjectSubView } from "#/lib/sidebar-view";
import { canSnooze, describeWake, snooze, snoozePresets, wake, wakeLabel } from "#/lib/snooze";
import { sessionActions, useViewer } from "#/lib/viewer";
import { ago } from "#/lib/words";

/**
 * The sidebar's inbox face — t3code's flat list (map: docs/SIDEBAR-MAP.md).
 * One cross-project list in static creation order: active rows, the
 * collapsed Snoozed shelf, the Settled tail with show-more paging. Projects
 * are a scope filter above the list, not headers; scoping to one project
 * reveals its sub-views behind a compact switcher — Inbox, Services, PRs,
 * Files. Hover (or keyboard focus) reveals one action per row: snooze on
 * active rows, delete on settled ones; everything else is in the context
 * menu. Holding Ctrl paints 1..9 jump pills on the rendered rows.
 */

const SUB_VIEWS: ReadonlyArray<{ readonly id: ProjectSubView; readonly label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "services", label: "Services" },
  { id: "prs", label: "PRs" },
  { id: "files", label: "Files" },
];

interface UndoNote {
  readonly sessionId: string;
  readonly text: string;
}

export function InboxRail({
  projects,
  inbox,
  visibleRows,
  shelves,
  scopeProjectId,
  subView,
  focusedSessionId,
  focusedSession,
  sessionsByProject,
  serviceViews,
  now,
  onFocus,
  onServiceFocus,
  onLaunch,
  onScope,
}: {
  readonly projects: ReadonlyArray<ProjectDto>;
  /** Already scoped to `scopeProjectId`. */
  readonly inbox: Inbox;
  /** What the route numbers — the same list this rail renders. */
  readonly visibleRows: ReadonlyArray<InboxRow>;
  readonly shelves: InboxShelves;
  readonly scopeProjectId: string | null;
  readonly subView: ProjectSubView;
  readonly focusedSessionId: string | null;
  readonly focusedSession: SessionDto | null;
  readonly sessionsByProject: ReadonlyMap<string, ReadonlyArray<SessionDto>>;
  readonly serviceViews: ReadonlyArray<ServiceViewDto>;
  readonly now: number;
  readonly onFocus: (row: InboxRow) => void;
  readonly onServiceFocus: (sessionId: string) => void;
  readonly onLaunch: (projectId: string) => void;
  /** Narrow to one project (null = all); the route also focuses it for the composer. */
  readonly onScope: (projectId: string | null) => void;
}) {
  const { openMenu, menuElement } = useContextMenu();
  const viewer = useViewer();
  const [jumpHints, setJumpHints] = useState(false);
  const [scopeMenu, setScopeMenu] = useState<MenuState | null>(null);
  const [snoozeMenu, setSnoozeMenu] = useState<(MenuState & { readonly row: InboxRow }) | null>(
    null,
  );
  const [undo, setUndo] = useState<UndoNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scope = projects.find((project) => project.id === scopeProjectId) ?? null;

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

  // The undo line is the snooze's only confirmation — the row just left.
  useEffect(() => {
    if (undo === null) return;
    const timer = window.setTimeout(() => setUndo(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [undo]);

  const indexOf = new Map(visibleRows.map((row, index) => [row.session.id, index]));

  const park = (row: InboxRow, until: Date) => {
    snooze(row.session.id, until);
    setUndo({
      sessionId: row.session.id,
      text: `snoozed until ${describeWake(until, new Date())}`,
    });
    setSnoozeMenu(null);
  };

  const deleteRow = async (row: InboxRow) => {
    setError(null);
    try {
      await removeSession(row.session.id);
      queryClient.removeQueries({ queryKey: ["session", row.session.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", row.session.projectId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const stopRow = async (row: InboxRow) => {
    setError(null);
    try {
      // A row whose agent stopped while Services keep its workspace up stops those instead.
      await (row.hold === null ? stopSession(row.session.id) : stopSessionServices(row.session.id));
      void queryClient.invalidateQueries({ queryKey: ["session", row.session.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", row.session.projectId] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  // One builder for the row menu (t3: threadActionMenu.logic.ts), so the
  // flat entries here and the hover affordances never drift.
  const rowMenu = (row: InboxRow): ContextMenuSpec => {
    const presets = snoozePresets(new Date());
    const snoozeEntries: ReadonlyArray<ContextMenuEntry> =
      row.section === "snoozed"
        ? [{ label: "Wake now", onSelect: () => wake(row.session.id) }]
        : canSnooze(row.session)
          ? presets.map((preset) => ({
              label: `Snooze · ${preset.label.toLowerCase()}`,
              onSelect: () => park(row, preset.until),
            }))
          : [{ label: "Snooze", disabled: true, onSelect: () => undefined }];
    // Only what the server would allow: stop for whoever may stop it, delete for its owner.
    const actions = sessionActions(row.session, viewer);
    const last: ContextMenuEntry | null =
      row.section === "settled"
        ? actions.own
          ? {
              label: "Delete",
              confirm:
                "Really delete this session? The worktree, its change, and checkpoints remain.",
              danger: true,
              onSelect: () => void deleteRow(row),
            }
          : null
        : actions.stop
          ? row.hold === null
            ? {
                label: "Stop",
                confirm: "Stop the coding agent?",
                danger: true,
                onSelect: () => void stopRow(row),
              }
            : {
                label: "Stop services",
                confirm: `${row.hold}. Stop them? The workspace ends once nothing is live.`,
                danger: true,
                onSelect: () => void stopRow(row),
              }
          : null;
    return {
      title: row.session.branch,
      entries: [
        { label: "Open", onSelect: () => onFocus(row) },
        { label: "Services", onSelect: () => onServiceFocus(row.session.id) },
        {
          label: "Focus project",
          onSelect: () => onScope(row.session.projectId),
        },
        "separator",
        ...snoozeEntries,
        "separator",
        {
          label: "Copy branch",
          flash: "Copied",
          onSelect: () => void navigator.clipboard.writeText(row.session.branch),
        },
        ...(last === null ? [] : (["separator", last] as const)),
      ],
    };
  };

  const openSnoozeMenu = (row: InboxRow) => (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setSnoozeMenu((current) =>
      current?.row.session.id === row.session.id
        ? null
        : { kind: "settings", anchor: { left: rect.left, bottom: rect.bottom }, row },
    );
  };

  const renderRow = (row: InboxRow) => (
    <Row
      key={`${row.section}:${row.session.id}`}
      row={row}
      index={indexOf.get(row.session.id) ?? -1}
      focused={row.session.id === focusedSessionId}
      now={now}
      showProject={scope === null}
      showJumpHints={jumpHints}
      onFocus={() => onFocus(row)}
      onMenu={(event) => openMenu(event, rowMenu(row))}
      onSnooze={row.section === "active" && canSnooze(row.session) ? openSnoozeMenu(row) : null}
      onWake={row.section === "snoozed" ? () => wake(row.session.id) : null}
      onDelete={
        row.section === "settled" && sessionActions(row.session, viewer).own
          ? () => void deleteRow(row)
          : null
      }
    />
  );

  const shownSettled = shelves.settledExpanded
    ? inbox.settled.filter(
        (row, index) => index < shelves.settledShown || row.session.id === focusedSessionId,
      )
    : inbox.settled.filter((row) => row.session.id === focusedSessionId);
  const shownSnoozed = shelves.snoozedExpanded
    ? inbox.snoozed
    : inbox.snoozed.filter((row) => row.session.id === focusedSessionId);
  const hiddenSettled = Math.max(0, inbox.settled.length - shelves.settledShown);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {menuElement}
      <div className="flex items-center gap-1 border-b border-rule-faint px-2 py-1.5">
        <ComposerPill
          disabled={false}
          open={scopeMenu !== null}
          className="h-7 max-w-none min-w-0 flex-1 justify-between px-2 text-[13px] font-medium"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setScopeMenu((current) =>
              current !== null
                ? null
                : { kind: "project", anchor: { left: rect.left, bottom: rect.bottom } },
            );
          }}
        >
          <span className="truncate font-sans">{scope?.name ?? "All projects"}</span>
        </ComposerPill>
        {scope !== null && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            title={`New session in ${scope.name}`}
            aria-label={`New session in ${scope.name}`}
            onClick={() => onLaunch(scope.id)}
            className="size-6 shrink-0 rounded-md font-mono text-[15px] text-label"
          >
            +
          </Button>
        )}
      </div>
      {scope !== null && (
        <div className="border-b border-rule-faint px-2 py-1.5">
          <ToggleGroup
            value={[subView]}
            onValueChange={(value: ReadonlyArray<string>) => {
              const next = SUB_VIEWS.find((candidate) => candidate.id === value[0]);
              if (next !== undefined) sidebarView.setSubView(next.id);
            }}
            size="sm"
            spacing={0}
            className="w-full rounded-lg bg-[var(--sw-sunken)] p-[2px]"
          >
            {SUB_VIEWS.map((candidate) => (
              <ToggleGroupItem
                key={candidate.id}
                value={candidate.id}
                aria-label={candidate.label}
                className="h-6 flex-1 rounded-md px-1.5 font-sans text-[12px] font-medium text-muted-foreground aria-pressed:bg-panel aria-pressed:text-foreground aria-pressed:shadow-xs data-[state=on]:bg-panel data-[state=on]:text-foreground data-[state=on]:shadow-xs"
              >
                {candidate.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {scope !== null && subView === "services" && (
          <ServicesPane
            project={scope}
            sessions={sessionsByProject.get(scope.id) ?? []}
            views={serviceViews}
            onOpen={onServiceFocus}
          />
        )}
        {scope !== null && subView === "prs" && (
          <PullRequestsPane
            project={scope}
            now={now}
            branchesBySession={
              new Map(
                (sessionsByProject.get(scope.id) ?? []).map((session) => [session.branch, session]),
              )
            }
          />
        )}
        {scope !== null && subView === "files" && (
          <FilesPane
            project={scope}
            session={focusedSession?.projectId === scope.id ? focusedSession : null}
          />
        )}
        {(scope === null || subView === "inbox") && (
          <>
            {inbox.active.length === 0 && (
              <p className="px-4 py-3 font-sans text-[12.5px] leading-relaxed text-label">
                {projects.length === 0
                  ? "no projects — adopt one with mend adopt"
                  : scope === null
                    ? "no live sessions"
                    : `no live sessions in ${scope.name} — press + to start one`}
              </p>
            )}
            <ul>{inbox.active.map(renderRow)}</ul>
            {inbox.snoozed.length > 0 && (
              <ShelfHeader
                label="snoozed"
                count={inbox.snoozed.length}
                expanded={shelves.snoozedExpanded}
                onToggle={inboxShelves.toggleSnoozed}
              />
            )}
            {shownSnoozed.length > 0 && <ul>{shownSnoozed.map(renderRow)}</ul>}
            {inbox.settled.length > 0 && (
              <ShelfHeader
                label="settled"
                count={inbox.settled.length}
                expanded={shelves.settledExpanded}
                onToggle={inboxShelves.toggleSettled}
              />
            )}
            {shownSettled.length > 0 && <ul>{shownSettled.map(renderRow)}</ul>}
            {shelves.settledExpanded && hiddenSettled > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={inboxShelves.showMoreSettled}
                className="mx-2 mt-0.5 h-6 rounded-md px-2 font-sans text-[12px] font-normal text-label"
              >
                show {Math.min(SETTLED_PAGE, hiddenSettled)} more
              </Button>
            )}
          </>
        )}
        {error !== null && <p className="px-4 py-1.5 font-mono text-[11px] text-danger">{error}</p>}
      </div>
      {undo !== null && (
        <div className="flex items-center gap-2 border-t border-rule-faint px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-label">
            {undo.text}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              wake(undo.sessionId);
              setUndo(null);
            }}
            className="h-5 rounded-md px-1.5 font-sans text-[11.5px] font-medium text-info hover:text-info"
          >
            Undo
          </Button>
        </div>
      )}
      {scopeMenu !== null && (
        <ComposerMenu state={scopeMenu} onClose={() => setScopeMenu(null)}>
          <MenuRadioGroup
            items={[
              {
                key: "all",
                label: "All projects",
                selected: scope === null,
                onSelect: () => {
                  onScope(null);
                  inboxShelves.resetPaging();
                  setScopeMenu(null);
                },
              },
              ...projects.map((project) => ({
                key: project.id,
                label: project.name,
                detail: project.defaultBranch,
                selected: project.id === scope?.id,
                onSelect: () => {
                  onScope(project.id);
                  inboxShelves.resetPaging();
                  setScopeMenu(null);
                },
              })),
            ]}
          />
        </ComposerMenu>
      )}
      {snoozeMenu !== null && (
        <ComposerMenu state={snoozeMenu} onClose={() => setSnoozeMenu(null)}>
          <MenuRadioGroup
            label="Snooze until"
            items={snoozePresets(new Date()).map((preset) => ({
              key: preset.id,
              label: preset.label,
              detail: describeWake(preset.until, new Date()),
              selected: false,
              onSelect: () => park(snoozeMenu.row, preset.until),
            }))}
          />
        </ComposerMenu>
      )}
    </div>
  );
}

function ShelfHeader({
  label,
  count,
  expanded,
  onToggle,
}: {
  readonly label: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="flex w-full items-center gap-2 px-4 pt-2.5 pb-1 text-left"
    >
      <span className="font-mono text-[10.5px] font-medium tracking-[0.8px] text-label uppercase">
        {label}
      </span>
      <span className="h-px min-w-3 flex-1 bg-[var(--sw-faint-rule)]" />
      {/* The count is the whole footprint of a collapsed shelf. */}
      <span className="font-mono text-[10.5px] text-faint">{expanded ? "" : count}</span>
      <span
        aria-hidden="true"
        className={cn(
          "font-mono text-[11px] text-faint transition-transform",
          expanded && "rotate-90",
        )}
      >
        ›
      </span>
    </button>
  );
}

/**
 * One row. The right edge is one slot: at rest the status word or a time,
 * on hover or `focus-visible` (not focus-within — a click would pin the
 * control over the label forever) the row's one action. Snoozed rows show
 * when they come back, not when they were touched.
 */
function Row({
  row,
  index,
  focused,
  now,
  showProject,
  showJumpHints,
  onFocus,
  onMenu,
  onSnooze,
  onWake,
  onDelete,
}: {
  readonly row: InboxRow;
  readonly index: number;
  readonly focused: boolean;
  readonly now: number;
  readonly showProject: boolean;
  readonly showJumpHints: boolean;
  readonly onFocus: () => void;
  readonly onMenu: (event: React.MouseEvent) => void;
  readonly onSnooze: React.MouseEventHandler<HTMLButtonElement> | null;
  readonly onWake: (() => void) | null;
  readonly onDelete: (() => void) | null;
}) {
  const slim = row.section !== "active";
  const time =
    row.section === "snoozed" && row.wakeAt !== null
      ? wakeLabel(row.wakeAt, now)
      : ago(
          row.section === "settled"
            ? (row.session.settledAt ?? row.session.createdAt)
            : (row.session.startedAt ?? row.session.createdAt),
          now,
        );
  const action =
    onSnooze !== null
      ? { title: "Snooze", icon: <AlarmClock className="size-3.5" />, onClick: onSnooze }
      : onWake !== null
        ? {
            title: "Wake now",
            icon: <AlarmClockOff className="size-3.5" />,
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              onWake();
            },
          }
        : onDelete !== null
          ? {
              title: "Delete session",
              icon: <span className="font-sans text-[11px]">delete</span>,
              onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                if (window.confirm(`Really delete "${row.title}" and its worktree?`)) onDelete();
              },
            }
          : null;
  return (
    <li className="group relative" onContextMenu={onMenu}>
      <button
        type="button"
        onClick={onFocus}
        aria-current={focused ? "true" : undefined}
        className={cn(
          "flex w-full flex-col gap-[2px] pr-3 pl-4 text-left transition-colors",
          slim ? "py-[5px]" : "py-2",
          focused
            ? "border-l-2 border-[var(--sw-accent)] bg-wash pl-[14px]"
            : "hover:bg-[var(--sw-sunken)]",
          row.recede && !focused && "opacity-70 hover:opacity-100",
        )}
      >
        <span className="flex w-full items-center gap-2">
          <StatusDot
            tone={row.section === "snoozed" ? "hollow" : statusToneOf(row)}
            pulse={row.section === "active" && row.session.status === "running"}
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
              "shrink-0 transition-opacity",
              action !== null &&
                "group-hover:opacity-0 group-focus-within:[&:not(:hover)]:opacity-100",
              row.slot === null || row.section === "snoozed"
                ? "font-mono text-[11px] text-faint"
                : `font-sans text-[11.5px] font-medium ${toneText(row.slot.tone)}`,
            )}
          >
            {row.section === "snoozed" ? time : (row.slot?.word ?? time ?? "")}
          </span>
        </span>
        {!slim && (
          <span className="truncate pl-[14px] font-mono text-[11px] text-label">
            {showProject ? `${row.projectName} · ` : ""}
            {row.hold === null ? "" : `${row.hold} · `}
            {row.session.branch}
          </span>
        )}
      </button>
      {action !== null && !showJumpHints && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          title={action.title}
          aria-label={action.title}
          onClick={action.onClick}
          className={cn(
            "absolute right-2 h-5 rounded-md bg-[var(--sw-sunken)] px-1.5 text-label opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100",
            slim ? "top-[5px]" : "top-2",
          )}
        >
          {action.icon}
        </Button>
      )}
      {showJumpHints && index >= 0 && index < 9 && (
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute right-2 rounded-md border border-rule bg-panel px-1.5 font-mono text-[11px] text-muted-foreground shadow-xs",
            slim ? "top-[5px]" : "top-2",
          )}
        >
          {index + 1}
        </span>
      )}
    </li>
  );
}

const statusToneOf = (row: InboxRow) =>
  row.slot?.tone ??
  (row.session.status === "completed"
    ? "green"
    : row.session.status === "failed"
      ? "red"
      : "hollow");
