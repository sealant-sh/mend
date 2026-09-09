import { CliRenderEvents, createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { AgentShareHandle, ShareEvent } from "./agent-share.ts";
import {
  deriveAdoptOffer,
  submitDashboardAdoption,
  type AdoptOffer,
} from "./dashboard-adoption.ts";
import {
  deriveHarnesses,
  deriveProjects,
  advanceFromBase,
  type BranchDto,
  type CreatingState,
  deriveRows,
  deriveWorktrees,
  filterBranches,
  foldGroupStatus,
  rowKeyOf,
  worktreeDisplayName,
  fetchWorkbench,
  type HarnessItem,
  enterTargetOf,
  liveProtocolOf,
  liveShellOf,
  mapWorkbenchSessions,
  markSessionStopped,
  removeWorktreeGroup,
  prependSession,
  removeSession,
  replaceSession,
  WORKBENCH_KEY,
  type ProjectItem,
  type SelectableRow,
  type ServiceDto,
  type SessionDto,
  type SessionItem,
  type SessionProcessDto,
  type Workbench,
  type WorktreeGroup,
} from "./dashboard-model.ts";
import { reviewTargetForSession } from "./review-workflow.ts";
import { ReviewScreen } from "./review.tsx";
import {
  cwdFacts,
  HARNESS_COMMANDS,
  isPendingId,
  LIVE_STATUSES,
  matchProjectByCwd,
  normalizeProjectName,
  pendingId,
} from "./shared.ts";
import { openUrl } from "./terminal.ts";
import { COBALT, FAINT, INK, INK_2, MUTED, RED, RULE, SURFACE, WASH } from "./tui-theme.ts";

// Near-mono on purpose: a status is a word, and only an observed failure
// earns color. Live states read at full ink; settled ones recede.
const STATUS_COLOR: Record<string, string> = {
  starting: INK_2,
  running: INK,
  waiting: INK_2,
  idle: INK_2,
  completed: FAINT,
  failed: RED,
  stopped: FAINT,
};

const timeAgo = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
};

import { createSseParser, eventFamilies, type InvalidateFamily } from "./workbench-events.ts";

/** The agent itself is still working: never remove from under it. Idle (agent gone) may go. */
const AGENT_LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting"]);

/**
 * The workbench dashboard (bare `mend`): a drawn multi-pane interface —
 * projects pane and sessions pane side by side, a session detail panel
 * beneath them, and the harness picker as a panel that takes the detail
 * slot. Focus moves between panes (tab, h/l); the cobalt border says which
 * pane the keyboard is in. Rendered with @opentui/react.
 *
 * Server state lives in one TanStack Query cache entry; the SSE stream (the
 * same one the web app uses) is parsed outside React and each pointer event
 * invalidates only the query families it can stale — heartbeats and
 * per-record-line progress invalidate nothing. Writes are optimistic
 * mutations: a rename, a new session, a resume all land in the cache
 * immediately and the server's answer reconciles on settle, so the keyboard
 * never waits on a round trip.
 *
 * This module is imported lazily and only where node:ffi exists (Node 26
 * with --experimental-ffi — main.ts gates and re-execs), so every plain
 * command keeps running dependency-free on Node >= 22.
 */

export interface DashboardContext {
  readonly config: { readonly url: string; readonly token: string | null };
  /** Where the dashboard was opened — resolves the starting project. */
  readonly cwd: string;
  /** The branch checked out there — prefills the base for that project. */
  readonly cwdBranch: string | null;
  /** Server request that THROWS on failure (never exits) — the status line renders it. */
  readonly api: <T>(method: "GET" | "POST" | "DELETE", route: string, body?: unknown) => Promise<T>;
  /** The PTY bridge; resolves when the session settles or the user detaches. */
  readonly attachTty: (
    sessionId: string,
    harness: string,
    processId?: string,
  ) => Promise<"detached" | "ended" | "dropped" | "interrupted" | "unavailable">;
  /** The ssh-agent share running alongside; null when off or no agent. */
  readonly agentShare: AgentShareHandle | null;
}

// ─── panes and rows ─────────────────────────────────────────────────────────

const Gutter = ({ selected }: { readonly selected: boolean }) => (
  <span fg={selected ? COBALT : FAINT}>{selected ? "▌ " : "  "}</span>
);

/**
 * A drawn pane: rounded border, a title in the frame, cobalt when the
 * keyboard lives here. Everything the dashboard shows sits in one of these.
 */
const Pane = ({
  title,
  focused,
  children,
  width,
  height,
  grow,
}: {
  readonly title: string;
  readonly focused: boolean;
  readonly children: ReactNode;
  readonly width?: number;
  readonly height?: number;
  readonly grow?: boolean;
}) => (
  <box
    border
    borderStyle="rounded"
    borderColor={focused ? COBALT : RULE}
    title={` ${title} `}
    titleAlignment="left"
    backgroundColor="transparent"
    {...(width === undefined ? {} : { width, flexShrink: 0, minHeight: 0 })}
    {...(height === undefined ? {} : { height, flexShrink: 0 })}
    {...(grow === true ? { flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0 } : {})}
    flexDirection="column"
  >
    {children}
  </box>
);

const paneScrollStyle = {
  rootOptions: { backgroundColor: "transparent", border: false },
  wrapperOptions: { backgroundColor: "transparent" },
  viewportOptions: { backgroundColor: "transparent" },
  contentOptions: { backgroundColor: "transparent" },
} as const;

const ProjectRow = ({
  item,
  selected,
  nameWidth,
}: {
  readonly item: ProjectItem;
  readonly selected: boolean;
  readonly nameWidth: number;
}) => (
  <box height={1} flexShrink={0} backgroundColor={selected ? WASH : "transparent"}>
    <text height={1} bg="transparent">
      <Gutter selected={selected} />
      <span fg={INK}>{item.project.name.padEnd(nameWidth)}</span>
      <span fg={item.total === 0 ? FAINT : MUTED}>{`  ${item.total}`}</span>
      {item.live > 0 ? <span fg={MUTED}>{` · ${item.live} live`}</span> : null}
      {item.open > 0 ? <span fg={MUTED}>{` · ${item.open}`}</span> : null}
    </text>
  </box>
);

const ProcessLines = ({
  processes,
  services,
  indent,
}: {
  readonly processes: ReadonlyArray<SessionProcessDto>;
  readonly services: ReadonlyArray<ServiceDto>;
  readonly indent: string;
}) => (
  <>
    {processes.map((process) => (
      <box key={process.id} height={1} flexShrink={0} backgroundColor="transparent">
        <text height={1} bg="transparent">
          <span fg={FAINT}>{indent}</span>
          <span fg={INK_2}>
            {process.kind === "shell"
              ? (process.label ?? "shell")
              : (process.harness ?? process.kind)}
          </span>
          <span fg={FAINT}>
            {process.kind === "agent-protocol"
              ? " · protocol"
              : process.kind === "agent-external"
                ? " · external"
                : ""}
            {` ${process.status}`}
          </span>
        </text>
      </box>
    ))}
    {services.map((service) => (
      <box key={service.id} height={1} flexShrink={0} backgroundColor="transparent">
        <text height={1} bg="transparent">
          <span fg={FAINT}>{indent}</span>
          <span fg={service.status === "reachable" ? INK_2 : MUTED}>
            {`${service.label ?? service.id.slice(0, 6)} :${service.workspacePort ?? "?"}${service.protocol === "udp" ? "u" : ""}→${service.hostPort ?? "?"}`}
          </span>
          <span fg={FAINT}>{` ${service.status}`}</span>
        </text>
      </box>
    ))}
  </>
);

/** A worktree's header: the place, its folded status, its member facts. */
const WorktreeHeaderRow = ({
  group,
  selected,
}: {
  readonly group: WorktreeGroup;
  readonly selected: boolean;
}) => {
  const folded = foldGroupStatus(group);
  const color = group.live > 0 ? (STATUS_COLOR[folded] ?? MUTED) : FAINT;
  const age = timeAgo(group.sessions.at(-1)?.session.createdAt ?? group.createdAt).replace(
    " ago",
    "",
  );
  const open = group.annotation?.openComments ?? 0;
  return (
    <box height={1} flexShrink={0} backgroundColor={selected ? WASH : "transparent"}>
      <text height={1} bg="transparent">
        <Gutter selected={selected} />
        <span fg={INK}>{group.name.slice(0, 30).padEnd(31)}</span>
        <span fg={color}>{(group.live > 0 ? folded : "settled").padEnd(10)}</span>
        <span fg={FAINT}>{age.padEnd(9)}</span>
        <span fg={MUTED}>
          {`${group.sessions.length} session${group.sessions.length === 1 ? "" : "s"}`}
        </span>
        {open > 0 ? <span fg={MUTED}>{` · ${open} open`}</span> : null}
      </text>
    </box>
  );
};

/** One conversation inside a worktree — the label is its identity. */
const SessionChildRow = ({
  item,
  selected,
}: {
  readonly item: SessionItem;
  readonly selected: boolean;
}) => {
  const { session, services, processes } = item;
  const color = STATUS_COLOR[session.status] ?? MUTED;
  const age = timeAgo(session.createdAt).replace(" ago", "");
  const name = session.label ?? `session ${session.id.slice(0, 8)}`;
  return (
    <box flexShrink={0} flexDirection="column" backgroundColor="transparent">
      <box height={1} flexShrink={0} backgroundColor={selected ? WASH : "transparent"}>
        <text height={1} bg="transparent">
          <Gutter selected={selected} />
          <span fg={FAINT}>{"  └ "}</span>
          <span fg={INK}>{name.slice(0, 26).padEnd(27)}</span>
          <span fg={color}>{session.status.padEnd(10)}</span>
          <span fg={FAINT}>{age.padEnd(9)}</span>
          <span fg={MUTED}>{session.harness.padEnd(10)}</span>
        </text>
      </box>
      <ProcessLines processes={processes} services={services} indent={"       └ "} />
    </box>
  );
};

const HarnessRow = ({
  item,
  selected,
}: {
  readonly item: HarnessItem;
  readonly selected: boolean;
}) => (
  <box height={1} flexShrink={0} backgroundColor={selected ? WASH : "transparent"}>
    <text height={1} bg="transparent">
      <Gutter selected={selected} />
      <span fg={INK}>{item.label.padEnd(12)}</span>
      <span fg={FAINT}>{item.hint}</span>
    </text>
  </box>
);

/**
 * The detail panel: everything about the selected session that the one-line
 * rows no longer carry — branch and base, services, the review state, the
 * summary. The panes above stay scannable because this panel holds the depth.
 */
const SessionDetail = ({ item }: { readonly item: SessionItem | null }) => {
  if (item === null) {
    return (
      <text height={1} bg="transparent" fg={FAINT}>
        {"  no session selected — n starts one"}
      </text>
    );
  }
  const { session, annotation, services } = item;
  const color = STATUS_COLOR[session.status] ?? MUTED;
  const summary = session.summary?.split("\n")[0] ?? null;
  return (
    <>
      <text height={1} bg="transparent">
        <span>{"  "}</span>
        <span fg={color}>{session.status}</span>
        <span fg={FAINT}> · </span>
        <span fg={MUTED}>{session.branch}</span>
        <span fg={FAINT}>
          {session.baseSha === "" ? "" : ` vs ${session.baseRef ?? session.baseSha.slice(0, 12)}`} ·
          started {timeAgo(session.createdAt)}
        </span>
      </text>
      <text height={1} bg="transparent">
        <span>{"  "}</span>
        {services.length === 0 ? (
          <span fg={FAINT}>no services running</span>
        ) : (
          services.slice(0, 3).map((service, index) => (
            <span key={service.id}>
              {index > 0 ? <span fg={FAINT}> · </span> : null}
              <span fg={service.status === "reachable" ? INK_2 : MUTED}>
                {`${service.label ?? service.id.slice(0, 6)} :${service.workspacePort ?? "?"}${service.protocol === "udp" ? "u" : ""}→${service.hostPort ?? "?"} ${service.status}`}
              </span>
            </span>
          ))
        )}
        {services.length > 3 ? <span fg={FAINT}>{` · +${services.length - 3} more`}</span> : null}
      </text>
      <text height={1} bg="transparent">
        <span>{"  "}</span>
        {annotation === undefined || annotation.openComments === 0 ? (
          <span fg={FAINT}>no open review comments</span>
        ) : (
          <span fg={INK_2}>
            {annotation.openComments} open comment{annotation.openComments === 1 ? "" : "s"}
          </span>
        )}
        {annotation?.pendingFollowUp === true ? (
          <>
            <span fg={FAINT}> · </span>
            <span fg={INK_2}>follow-up pending</span>
          </>
        ) : null}
        {annotation?.changeId != null ? (
          <>
            <span fg={FAINT}> · </span>
            <span fg={MUTED}>v reviews the change</span>
          </>
        ) : null}
      </text>
      <text height={1} bg="transparent" fg={summary === null ? FAINT : MUTED}>
        {`  ${summary ?? "no summary yet"}`}
      </text>
    </>
  );
};

// ─── status line: busy ticker or auto-clearing message ──────────────────────

interface StatusMessage {
  readonly text: string;
  readonly at: number;
}

const StatusLine = ({
  busy,
  busyStarted,
  status,
}: {
  readonly busy: string | null;
  readonly busyStarted: number;
  readonly status: StatusMessage | null;
}) => {
  const [now, setNow] = useState(() => Date.now());
  // Timers are the one thing React cannot express declaratively: a 1s tick
  // while busy, and one repaint to clear an expired status message.
  useEffect(() => {
    if (busy !== null) {
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }
    if (status !== null) {
      const timer = setTimeout(() => setNow(Date.now()), 5100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [busy, status]);
  const text =
    busy !== null
      ? ` ${busy} ${Math.max(0, Math.round((now - busyStarted) / 1000))}s`
      : status !== null && Date.now() - status.at < 5000
        ? ` ${status.text}`
        : "";
  return (
    <text height={1} fg={INK_2} bg="transparent">
      {text}
    </text>
  );
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Keep a 1-line-per-row selection inside its scrollbox's real viewport. */
const keepSpanVisible = (scroll: ScrollBoxRenderable | null, top: number, height: number): void => {
  if (scroll === null) return;
  const viewH = Math.max(1, scroll.viewport.height);
  if (top < scroll.scrollTop) scroll.scrollTo(top);
  else if (top + height > scroll.scrollTop + viewH) scroll.scrollTo(top + height - viewH);
};

const keepRowVisible = (scroll: ScrollBoxRenderable | null, index: number): void =>
  keepSpanVisible(scroll, index, 1);

// ─── the app ────────────────────────────────────────────────────────────────

type Focus = "projects" | "sessions";

const PROJECTS_PANE_WIDTH = 30;

/** The header's share fact when no share runs. */
const noShare = (): "off" => "off";

const App = ({ ctx, onQuit }: { readonly ctx: DashboardContext; readonly onQuit: () => void }) => {
  const renderer = useRenderer();
  const queryClient = useQueryClient();
  const { data, failureReason } = useQuery({
    queryKey: WORKBENCH_KEY,
    queryFn: () => fetchWorkbench(ctx),
    // A dev server mid-restart is normal: keep trying, once a second.
    retry: true,
    retryDelay: 1000,
  });

  const [focusState, setFocus] = useState<Focus>("sessions");
  const [projectKey, setProjectKey] = useState<string | null>(null);
  /** A row key (`wt:<id>` | `s:<id>`), so selection survives regrouping. */
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [picker, setPicker] = useState<{
    readonly session: SessionDto | null;
    /** Set when the picker opens a NEW conversation inside this worktree. */
    readonly worktree?: WorktreeGroup;
  } | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyStarted, setBusyStarted] = useState(0);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const shareState = useSyncExternalStore(
    (onChange) => ctx.agentShare?.subscribe(() => onChange()) ?? (() => {}),
    ctx.agentShare === null ? noShare : ctx.agentShare.snapshot,
  );
  const [editing, setEditing] = useState<SessionDto | null>(null);
  /** Session id a stop is armed against; the second press fires it. */
  const [stopArmed, setStopArmed] = useState<string | null>(null);
  /**
   * The whole worktree creation is ONE modal: name, base (fuzzy over the
   * project's branches), harness — every step visible, the active one
   * expanded. Enter advances, esc steps back (cancels from the name).
   */
  const [creating, setCreating] = useState<CreatingState | null>(null);
  /**
   * The cwd has a Git origin the store doesn't know: offer to adopt that URL once per dashboard
   * run. Client filesystem paths never cross the server boundary.
   */
  const [adoptOffer, setAdoptOffer] = useState<AdoptOffer | null>(null);
  const adoptOfferDecided = useRef(false);
  const [reviewing, setReviewing] = useState<{
    readonly session: SessionDto;
    readonly changeId: string;
    readonly projectName: string;
  } | null>(null);
  /** Set synchronously around attach/launch so keystrokes can't double-fire. */
  const lockRef = useRef(false);
  /** Latest modal state for mutation callbacks — closures there go stale. */
  const modalRef = useRef(false);
  modalRef.current = editing !== null || reviewing !== null || picker !== null || creating !== null;

  const { width: terminalCols, height: terminalRows } = useTerminalDimensions();
  const showProjectsPane = terminalCols >= 72;
  const showDetail = terminalRows >= 18;
  const focus: Focus = showProjectsPane ? focusState : "sessions";

  // ── pane data ──
  const projectItems = deriveProjects(data);
  const homeProject =
    data === undefined ? undefined : matchProjectByCwd(data.projects, cwdFacts(ctx.cwd));
  const projectIndexRaw =
    projectKey === null ? -1 : projectItems.findIndex((p) => p.project.id === projectKey);
  const projectIndex =
    projectIndexRaw !== -1
      ? projectIndexRaw
      : Math.max(
          0,
          homeProject === undefined
            ? 0
            : projectItems.findIndex((p) => p.project.id === homeProject.id),
        );
  const selectedProject = projectItems[projectIndex] ?? null;
  const worktreeGroups = deriveWorktrees(data, selectedProject?.project.id ?? null);
  const rows = deriveRows(worktreeGroups);
  const rowIndexRaw =
    sessionKey === null ? -1 : rows.findIndex((row) => rowKeyOf(row) === sessionKey);
  const rowIndex = rowIndexRaw === -1 ? 0 : rowIndexRaw;
  const selectedRow = rows[rowIndex] ?? null;
  const selectedGroup = selectedRow?.group ?? null;
  // A worktree header still names a concrete conversation for session verbs:
  // the newest live member, else the newest at all.
  const selectedSession =
    selectedRow === null
      ? null
      : selectedRow.kind === "session"
        ? selectedRow.item
        : (selectedRow.group.sessions.find((item) => LIVE_STATUSES.has(item.session.status)) ??
          selectedRow.group.sessions[0] ??
          null);
  const pickerItems = picker === null ? [] : deriveHarnesses(picker.session);
  const selectSession = (id: string): void => setSessionKey(`s:${id}`);

  const say = (text: string): void => setStatus({ text, at: Date.now() });
  const refetch = (): void => void queryClient.invalidateQueries({ queryKey: WORKBENCH_KEY });
  // Signature requests are facts from outside React — the status line says them.
  useEffect(() => {
    const share = ctx.agentShare;
    if (share === null) return;
    return share.subscribe((event: ShareEvent | null) => {
      if (event === null) return;
      if (event.kind === "sign-requested") {
        say(`✎ signature requested (${event.context}) — touch your key if it blinks`);
      } else if (event.kind === "signed") say(`✓ signed (${event.seconds.toFixed(1)}s)`);
      else if (event.kind === "not-signed") say(`✗ not signed — ${event.message}`);
    });
  }, [ctx.agentShare]);

  // A repo underfoot that the store has never met: raise the adopt offer the
  // first time the workbench answers and no project matches the cwd.
  useEffect(() => {
    if (data === undefined || adoptOfferDecided.current) return;
    if (homeProject !== undefined) return;
    adoptOfferDecided.current = true;
    setAdoptOffer(deriveAdoptOffer(cwdFacts(ctx.cwd)));
    // homeProject/data identity is enough; ctx.cwd never changes in a run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, homeProject]);

  // Keep each pane's selection on screen — the one imperative escape hatch.
  const projectScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const sessionScrollRef = useRef<ScrollBoxRenderable | null>(null);
  useEffect(() => {
    keepRowVisible(projectScrollRef.current, projectIndex);
  }, [projectIndex]);
  useEffect(() => {
    // Rows vary in height (header = 1; a session row carries its process and
    // service fact lines), so the scroll target is the row's y offset.
    const rowHeight = (row: SelectableRow | undefined): number =>
      row === undefined || row.kind === "worktree"
        ? 1
        : 1 + row.item.processes.length + row.item.services.length;
    let top = 0;
    for (const [index, row] of rows.entries()) {
      if (index === rowIndex) break;
      top += rowHeight(row);
    }
    keepSpanVisible(sessionScrollRef.current, top, rowHeight(rows[rowIndex]));
  }, [rowIndex, rows]);

  const attachFlow = async (session: SessionDto): Promise<void> => {
    const short = session.id.slice(0, 8);
    lockRef.current = true;
    renderer.suspend();
    process.stdout.write(`\nattached · ${session.harness} · ${short} · detach: Ctrl+]\n\n`);
    let outcome: "detached" | "ended" | "dropped" | "interrupted" | "unavailable";
    try {
      outcome = await ctx.attachTty(session.id, session.harness);
      if (outcome === "unavailable") {
        // A live session whose terminal ended (idle: a workspace held open,
        // no PTY behind it). Enter still means "get me in" — REJOIN the shell
        // already holding the workspace when one is live; only open a fresh
        // one when nothing is attachable (stacking a new bash per attempt is
        // how a session ends up held open by orphan shells).
        const detail = await ctx.api<{ readonly processes: ReadonlyArray<SessionProcessDto> }>(
          "GET",
          `/sessions/${session.id}`,
        );
        const liveProtocol = liveProtocolOf(detail.processes);
        const existing = liveShellOf(detail.processes);
        if (liveProtocol !== null) {
          // A phone pickup holds the session in protocol mode — no PTY behind
          // it. Take it over: end the protocol agent, resume the same
          // conversation as a TUI, then attach to that.
          process.stdout.write(`taking over from the protocol session — same conversation…\n\n`);
          await ctx.api<SessionDto>("POST", `/sessions/${session.id}/handoff`, { to: "pty" });
          outcome = await ctx.attachTty(session.id, session.harness);
        } else if (existing !== null) {
          process.stdout.write(`no live terminal — rejoining the open shell\n\n`);
          outcome = await ctx.attachTty(session.id, "shell", existing.id);
        } else {
          const shell = await ctx.api<{ readonly id: string }>(
            "POST",
            `/sessions/${session.id}/shell`,
          );
          process.stdout.write(`no live terminal — opened a shell in the workspace\n\n`);
          outcome = await ctx.attachTty(session.id, "shell", shell.id);
        }
      }
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      renderer.resume();
      lockRef.current = false;
    }
    say(
      outcome === "unavailable"
        ? "attach unavailable — could not connect"
        : outcome === "detached" || outcome === "interrupted"
          ? `detached — ${short} keeps running`
          : outcome === "dropped"
            ? `disconnected — ${short} keeps running`
            : `session settled · ${short}`,
    );
    refetch();
  };

  /** Converge on the server's truth once, after the LAST in-flight mutation. */
  const settleRefetch = (): void => {
    if (queryClient.isMutating() === 1) refetch();
  };
  /** The current cache entry, for surgical optimistic edits. */
  const workbench = (): Workbench | undefined => queryClient.getQueryData<Workbench>(WORKBENCH_KEY);
  const patchWorkbench = (f: (data: Workbench) => Workbench): void => {
    const current = workbench();
    if (current !== undefined) queryClient.setQueryData(WORKBENCH_KEY, f(current));
  };
  /** Attaching yanks the terminal; only do it unasked when nothing else is open. */
  const attachIfIdle = async (session: SessionDto): Promise<void> => {
    if (lockRef.current || modalRef.current) {
      say(`session ready · ${session.id.slice(0, 8)} — enter attaches`);
      return;
    }
    await attachFlow(session);
  };

  // A new session appears as a `starting` row the moment enter is pressed;
  // the keyboard stays free while the workspace provisions, and the terminal
  // attaches when the launch answers — unless something else has the screen.
  const launchMutation = useMutation({
    mutationFn: async (vars: {
      readonly projectId: string;
      readonly harness: string;
      readonly name: string | null;
      readonly base: string | null;
      readonly pendingKey: string;
    }) => {
      const argv = HARNESS_COMMANDS[vars.harness];
      if (argv === undefined) throw new Error(`unknown harness "${vars.harness}"`);
      const session = await ctx.api<SessionDto>("POST", `/projects/${vars.projectId}/sessions`, {
        harness: vars.harness,
        label: null,
        name: vars.name,
        base: vars.base,
      });
      await ctx.api<SessionDto>("POST", `/sessions/${session.id}/launch`, { argv });
      return session;
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      patchWorkbench((current) =>
        prependSession(current, vars.projectId, {
          id: vars.pendingKey,
          harness: vars.harness,
          label: null,
          branch: vars.name === null ? "provisioning…" : `mend/${vars.name}`,
          baseSha: "",
          baseRef: vars.base,
          status: "starting",
          summary: null,
          createdAt: new Date().toISOString(),
        }),
      );
      selectSession(vars.pendingKey);
      setBusy(`provisioning ${vars.harness} workspace — a first launch builds the harness image ·`);
      setBusyStarted(Date.now());
    },
    onError: (error, vars) => {
      patchWorkbench((current) => removeSession(current, vars.projectId, vars.pendingKey));
      setBusy(null);
      say(errorText(error));
    },
    onSuccess: async (session, vars) => {
      patchWorkbench((current) =>
        replaceSession(current, vars.projectId, vars.pendingKey, session),
      );
      selectSession(session.id);
      setBusy(null);
      await attachIfIdle(session);
    },
    onSettled: settleRefetch,
  });

  const resumeMutation = useMutation({
    mutationFn: (vars: {
      readonly projectId: string;
      readonly session: SessionDto;
      readonly harness: string | null;
    }) =>
      ctx.api<SessionDto>("POST", `/sessions/${vars.session.id}/resume`, {
        harness: vars.harness,
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      patchWorkbench((current) =>
        mapWorkbenchSessions(current, (session) =>
          session.id === vars.session.id ? { ...session, status: "starting" } : session,
        ),
      );
      selectSession(vars.session.id);
      setBusy(
        `resuming ${vars.session.id.slice(0, 8)} — a fresh workspace restores the saved state ·`,
      );
      setBusyStarted(Date.now());
    },
    onError: (error) => {
      setBusy(null);
      say(errorText(error));
      refetch();
    },
    onSuccess: async (resumed, vars) => {
      patchWorkbench((current) =>
        replaceSession(current, vars.projectId, vars.session.id, resumed),
      );
      selectSession(resumed.id);
      setBusy(null);
      await attachIfIdle(resumed);
    },
    onSettled: settleRefetch,
  });

  const ADOPT_AUTH_MODES = [
    {
      mode: "ambient",
      label: "ambient",
      hint: "the server machine's own git/ssh setup",
    },
    {
      mode: "mend-key",
      label: "mend-key",
      hint: "the machine's Mend deploy key — add its public half on the git host",
    },
    {
      mode: "bridge",
      label: "bridge",
      hint: "your OWN ssh-agent, relayed while `mend keys share` runs here",
    },
  ] as const;

  const adoptMutation = useMutation({
    mutationFn: (offer: AdoptOffer) =>
      submitDashboardAdoption(ctx.api, {
        name: offer.name,
        source: offer.source,
        gitAuthMode: ADOPT_AUTH_MODES[offer.modeIndex]?.mode ?? "ambient",
      }),
    onMutate: (offer) => {
      setAdoptOffer(null);
      setBusy(`adopting ${offer.name} — cloning into the store ·`);
      setBusyStarted(Date.now());
    },
    onError: (error) => {
      setBusy(null);
      say(errorText(error));
    },
    onSuccess: (result) => {
      setBusy(null);
      if (result.kind === "invalid-source") {
        say(result.message);
        return;
      }
      const project = result.project;
      say(`adopted · ${project.name} — n starts a worktree`);
      setProjectKey(project.id);
      setSessionKey(null);
    },
    onSettled: settleRefetch,
  });

  // The label lands in the row before the server answers; an error puts the
  // truth back on the next refetch.
  const renameMutation = useMutation({
    mutationFn: (vars: { readonly session: SessionDto; readonly label: string | null }) =>
      ctx.api<SessionDto>("POST", `/sessions/${vars.session.id}/label`, { label: vars.label }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      patchWorkbench((current) =>
        mapWorkbenchSessions(current, (session) =>
          session.id === vars.session.id ? { ...session, label: vars.label } : session,
        ),
      );
      say(
        vars.label === null
          ? `label cleared · ${vars.session.id.slice(0, 8)}`
          : `labeled · ${vars.label}`,
      );
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSettled: settleRefetch,
  });

  // Stops are explicit — and armed: the first press names what a second press
  // will stop; moving the selection re-arms against the newly selected row.
  const stopMutation = useMutation({
    mutationFn: (session: SessionDto) =>
      ctx.api<SessionDto>("POST", `/sessions/${session.id}/stop`),
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      // The row settles and its live process/service facts drop in one paint.
      patchWorkbench((current) => markSessionStopped(current, session.id));
      say(`stopped · ${worktreeDisplayName(session)} — the record and review remain`);
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSettled: settleRefetch,
  });

  // A new conversation inside an existing worktree — the `s` key's flow.
  const launchInWorktreeMutation = useMutation({
    mutationFn: async (vars: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly harness: string;
      readonly pendingKey: string;
    }) => {
      const argv = HARNESS_COMMANDS[vars.harness];
      if (argv === undefined) throw new Error(`unknown harness "${vars.harness}"`);
      const session = await ctx.api<SessionDto>("POST", `/worktrees/${vars.worktreeId}/sessions`, {
        harness: vars.harness,
        label: null,
      });
      await ctx.api<SessionDto>("POST", `/sessions/${session.id}/launch`, { argv });
      return session;
    },
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      patchWorkbench((current) =>
        prependSession(current, vars.projectId, {
          id: vars.pendingKey,
          worktreeId: vars.worktreeId,
          harness: vars.harness,
          label: null,
          branch: "joining…",
          baseSha: "",
          baseRef: null,
          status: "starting",
          summary: null,
          createdAt: new Date().toISOString(),
        }),
      );
      selectSession(vars.pendingKey);
      setBusy(`starting ${vars.harness} in the worktree ·`);
      setBusyStarted(Date.now());
    },
    onError: (error, vars) => {
      patchWorkbench((current) => removeSession(current, vars.projectId, vars.pendingKey));
      setBusy(null);
      say(errorText(error));
    },
    onSuccess: async (session, vars) => {
      patchWorkbench((current) =>
        replaceSession(current, vars.projectId, vars.pendingKey, session),
      );
      selectSession(session.id);
      setBusy(null);
      await attachIfIdle(session);
    },
    onSettled: settleRefetch,
  });

  // The one explicit destructive act. Against a pre-worktree server the
  // session delete IS the old combined removal — same key, old semantics.
  const removeWorktreeMutation = useMutation({
    mutationFn: (group: WorktreeGroup) =>
      group.id !== null
        ? ctx.api("DELETE", `/worktrees/${group.id}`)
        : ctx.api("DELETE", `/sessions/${group.sessions[0]?.session.id ?? ""}`),
    onMutate: async (group) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      const projectId = selectedProject?.project.id;
      // The group leaves the list before the server answers; an error refetches truth.
      if (projectId !== undefined) {
        patchWorkbench((current) => removeWorktreeGroup(current, projectId, group));
      }
      say(`removing worktree · ${group.name}`);
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSuccess: (_result, group) => {
      say(`removed · ${group.name}`);
      refetch();
    },
    onSettled: settleRefetch,
  });

  /**
   * One session leaves; the worktree stays. The server stops an idle session's shells and
   * settles it on the way out, so a session killed a moment ago removes without a second stop.
   */
  const removeSessionMutation = useMutation({
    mutationFn: (session: SessionDto) => ctx.api("DELETE", `/sessions/${session.id}`),
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      const projectId = selectedProject?.project.id;
      if (projectId !== undefined) {
        patchWorkbench((current) => removeSession(current, projectId, session.id));
      }
      say(`removing session · ${worktreeDisplayName(session)}`);
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSuccess: (_result, session) => {
      say(`removed · ${worktreeDisplayName(session)} — the worktree remains`);
      refetch();
    },
    onSettled: settleRefetch,
  });
  /** Removal is armed like stops: the first press states the facts. */
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);
  const armRemove = (): void => {
    // A session row removes THAT session; a worktree header removes the whole worktree.
    if (selectedRow?.kind === "session") {
      const session = selectedRow.item.session;
      if (isPendingId(session.id)) return;
      if (AGENT_LIVE_STATUSES.has(session.status)) {
        say(`the agent is still working — kill it first (⇧K) · ${worktreeDisplayName(session)}`);
        return;
      }
      if (removeArmed === session.id) {
        setRemoveArmed(null);
        removeSessionMutation.mutate(session);
        return;
      }
      setRemoveArmed(session.id);
      say(
        `press again to remove session · ${worktreeDisplayName(session)} — its record goes, the worktree stays`,
      );
      return;
    }
    const group = selectedGroup;
    if (group === null || group.sessions.some((item) => isPendingId(item.session.id))) return;
    if (group.live > 0) {
      say(
        `${group.live} session${group.live === 1 ? "" : "s"} live — stop them first · ${group.name}`,
      );
      return;
    }
    if (removeArmed === group.key) {
      setRemoveArmed(null);
      removeWorktreeMutation.mutate(group);
      return;
    }
    setRemoveArmed(group.key);
    const facts =
      group.sessions.length === 1
        ? "its session and change go with it"
        : `${group.sessions.length} sessions and the change go with it`;
    say(`press again to remove worktree · ${group.name} — ${facts}`);
  };

  const armStop = (): void => {
    // A worktree header arms a stop of EVERY live conversation in it.
    if (selectedRow?.kind === "worktree") {
      const group = selectedRow.group;
      const live = group.sessions.filter((item) => LIVE_STATUSES.has(item.session.status));
      if (live.length === 0) {
        say("nothing to stop — the worktree is settled");
        return;
      }
      if (stopArmed === `wt:${group.key}`) {
        setStopArmed(null);
        for (const item of live) stopMutation.mutate(item.session);
        return;
      }
      setStopArmed(`wt:${group.key}`);
      say(
        `press again to stop ${live.length} live session${live.length === 1 ? "" : "s"} · ${group.name}`,
      );
      return;
    }
    const item = selectedSession;
    if (item === null || isPendingId(item.session.id)) return;
    if (!LIVE_STATUSES.has(item.session.status)) {
      say("nothing to stop — the session is settled");
      return;
    }
    if (stopArmed === item.session.id) {
      setStopArmed(null);
      stopMutation.mutate(item.session);
      return;
    }
    setStopArmed(item.session.id);
    say(`press again to stop · ${worktreeDisplayName(item.session)}`);
  };

  /** Open the creation modal; the branch list starts loading immediately. */
  const openCreateModal = (projectId: string): void => {
    setCreating({
      projectId,
      step: "name",
      name: "",
      branches: null,
      query: "",
      baseIndex: 0,
      base: null,
      joins: false,
      harnessIndex: 0,
    });
    // The checkout mend ran in names its branch; creating in THAT project
    // prefills the base with it — the list highlights it once loaded.
    const prefill = projectId === homeProject?.id ? ctx.cwdBranch : null;
    void ctx.api<ReadonlyArray<BranchDto>>("GET", `/projects/${projectId}/branches`).then(
      (branches) =>
        setCreating((current) => {
          if (current === null) return current;
          const match =
            prefill === null ? undefined : branches.find((candidate) => candidate.name === prefill);
          const ordered = filterBranches(branches, "");
          return {
            ...current,
            branches,
            base: match === undefined || match.isDefault ? null : match.name,
            baseIndex:
              match === undefined
                ? 0
                : Math.max(
                    0,
                    ordered.findIndex((candidate) => candidate.name === match.name),
                  ),
          };
        }),
      () =>
        // An unreadable list falls back to the default base; the base step
        // then shows only the default and enter moves on.
        setCreating((current) => (current === null ? current : { ...current, branches: [] })),
    );
  };

  /** Commit the name: an existing name JOINS its worktree — base is fixed. */
  const advanceFromName = (current: CreatingState, raw: string): CreatingState => {
    const slug = normalizeProjectName(raw.trim());
    const name = raw.trim() === "" ? "" : slug;
    const joins =
      name !== "" &&
      (workbench()?.details.get(current.projectId)?.worktrees ?? []).some(
        (candidate) => candidate.name === name,
      );
    // A join fixes the base; otherwise whatever is chosen (the checkout
    // prefill included) rides along untouched.
    return {
      ...current,
      name,
      joins,
      ...(joins ? { base: null } : {}),
      step: joins ? "harness" : "base",
    };
  };

  const submitCreateName = (value: string): void => {
    setCreating((current) => (current === null ? current : advanceFromName(current, value)));
  };

  const submitCreateBase = (): void => {
    setCreating((current) => (current === null ? current : advanceFromBase(current)));
  };

  /** Enter on the harness: everything is chosen — launch. */
  const submitCreateHarness = (): void => {
    const current = creating;
    if (current === null) return;
    const choice = deriveHarnesses(null)[current.harnessIndex];
    if (choice?.harness == null) return;
    setCreating(null);
    setFocus("sessions");
    launchMutation.mutate({
      projectId: current.projectId,
      harness: choice.harness,
      name: current.name === "" ? null : current.name,
      base: current.base,
      pendingKey: pendingId(),
    });
  };

  const resumeSession = (projectId: string, session: SessionDto, harness: string | null): void => {
    setFocus("sessions");
    resumeMutation.mutate({ projectId, session, harness });
  };

  const submitRename = (session: SessionDto, value: string): void => {
    setEditing(null);
    const label = value.trim() === "" ? null : value.trim();
    renameMutation.mutate({ session, label });
  };

  const openPicker = (session: SessionDto | null, worktree?: WorktreeGroup): void => {
    setPicker(worktree === undefined ? { session } : { session, worktree });
    setPickerIndex(0);
  };

  const moveSelection = (delta: number): void => {
    if (picker !== null) {
      setPickerIndex((current) => Math.max(0, Math.min(pickerItems.length - 1, current + delta)));
      return;
    }
    if (focus === "projects") {
      if (projectItems.length === 0) return;
      const next = Math.max(0, Math.min(projectItems.length - 1, projectIndex + delta));
      const item = projectItems[next];
      if (item !== undefined) {
        setProjectKey(item.project.id);
        setSessionKey(null);
      }
      return;
    }
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, rowIndex + delta));
    const row = rows[next];
    if (row !== undefined) setSessionKey(rowKeyOf(row));
  };

  /**
   * Enter on a session whose workspace is still booting. Our own launch or
   * resume attaches by itself when the server answers; one started elsewhere
   * (the web, a phone) needs another Enter once its row reads running.
   */
  const sayStillStarting = (session: SessionDto): void => {
    say(
      busy !== null
        ? `still starting · ${worktreeDisplayName(session)} — attaches when the workspace answers`
        : `still starting · ${worktreeDisplayName(session)} — enter attaches once the row reads running`,
    );
  };

  const activate = (): void => {
    if (picker !== null) {
      const choice = pickerItems[pickerIndex];
      const projectId = selectedProject?.project.id;
      if (choice === undefined || projectId === undefined) return;
      setPicker(null);
      if (picker.worktree !== undefined && picker.worktree.id !== null) {
        if (choice.harness !== null) {
          setFocus("sessions");
          launchInWorktreeMutation.mutate({
            projectId,
            worktreeId: picker.worktree.id,
            harness: choice.harness,
            pendingKey: pendingId(),
          });
        }
      } else if (picker.session !== null) {
        resumeSession(projectId, picker.session, choice.harness);
      }
      return;
    }
    if (focus === "projects") {
      setFocus("sessions");
      return;
    }
    if (selectedRow?.kind === "worktree") {
      // Enter on the place: attach its newest live conversation, or open a
      // new one when nothing is live.
      const target = enterTargetOf(selectedRow.group.sessions.map((item) => item.session));
      if (target.kind === "attach") {
        void attachFlow(target.session);
      } else if (target.kind === "wait") {
        sayStillStarting(target.session);
      } else if (selectedRow.group.id !== null) {
        openPicker(null, selectedRow.group);
      }
      return;
    }
    const item = selectedSession;
    if (item === null) return;
    if (isPendingId(item.session.id)) {
      say("still provisioning — the row fills in when the workspace answers");
      return;
    }
    const target = enterTargetOf([item.session]);
    if (target.kind === "attach") {
      void attachFlow(target.session);
    } else if (target.kind === "wait") {
      sayStillStarting(target.session);
    } else {
      openPicker(item.session);
    }
  };

  useKeyboard((key) => {
    if (reviewing !== null) return;
    if (lockRef.current) return;
    if (key.ctrl && key.name === "c") return onQuit();
    if (adoptOffer !== null) {
      if (key.name === "return" || key.name === "linefeed" || key.name === "y") {
        adoptMutation.mutate(adoptOffer);
      } else if (key.name === "escape" || key.name === "q") {
        setAdoptOffer(null);
        say("not adopted · use mend adopt <url> any time");
      } else if (
        key.name === "right" ||
        key.name === "l" ||
        key.name === "tab" ||
        key.name === "left" ||
        key.name === "h"
      ) {
        const delta = key.name === "left" || key.name === "h" ? -1 : 1;
        setAdoptOffer((current) =>
          current === null
            ? current
            : {
                ...current,
                modeIndex:
                  (current.modeIndex + delta + ADOPT_AUTH_MODES.length) % ADOPT_AUTH_MODES.length,
              },
        );
      }
      return;
    }
    if (editing !== null) {
      // The input owns the keyboard; only escape leaves without saving.
      if (key.name === "escape") setEditing(null);
      return;
    }
    if (creating !== null) {
      // Inputs own the characters (name text, base filter); this handler owns
      // the arrows, esc (a step back; cancel from the name), and the harness
      // step's enter. The name and base enters land through their input's
      // submit so typed-but-unflushed text never races.
      if (key.name === "escape") {
        setCreating((current) => {
          if (current === null) return current;
          if (current.step === "harness") {
            return { ...current, step: current.joins ? "name" : "base" };
          }
          if (current.step === "base") return { ...current, step: "name" };
          say("new worktree cancelled");
          return null;
        });
        return;
      }
      // Tab walks the steps without the enter ceremony: forward commits the
      // active field (the mirrored name, the highlighted branch), shift+tab
      // steps back, and from the harness it wraps around to the name.
      if (key.name === "tab" || key.name === "backtab") {
        const backward = key.name === "backtab" || key.shift === true;
        setCreating((current) => {
          if (current === null) return current;
          if (backward) {
            if (current.step === "harness") {
              return { ...current, step: current.joins ? "name" : "base" };
            }
            if (current.step === "base") return { ...current, step: "name" };
            return current;
          }
          if (current.step === "name") return advanceFromName(current, current.name);
          if (current.step === "base") return advanceFromBase(current);
          return { ...current, step: "name" };
        });
        return;
      }
      const delta =
        key.name === "down" || (key.ctrl === true && key.name === "n")
          ? 1
          : key.name === "up" || (key.ctrl === true && key.name === "p")
            ? -1
            : 0;
      if (delta !== 0) {
        setCreating((current) => {
          if (current === null) return current;
          if (current.step === "base") {
            const matches = filterBranches(current.branches ?? [], current.query).length;
            return {
              ...current,
              baseIndex: Math.max(0, Math.min(matches - 1, current.baseIndex + delta)),
            };
          }
          if (current.step === "harness") {
            const count = deriveHarnesses(null).length;
            return {
              ...current,
              harnessIndex: Math.max(0, Math.min(count - 1, current.harnessIndex + delta)),
            };
          }
          return current;
        });
        return;
      }
      if (
        creating.step === "harness" &&
        (key.name === "return" || key.name === "linefeed" || key.name === "l")
      ) {
        submitCreateHarness();
      }
      return;
    }
    if (picker !== null) {
      switch (key.name) {
        case "down":
        case "j":
          return moveSelection(1);
        case "up":
        case "k":
          return moveSelection(-1);
        case "return":
        case "linefeed":
        case "l":
          return activate();
        case "escape":
        case "q":
        case "h":
          return setPicker(null);
        default:
          return;
      }
    }
    // Shift+K (and x below): stop the selected session. Lowercase k stays
    // vim-up; the shift is the deliberateness the arm-confirm then doubles.
    if (key.shift === true && key.name === "k") return armStop();
    // Shift+D: remove the selected worktree — the one explicit destructive act.
    if (key.shift === true && key.name === "d") return armRemove();
    switch (key.name) {
      case "q":
        return onQuit();
      case "down":
      case "j":
        return moveSelection(1);
      case "up":
      case "k":
        return moveSelection(-1);
      case "x":
        return armStop();
      case "return":
      case "linefeed":
        return activate();
      case "l":
      case "right":
        if (focus === "projects") setFocus("sessions");
        return;
      case "h":
      case "left":
      case "-":
      case "backspace":
        if (showProjectsPane) setFocus("projects");
        return;
      case "tab":
        if (showProjectsPane) setFocus(focus === "projects" ? "sessions" : "projects");
        return;
      case "n":
        // The whole creation is one modal: name, base, harness.
        if (selectedProject !== null) openCreateModal(selectedProject.project.id);
        return;
      case "s": {
        // A new conversation inside the selected worktree.
        const group = selectedGroup;
        if (group === null) return;
        if (group.id === null) {
          say("this server predates shared worktrees — n starts a new one");
          return;
        }
        openPicker(null, group);
        return;
      }
      case "e": {
        const item = selectedSession;
        if (item !== null && !isPendingId(item.session.id)) setEditing(item.session);
        return;
      }
      case "o": {
        const item = selectedSession;
        if (item !== null && !isPendingId(item.session.id)) {
          openUrl(`${ctx.config.url}/sessions/${item.session.id}`);
          say(`opened · ${ctx.config.url}/sessions/${item.session.id.slice(0, 8)}…`);
        }
        return;
      }
      case "v": {
        const item = selectedSession;
        if (item === null) return;
        if (isPendingId(item.session.id)) {
          say("still provisioning — nothing to review yet");
          return;
        }
        const target = reviewTargetForSession(
          item.session,
          selectedGroup?.annotation ?? item.annotation,
          selectedProject?.project.name ?? "project",
        );
        if (target === null) {
          say("this session has no reviewable change yet");
          return;
        }
        setReviewing(target);
        return;
      }
      case "r":
        say("refreshing…");
        refetch();
        return;
      default:
        return;
    }
  });

  // ── chrome ──
  const liveTotal = projectItems.reduce((sum, item) => sum + item.live, 0);
  const nameWidth = Math.min(16, Math.max(...projectItems.map((p) => p.project.name.length), 4));
  const sessionsTitle =
    selectedProject === null
      ? "sessions"
      : `sessions — ${selectedProject.project.name}${
          selectedProject.live > 0 ? ` · ${selectedProject.live} live` : ""
        }`;
  const detailTitle =
    selectedSession === null || selectedGroup === null
      ? "session"
      : `worktree — ${selectedGroup.name} · ${selectedSession.session.harness} ${selectedSession.session.id.slice(0, 8)}`;
  const pickerTitle =
    picker === null
      ? ""
      : picker.worktree !== undefined
        ? `new session in ${picker.worktree.name} — pick a harness`
        : picker.session === null
          ? "new session — pick a harness"
          : `resume ${picker.session.id.slice(0, 8)} — pick a harness`;
  // One big fixed-size modal: every step visible at once, nothing shifts as
  // focus moves through name → base → harness.
  const creatingHeight = 2 + 1 + 1 + 6 + 1 + deriveHarnesses(null).length;
  const footerText =
    adoptOffer !== null
      ? " enter adopt · ←→ auth mode · esc not now"
      : editing !== null
        ? " enter save · esc cancel"
        : creating !== null
          ? creating.step === "name"
            ? " enter continue · esc cancel"
            : creating.step === "base"
              ? " type to filter · ↑↓ move · enter choose base · esc back"
              : " ↑↓ move · enter launch · esc back"
          : picker !== null
            ? " ↑↓ move · enter start · esc cancel"
            : focus === "projects"
              ? " ↑↓ move · enter/l sessions · ⇥ panes · r refresh · q quit"
              : " ↑↓ move · enter attach/resume · n new worktree · s session here · ⇧K kill · ⇧D remove · v review · e rename · o web · q quit";

  const loadFailure =
    data === undefined && failureReason !== null
      ? failureReason instanceof Error
        ? failureReason.message
        : String(failureReason)
      : null;

  if (reviewing !== null) {
    return (
      <ReviewScreen
        ctx={ctx}
        projectName={reviewing.projectName}
        session={reviewing.session}
        changeId={reviewing.changeId}
        onBack={() => {
          setReviewing(null);
          refetch();
        }}
        onQuit={onQuit}
      />
    );
  }

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor="transparent">
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text height={1} bg="transparent">
          <span fg={INK}> mend</span>
          <span fg={MUTED}>
            {"  "}
            {projectItems.length} project{projectItems.length === 1 ? "" : "s"}
          </span>
          <span fg={FAINT}> · </span>
          <span fg={liveTotal > 0 ? MUTED : FAINT}>{liveTotal} live</span>
          {shareState === "off" ? null : (
            <>
              <span fg={FAINT}> · </span>
              <span fg={shareState === "connected" ? MUTED : FAINT}>
                {shareState === "connected" ? "agent shared" : "agent share reconnecting"}
              </span>
            </>
          )}
        </text>
        <text height={1} fg={FAINT} bg="transparent">
          {`${ctx.config.url}  `}
        </text>
      </box>
      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row">
        {showProjectsPane ? (
          <Pane title="projects" focused={focus === "projects"} width={PROJECTS_PANE_WIDTH}>
            <scrollbox
              ref={projectScrollRef}
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              style={paneScrollStyle}
            >
              {projectItems.map((item, index) => (
                <ProjectRow
                  key={item.project.id}
                  item={item}
                  selected={index === projectIndex}
                  nameWidth={nameWidth}
                />
              ))}
              {data !== undefined && projectItems.length === 0 ? (
                <text height={1} fg={FAINT} bg="transparent">
                  {"  none adopted yet"}
                </text>
              ) : null}
            </scrollbox>
          </Pane>
        ) : null}
        <Pane title={sessionsTitle} focused={focus === "sessions"} grow>
          <scrollbox
            ref={sessionScrollRef}
            flexGrow={1}
            flexShrink={1}
            minHeight={0}
            style={paneScrollStyle}
          >
            {rows.map((row, index) =>
              row.kind === "worktree" ? (
                <WorktreeHeaderRow
                  key={rowKeyOf(row)}
                  group={row.group}
                  selected={index === rowIndex}
                />
              ) : (
                <SessionChildRow
                  key={rowKeyOf(row)}
                  item={row.item}
                  selected={index === rowIndex}
                />
              ),
            )}
            {data !== undefined && rows.length === 0 ? (
              <text height={1} fg={FAINT} bg="transparent">
                {"  no sessions yet — n starts one"}
              </text>
            ) : null}
            {loadFailure !== null ? (
              <text height={1} fg={INK_2} bg="transparent">
                {`  ${loadFailure} — retrying`}
              </text>
            ) : null}
          </scrollbox>
        </Pane>
      </box>

      {picker !== null ? (
        <Pane title={pickerTitle} focused height={2 + pickerItems.length}>
          {pickerItems.map((item, index) => (
            <HarnessRow key={String(item.harness)} item={item} selected={index === pickerIndex} />
          ))}
        </Pane>
      ) : editing !== null ? (
        <box
          border
          borderStyle="rounded"
          borderColor={COBALT}
          title={` label — ${editing.harness} ${editing.id.slice(0, 8)} `}
          titleAlignment="left"
          backgroundColor="transparent"
          height={3}
          flexShrink={0}
        >
          <input
            focused
            value={editing.label ?? ""}
            placeholder="a few words for what this session is doing (empty clears)"
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={INK}
            focusedTextColor={INK}
            placeholderColor={FAINT}
            cursorColor={INK}
            flexGrow={1}
            onSubmit={(value: unknown) => {
              if (typeof value === "string") submitRename(editing, value);
            }}
          />
        </box>
      ) : showDetail ? (
        <Pane title={detailTitle} focused={false} height={6}>
          <SessionDetail item={selectedSession} />
        </Pane>
      ) : null}

      {adoptOffer !== null ? (
        <box
          position="absolute"
          zIndex={11}
          left={Math.max(1, Math.floor((terminalCols - Math.min(70, terminalCols - 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - 7) / 2))}
          width={Math.min(70, terminalCols - 4)}
          height={7}
          border
          borderStyle="rounded"
          borderColor={COBALT}
          title=" adopt this repository URL? "
          titleAlignment="left"
          backgroundColor={SURFACE}
          flexDirection="column"
        >
          <text height={1} bg={SURFACE}>
            <span>{"  "}</span>
            <span fg={INK}>{adoptOffer.name}</span>
            <span fg={FAINT}>{" · not in the store yet"}</span>
          </text>
          <text height={1} bg={SURFACE} fg={MUTED}>
            {`  ${adoptOffer.source}`}
          </text>
          <text height={1} bg={SURFACE}>
            <span fg={FAINT}>{"  auth  "}</span>
            {ADOPT_AUTH_MODES.map((candidate, index) => (
              <span key={candidate.mode}>
                {index > 0 ? <span fg={FAINT}>{" · "}</span> : null}
                <span fg={index === adoptOffer.modeIndex ? COBALT : FAINT}>
                  {index === adoptOffer.modeIndex ? `▸ ${candidate.label}` : candidate.label}
                </span>
              </span>
            ))}
          </text>
          <text height={1} bg={SURFACE} fg={FAINT}>
            {`        ${ADOPT_AUTH_MODES[adoptOffer.modeIndex]?.hint ?? ""}`}
          </text>
          <text height={1} bg={SURFACE} fg={FAINT}>
            {"  enter adopt · ←→ auth mode · esc not now"}
          </text>
        </box>
      ) : null}
      {creating !== null ? (
        <box
          position="absolute"
          zIndex={10}
          left={Math.max(1, Math.floor((terminalCols - Math.min(74, terminalCols - 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - creatingHeight) / 2))}
          width={Math.min(74, terminalCols - 4)}
          height={creatingHeight}
          border
          borderStyle="rounded"
          borderColor={COBALT}
          title={` new worktree — ${selectedProject?.project.name ?? "project"} `}
          titleAlignment="left"
          backgroundColor={SURFACE}
          flexDirection="column"
        >
          <box height={1} flexShrink={0} flexDirection="row" backgroundColor={SURFACE}>
            <text height={1} bg={SURFACE}>
              <Gutter selected={creating.step === "name"} />
              <span fg={FAINT}>{"name     "}</span>
              {creating.step !== "name" ? (
                <span fg={INK}>{creating.name === "" ? "auto" : creating.name}</span>
              ) : null}
              {creating.joins ? <span fg={FAINT}>{"  · joins the existing worktree"}</span> : null}
            </text>
            {creating.step === "name" ? (
              <input
                focused
                value={creating.name}
                placeholder="e.g. fix-auth (empty = auto · an existing name joins it)"
                backgroundColor={SURFACE}
                focusedBackgroundColor={SURFACE}
                textColor={INK}
                focusedTextColor={INK}
                placeholderColor={FAINT}
                cursorColor={INK}
                flexGrow={1}
                onInput={(value: string) => {
                  const clean = value.replace(/\t/g, "");
                  setCreating((current) =>
                    current === null ? current : { ...current, name: clean },
                  );
                }}
                onSubmit={(value: unknown) => {
                  if (typeof value === "string") submitCreateName(value);
                }}
              />
            ) : null}
          </box>
          <box height={1} flexShrink={0} flexDirection="row" backgroundColor={SURFACE}>
            <text height={1} bg={SURFACE}>
              <Gutter selected={creating.step === "base"} />
              <span fg={FAINT}>{"base     "}</span>
              {creating.step !== "base" ? (
                <span fg={creating.step === "name" && !creating.joins ? FAINT : INK}>
                  {creating.joins
                    ? "fixed by the existing worktree"
                    : (creating.base ?? "default branch")}
                </span>
              ) : null}
            </text>
            {creating.step === "base" ? (
              creating.branches === null ? (
                <text height={1} bg={SURFACE} fg={FAINT}>
                  reading branches…
                </text>
              ) : (
                <input
                  focused
                  value=""
                  placeholder="type to filter (enter = highlighted; empty = default)"
                  backgroundColor={SURFACE}
                  focusedBackgroundColor={SURFACE}
                  textColor={INK}
                  focusedTextColor={INK}
                  placeholderColor={FAINT}
                  cursorColor={INK}
                  flexGrow={1}
                  onInput={(value: string) => {
                    const clean = value.replace(/\t/g, "");
                    setCreating((current) =>
                      current === null ? current : { ...current, query: clean, baseIndex: 0 },
                    );
                  }}
                  onSubmit={() => submitCreateBase()}
                />
              )
            ) : null}
          </box>
          {Array.from({ length: 6 }, (_, index) => {
            const branch =
              creating.joins || creating.branches === null
                ? undefined
                : filterBranches(creating.branches, creating.query)[index];
            const active = creating.step === "base";
            if (branch === undefined) {
              return (
                <text key={`slot-${index}`} height={1} bg={SURFACE} fg={FAINT}>
                  {index === 0 && active && creating.branches !== null
                    ? "     no branch matches — enter uses the default"
                    : " "}
                </text>
              );
            }
            const highlighted = active && index === creating.baseIndex;
            return (
              <box
                key={branch.name}
                height={1}
                flexShrink={0}
                backgroundColor={highlighted ? WASH : SURFACE}
              >
                <text height={1} bg={highlighted ? WASH : SURFACE}>
                  <span fg={FAINT}>{"   "}</span>
                  <Gutter selected={highlighted} />
                  <span fg={active ? INK : FAINT}>{branch.name.slice(0, 40).padEnd(41)}</span>
                  <span fg={FAINT}>{branch.sha.slice(0, 8).padEnd(10)}</span>
                  <span fg={active ? MUTED : FAINT}>
                    {timeAgo(branch.committedAt).replace(" ago", "").padEnd(6)}
                  </span>
                  {branch.isDefault ? <span fg={FAINT}>default</span> : null}
                </text>
              </box>
            );
          })}
          <text height={1} bg={SURFACE}>
            <Gutter selected={creating.step === "harness"} />
            <span fg={FAINT}>{"harness"}</span>
          </text>
          {deriveHarnesses(null).map((item, index) => {
            const active = creating.step === "harness";
            const highlighted = active && index === creating.harnessIndex;
            return (
              <box
                key={String(item.harness)}
                height={1}
                flexShrink={0}
                backgroundColor={highlighted ? WASH : SURFACE}
              >
                <text height={1} bg={highlighted ? WASH : SURFACE}>
                  <span fg={FAINT}>{"   "}</span>
                  <Gutter selected={highlighted} />
                  <span fg={active ? INK : FAINT}>{item.label.padEnd(12)}</span>
                  <span fg={FAINT}>{active ? item.hint : ""}</span>
                </text>
              </box>
            );
          })}
        </box>
      ) : null}

      <StatusLine busy={busy} busyStarted={busyStarted} status={status} />
      <text height={1} fg={FAINT} bg="transparent">
        {footerText}
      </text>
    </box>
  );
};

// ─── entry ──────────────────────────────────────────────────────────────────

export const runDashboard = async (ctx: DashboardContext): Promise<void> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const queryClient = new QueryClient();
  const controller = new AbortController();
  let eventTimer: ReturnType<typeof setTimeout> | null = null;

  const quit = (): void => {
    controller.abort();
    if (eventTimer !== null) clearTimeout(eventTimer);
    // Drop cached queries so their gc/retry timers stop pinning the event loop.
    queryClient.clear();
    // The canonical opentui shutdown (its own exitOnCtrlC path does exactly
    // this): destroy on the next tick and let the process end on its own. A
    // process.exit() here would race destroy()'s deferred finalize — the
    // kitty keyboard protocol stays pushed and the shell is left eating
    // ^[[..;..:.u key-release sequences.
    process.nextTick(() => renderer.destroy());
  };

  // The SSE stream invalidates the cache from outside React. Frames are
  // parsed and each pointer event stales only its query families — the
  // 25-second heartbeat and per-record-line progress invalidate nothing, so
  // an idle dashboard makes no requests and a busy session doesn't turn push
  // into a refetch loop. The flush waits out in-flight mutations: their
  // onSettled refetch converges on the same truth without a mid-write
  // snapshot clobbering an optimistic row.
  const pendingFamilies = new Set<InvalidateFamily>();
  const flushInvalidations = (): void => {
    eventTimer = null;
    if (queryClient.isMutating() > 0) {
      eventTimer = setTimeout(flushInvalidations, 250);
      return;
    }
    const families = [...pendingFamilies];
    pendingFamilies.clear();
    for (const family of families) {
      void queryClient.invalidateQueries({ queryKey: [family] });
    }
  };
  const scheduleInvalidate = (families: ReadonlyArray<InvalidateFamily>): void => {
    if (families.length === 0) return;
    for (const family of families) pendingFamilies.add(family);
    if (eventTimer === null) eventTimer = setTimeout(flushInvalidations, 250);
  };
  const watch = async (): Promise<void> => {
    while (!controller.signal.aborted) {
      try {
        const headers: Record<string, string> = {};
        if (ctx.config.token !== null) headers["authorization"] = `Bearer ${ctx.config.token}`;
        const response = await fetch(`${ctx.config.url}/api/events`, {
          headers,
          signal: controller.signal,
        });
        if (!response.ok || response.body === null) throw new Error(String(response.status));
        const reader = response.body.getReader();
        const parser = createSseParser();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const payload of parser.push(decoder.decode(value, { stream: true }))) {
            scheduleInvalidate(eventFamilies(payload));
          }
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      // A dropped stream may have swallowed events — re-read once on reconnect.
      pendingFamilies.add("workbench").add("review");
      if (eventTimer === null && !controller.signal.aborted) {
        eventTimer = setTimeout(flushInvalidations, 250);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };
  void watch();

  createRoot(renderer).render(
    <QueryClientProvider client={queryClient}>
      <App ctx={ctx} onQuit={quit} />
    </QueryClientProvider>,
  );
  // finalizeDestroy() emits DESTROY synchronously mid-teardown; this
  // continuation is a microtask, so it runs after the terminal is fully
  // restored. Settling here lets main()'s top-level await finish and the
  // process exit 0 naturally — no process.exit, no unsettled-await code 13.
  await new Promise<void>((resolve) => {
    renderer.once(CliRenderEvents.DESTROY, () => resolve());
  });
};
