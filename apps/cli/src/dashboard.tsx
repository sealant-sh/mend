import { CliRenderEvents, createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import type { AgentShareHandle, ShareEvent } from "./agent-share.ts";
import {
  deriveAdoptOffer,
  submitDashboardAdoption,
  type AdoptOffer,
} from "./dashboard-adoption.ts";
import {
  advanceFromBase,
  baseStepNotice,
  clampIndex,
  createLaunchGate,
  deriveHarnesses,
  deriveProjects,
  deriveWorktrees,
  fetchWorkbench,
  filterBranches,
  fitHints,
  foldGroupStatus,
  isNavSection,
  groupActivityAt,
  groupBaseLabel,
  liveProtocolOf,
  liveShellOf,
  mapWorkbenchSessions,
  markServicesStopped,
  markSessionStopped,
  planAttach,
  planLayout,
  planResume,
  prependSession,
  removeSession,
  removeWorktreeGroup,
  replaceSession,
  sessionDisplayName,
  sessionHold,
  stepColumn,
  verbForKey,
  verbHints,
  WORKBENCH_KEY,
  type BranchDto,
  type Column,
  type CreatingState,
  type HarnessItem,
  type NavSection,
  type ProjectItem,
  type SectionLayout,
  type SessionDto,
  type SessionItem,
  type SessionProcessDto,
  type Workbench,
  type WorktreeGroup,
} from "./dashboard-model.ts";
import {
  fetchTranscript,
  previewLines,
  previewWindow,
  TRANSCRIPT_KEY,
  type PreviewLine,
  type PreviewLineKind,
} from "./dashboard-preview.ts";
import { reviewTargetForSession } from "./review-workflow.ts";
import { ReviewScreen } from "./review.tsx";
import type { OpenTunnel, ServiceTunnels } from "./service-tunnels.ts";
import {
  cwdFacts,
  HARNESS_COMMANDS,
  isPendingId,
  LIVE_STATUSES,
  matchProjectByCwd,
  normalizeProjectName,
  pendingId,
} from "./shared.ts";
import { SnakeBoard, SnakeHeading, SnakeRows, useSnake } from "./snake.tsx";
import { openUrl } from "./terminal.ts";
import {
  ACCENT,
  CANVAS,
  ERROR,
  FAINT,
  INK,
  INK_2,
  MUTED,
  PANEL,
  RULE,
  SURFACE,
  WASH,
} from "./tui-theme.ts";
import { createSseParser, eventFamilies, type InvalidateFamily } from "./workbench-events.ts";

/**
 * The workbench dashboard (bare `mend`): the session pane takes three quarters
 * of the screen, because the record is the thing you are here to read. The
 * remaining quarter is a stacked sidebar — projects, the worktrees inside the
 * selected project, the conversations inside the selected worktree — where the
 * section the keyboard is in stands open and the other two fold to the one line
 * that says what is selected. Reading the record leaves the sidebar as it was.
 *
 * Selection only ever navigates: moving through a section re-populates the ones
 * below it and the session pane previews what the agent has been writing, and
 * NOTHING takes the terminal until an explicit verb asks for it (`a` attach,
 * `r` resume, `n` new session). The accent border says which pane the keyboard
 * is in; ⇥ and ←→ move between them.
 *
 * Nothing is ever squeezed: a terminal too narrow for both gives the whole
 * width to the side the keyboard is on, a terminal too short for three drawn
 * panes shows the open section alone, and a one-line breadcrumb states whatever
 * did not fit.
 *
 * Server state lives in TanStack Query: one workbench entry, plus the selected
 * session's transcript for the preview. The SSE stream (the same one the web
 * app uses) is parsed outside React and each pointer event invalidates only
 * the query families it can stale — heartbeats and per-record-line progress
 * invalidate nothing. Writes are optimistic mutations: a rename, a new
 * session, a resume all land in the cache immediately and the server's answer
 * reconciles on settle, so the keyboard never waits on a round trip.
 *
 * This module is imported lazily and only where node:ffi exists (Node 26
 * with --experimental-ffi — main.ts gates and re-execs), so every plain
 * command keeps running dependency-free on Node >= 22.
 */

// Near-mono on purpose: a status is a word, and only an observed failure
// earns color. Live states read at full ink; settled ones recede.
const STATUS_COLOR: Record<string, string> = {
  starting: INK_2,
  running: INK,
  waiting: INK_2,
  idle: INK_2,
  completed: FAINT,
  failed: ERROR,
  stopped: FAINT,
};

/** The agent itself is still working: never remove from under it. Idle (agent gone) may go. */
const AGENT_LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting"]);

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

const shortAge = (iso: string): string => timeAgo(iso).replace(" ago", "");

/** Cut to width with an ellipsis, so a long name never wraps a one-line row. */
const fit = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

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
  /**
   * The selected session's browser Services on this machine's loopback (a remote server);
   * null on a local server or with --no-tunnel.
   */
  readonly tunnels: ServiceTunnels | null;
  /** `mend snake`: open with the game over the dashboard. */
  readonly openSnake?: boolean;
}

// ─── panes and rows ─────────────────────────────────────────────────────────

const COLUMN_TITLE: Readonly<Record<Column, string>> = {
  projects: "projects",
  worktrees: "worktrees",
  sessions: "sessions",
  detail: "session",
};

/** Rows are two lines in the worktree and session columns: a name, then its facts. */
const WORKTREE_ROW_HEIGHT = 2;
const SESSION_ROW_HEIGHT = 2;

const Gutter = ({ selected }: { readonly selected: boolean }) => (
  <span fg={selected ? ACCENT : FAINT}>{selected ? "▌ " : "  "}</span>
);

/**
 * A drawn pane: the panel ground a step above the canvas, a rounded border, a
 * title in the frame, highlighted when the keyboard lives here. Everything the
 * dashboard shows sits in one of these.
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
    borderColor={focused ? ACCENT : RULE}
    titleColor={focused ? ACCENT : INK}
    title={` ${title} `}
    titleAlignment="left"
    backgroundColor={PANEL}
    overflow="hidden"
    {...(width === undefined ? {} : { width, flexShrink: 0, minHeight: 0 })}
    {...(height === undefined ? {} : { height, flexShrink: 0 })}
    {...(grow === true ? { flexGrow: 1, flexShrink: 1, minHeight: 0, minWidth: 0 } : {})}
    flexDirection="column"
  >
    {children}
  </box>
);

/**
 * A folded section's one line: what is selected there, and the single fact that
 * says what state it is in. It is the section's answer to "where am I", kept
 * where the section itself lives instead of in a breadcrumb somewhere else.
 */
const SummaryRow = ({
  name,
  fact,
  width,
  empty,
}: {
  readonly name: string;
  readonly fact: string;
  readonly width: number;
  readonly empty: boolean;
}) => {
  const factWidth = fact === "" ? 0 : Math.min(fact.length, Math.max(0, width - 8));
  const nameWidth = Math.max(4, width - factWidth - 3);
  return (
    <text height={1} bg="transparent">
      <span fg={FAINT}>{"  "}</span>
      <span fg={empty ? FAINT : INK_2}>{fit(name, nameWidth - 1).padEnd(nameWidth)}</span>
      {factWidth === 0 ? null : <span fg={FAINT}>{fit(fact, factWidth)}</span>}
    </text>
  );
};

const paneScrollStyle = {
  rootOptions: { backgroundColor: "transparent", border: false },
  wrapperOptions: { backgroundColor: "transparent" },
  viewportOptions: { backgroundColor: "transparent" },
  contentOptions: { backgroundColor: "transparent" },
} as const;

/** A pane with nothing in it says why, in the pane's own words. */
const EmptyNote = ({ text }: { readonly text: string }) => (
  <text height={1} fg={FAINT} bg="transparent">
    {`  ${text}`}
  </text>
);

const ProjectRow = ({
  item,
  selected,
  width,
}: {
  readonly item: ProjectItem;
  readonly selected: boolean;
  readonly width: number;
}) => {
  const nameWidth = Math.max(6, width - 9);
  return (
    <box height={1} flexShrink={0} backgroundColor={selected ? WASH : "transparent"}>
      <text height={1} bg="transparent">
        <Gutter selected={selected} />
        <span fg={INK}>{fit(item.project.name, nameWidth).padEnd(nameWidth + 1)}</span>
        <span fg={item.live > 0 ? MUTED : FAINT}>
          {item.live > 0 ? `${item.live}/${item.total}` : String(item.total)}
        </span>
      </text>
    </box>
  );
};

/**
 * A worktree row: the place's name, then what it is — the base it forked from
 * and when it last saw work. Two lines, because a name squeezed next to four
 * facts is a name nobody reads.
 */
const WorktreeRow = ({
  group,
  selected,
  width,
}: {
  readonly group: WorktreeGroup;
  readonly selected: boolean;
  readonly width: number;
}) => {
  const folded = foldGroupStatus(group);
  const live = group.live > 0;
  const status = live ? folded : "settled";
  const color = live ? (STATUS_COLOR[folded] ?? MUTED) : FAINT;
  const open = group.annotation?.openComments ?? 0;
  const sessions = group.sessions.length;
  const nameWidth = Math.max(6, width - 5 - status.length);
  const factWidth = Math.max(8, width - 3);
  // Base first — it is what the worktree IS; the counts drop before it does.
  // One session is the ordinary case and says nothing worth a column of width.
  const facts = fitHints(
    [
      fit(groupBaseLabel(group), factWidth),
      shortAge(groupActivityAt(group)),
      ...(open > 0 ? [`${open} open`] : []),
      ...(sessions === 0 ? ["empty"] : sessions === 1 ? [] : [`${sessions} sessions`]),
    ],
    factWidth,
  );
  return (
    <box flexShrink={0} flexDirection="column" backgroundColor={selected ? WASH : "transparent"}>
      <box height={1} flexShrink={0} backgroundColor="transparent">
        <text height={1} bg="transparent">
          <Gutter selected={selected} />
          <span fg={INK}>{fit(group.name, nameWidth - 1).padEnd(nameWidth)}</span>
          <span fg={color}>{status}</span>
        </text>
      </box>
      <box height={1} flexShrink={0} backgroundColor="transparent">
        <text height={1} bg="transparent" fg={FAINT}>
          {`  ${facts}`}
        </text>
      </box>
    </box>
  );
};

/** One conversation inside the worktree: what it is, then which agent and when. */
const SessionRow = ({
  item,
  selected,
  width,
}: {
  readonly item: SessionItem;
  readonly selected: boolean;
  readonly width: number;
}) => {
  const { session, processes, services } = item;
  const status = session.status;
  const color = STATUS_COLOR[status] ?? MUTED;
  const agents = processes.filter((process) => process.kind !== "shell").length;
  const shells = processes.filter((process) => process.kind === "shell").length;
  const nameWidth = Math.max(6, width - 5 - status.length);
  const factWidth = Math.max(8, width - 3);
  // A stopped agent's Services keep the workspace up: that leads, or it would read as done.
  const hold = sessionHold(item);
  // The harness leads otherwise: it is the fact the machine id used to crowd out.
  const facts = fitHints(
    [
      ...(hold === null ? [] : [hold]),
      session.harness,
      shortAge(session.createdAt),
      ...(shells > 0 ? [`${shells} shell`] : []),
      ...(agents > 0 ? [`${agents} agent`] : []),
      ...(hold === null && services.length > 0 ? [`${services.length} service`] : []),
    ],
    factWidth,
  );
  return (
    <box flexShrink={0} flexDirection="column" backgroundColor={selected ? WASH : "transparent"}>
      <box height={1} flexShrink={0} backgroundColor="transparent">
        <text height={1} bg="transparent">
          <Gutter selected={selected} />
          <span fg={INK}>{fit(sessionDisplayName(session), nameWidth - 1).padEnd(nameWidth)}</span>
          <span fg={color}>{status}</span>
        </text>
      </box>
      <box height={1} flexShrink={0} backgroundColor="transparent">
        <text height={1} bg="transparent" fg={FAINT}>
          {`  ${facts}`}
        </text>
      </box>
    </box>
  );
};

const HarnessRow = ({
  item,
  selected,
  background,
}: {
  readonly item: HarnessItem;
  readonly selected: boolean;
  readonly background: string;
}) => (
  <box height={1} flexShrink={0} backgroundColor={selected ? WASH : background}>
    <text height={1} bg={selected ? WASH : background}>
      <Gutter selected={selected} />
      <span fg={INK}>{item.label.padEnd(12)}</span>
      <span fg={FAINT}>{item.hint}</span>
    </text>
  </box>
);

// ─── the detail column ──────────────────────────────────────────────────────

/** Who spoke: a two-character gutter drawn only on a block's first line. */
const PREVIEW_GLYPH: Readonly<Record<PreviewLineKind, string>> = {
  user: "› ",
  assistant: "  ",
  reasoning: "· ",
  command: "$ ",
  output: "  ",
  meta: "  ",
  blank: "  ",
};

const PREVIEW_COLOR: Readonly<Record<PreviewLineKind, string>> = {
  user: INK,
  assistant: INK_2,
  reasoning: FAINT,
  command: MUTED,
  output: FAINT,
  meta: FAINT,
  blank: FAINT,
};

const PreviewRow = ({ line }: { readonly line: PreviewLine }) => (
  <box height={1} flexShrink={0} backgroundColor="transparent">
    <text height={1} bg="transparent">
      <span fg={FAINT}>{line.lead ? PREVIEW_GLYPH[line.kind] : "  "}</span>
      <span fg={PREVIEW_COLOR[line.kind]}>{line.text}</span>
    </text>
  </box>
);

/**
 * The facts about the selected conversation that the one-line rows cannot
 * carry, most important first — a short pane keeps the first `rows` of them
 * and gives what is left to the record.
 */
const SessionFacts = ({
  group,
  item,
  rows,
  tunnels,
}: {
  readonly group: WorktreeGroup | null;
  readonly item: SessionItem;
  readonly rows: number;
  /** Tunnels open on this machine; a tunneled Service shows where it opens here. */
  readonly tunnels: ReadonlyArray<OpenTunnel>;
}) => {
  const { session, annotation, services } = item;
  const color = STATUS_COLOR[session.status] ?? MUTED;
  const hold = sessionHold(item);
  const summary = session.summary?.split("\n")[0] ?? null;
  const change = annotation ?? group?.annotation;
  const lines: ReadonlyArray<ReactNode> = [
    <text key="name" height={1} bg="transparent">
      <span>{"  "}</span>
      <span fg={INK}>{sessionDisplayName(session)}</span>
      <span fg={FAINT}>{` · ${session.harness}`}</span>
    </text>,
    <text key="status" height={1} bg="transparent">
      <span>{"  "}</span>
      <span fg={color}>{session.status}</span>
      {hold === null ? null : (
        <>
          <span fg={FAINT}>{" · "}</span>
          <span fg={INK_2}>{hold}</span>
        </>
      )}
      <span fg={FAINT}>{" · "}</span>
      <span fg={MUTED}>{session.branch}</span>
      <span fg={FAINT}>
        {session.baseSha === "" ? "" : ` vs ${session.baseRef ?? session.baseSha.slice(0, 12)}`}
      </span>
    </text>,
    <text key="started" height={1} bg="transparent" fg={FAINT}>
      {`  started ${timeAgo(session.createdAt)} · ${isPendingId(session.id) ? "provisioning" : session.id.slice(0, 8)}`}
    </text>,
    <text key="services" height={1} bg="transparent">
      <span>{"  "}</span>
      {services.length === 0 ? (
        <span fg={FAINT}>no services running</span>
      ) : (
        services.slice(0, 2).map((service, index) => {
          const tunnel = tunnels.find((candidate) => candidate.service.id === service.id);
          return (
            <span key={service.id}>
              {index > 0 ? <span fg={FAINT}>{" · "}</span> : null}
              <span fg={service.status === "reachable" ? INK_2 : MUTED}>
                {tunnel === undefined
                  ? `${service.label ?? service.id.slice(0, 6)} :${service.workspacePort ?? "?"}${service.protocol === "udp" ? "u" : ""}→${service.hostPort ?? "?"} ${service.status}`
                  : tunnel.line}
              </span>
            </span>
          );
        })
      )}
      {services.length > 2 ? <span fg={FAINT}>{` · +${services.length - 2} more`}</span> : null}
    </text>,
    <text key="comments" height={1} bg="transparent">
      <span>{"  "}</span>
      {change === undefined || change.openComments === 0 ? (
        <span fg={FAINT}>no open review comments</span>
      ) : (
        <span fg={INK_2}>
          {change.openComments} open comment{change.openComments === 1 ? "" : "s"}
        </span>
      )}
      {change?.pendingFollowUp === true ? (
        <>
          <span fg={FAINT}>{" · "}</span>
          <span fg={INK_2}>follow-up pending</span>
        </>
      ) : null}
      {change?.changeId == null ? null : (
        <>
          <span fg={FAINT}>{" · "}</span>
          <span fg={MUTED}>v reviews the change</span>
        </>
      )}
    </text>,
    <text key="summary" height={1} bg="transparent" fg={summary === null ? FAINT : MUTED}>
      {`  ${fit(summary ?? "no summary yet", 200)}`}
    </text>,
  ];
  return (
    <box flexShrink={0} flexDirection="column" backgroundColor="transparent">
      {lines.slice(0, Math.max(0, rows))}
    </box>
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
    busy === null
      ? status !== null && Date.now() - status.at < 5000
        ? ` ${status.text}`
        : ""
      : ` ${busy} ${Math.max(0, Math.round((now - busyStarted) / 1000))}s`;
  return (
    <text height={1} fg={INK_2} bg="transparent">
      {text}
    </text>
  );
};

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Keep a selection inside its scrollbox. The viewport is passed in rather than
 * read off the renderable: a section that just opened or resized has not laid
 * itself out yet, and the layout already knows exactly how many rows it gave.
 */
const keepSpanVisible = (
  scroll: ScrollBoxRenderable | null,
  top: number,
  height: number,
  viewRows: number,
): void => {
  if (scroll === null || viewRows <= 0) return;
  const viewH = Math.max(1, viewRows);
  // A row taller than the viewport shows its first line: a name half off the
  // top is worse than facts half off the bottom.
  if (top < scroll.scrollTop || height > viewH) scroll.scrollTo(top);
  else if (top + height > scroll.scrollTop + viewH) scroll.scrollTo(top + height - viewH);
};

// ─── the app ────────────────────────────────────────────────────────────────

/** How much of the record the preview keeps in memory — a glance, with scrollback. */
const PREVIEW_MAX_LINES = 300;

/** The facts SessionFacts can state; the preview gets every row they leave. */
const SESSION_FACT_ROWS = 6;

/** The header's share fact when no share runs. */
const noShare = (): "off" => "off";
const NO_TUNNELS: ReadonlyArray<OpenTunnel> = [];
const noTunnels = (): ReadonlyArray<OpenTunnel> => NO_TUNNELS;

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

  const [focus, setFocusState] = useState<Column>("sessions");
  /**
   * The section the sidebar keeps open while the keyboard is in the session
   * pane: reading a record must not fold the list you were just walking.
   */
  const [lastNav, setLastNav] = useState<NavSection>("sessions");
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [worktreeKey, setWorktreeKey] = useState<string | null>(null);
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
  const openTunnels = useSyncExternalStore(
    (onChange) => ctx.tunnels?.subscribe(onChange) ?? (() => {}),
    ctx.tunnels === null ? noTunnels : ctx.tunnels.current,
  );
  const [editing, setEditing] = useState<SessionDto | null>(null);
  /** Session id a stop is armed against; the second press fires it. */
  const [stopArmed, setStopArmed] = useState<string | null>(null);
  /** Removal is armed like stops: the first press states the facts. */
  const [removeArmed, setRemoveArmed] = useState<string | null>(null);
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
  /** Set synchronously around attach so keystrokes can't double-fire. */
  const lockRef = useRef(false);
  /**
   * The starting verbs' one-at-a-time guard. Taken in the key handler BEFORE
   * any await, so a held `r` or a double `enter` on the harness picker cannot
   * provision two workspaces for one intention.
   */
  const [gate] = useState(createLaunchGate);
  const creatingRef = useRef(creating);
  creatingRef.current = creating;
  const branchRequest = useRef(0);

  const { width: terminalCols, height: terminalRows } = useTerminalDimensions();

  // ── selection, left to right ──
  const projectItems = deriveProjects(data);
  const homeProject =
    data === undefined ? undefined : matchProjectByCwd(data.projects, cwdFacts(ctx.cwd));
  const projectIndexRaw =
    projectKey === null ? -1 : projectItems.findIndex((p) => p.project.id === projectKey);
  const projectIndex =
    projectIndexRaw === -1
      ? Math.max(
          0,
          homeProject === undefined
            ? 0
            : projectItems.findIndex((p) => p.project.id === homeProject.id),
        )
      : projectIndexRaw;
  const selectedProject = projectItems[projectIndex] ?? null;
  const worktreeGroups = deriveWorktrees(data, selectedProject?.project.id ?? null);
  const worktreeIndexRaw =
    worktreeKey === null ? -1 : worktreeGroups.findIndex((group) => group.key === worktreeKey);
  const sessionWorktreeIndex = worktreeGroups.findIndex((group) =>
    group.sessions.some((item) => item.session.id === sessionKey),
  );
  const worktreeIndex =
    worktreeIndexRaw === -1 ? Math.max(0, sessionWorktreeIndex) : worktreeIndexRaw;
  const selectedGroup = worktreeGroups[worktreeIndex] ?? null;
  const sessionItems = selectedGroup?.sessions ?? [];
  const sessionIndexRaw =
    sessionKey === null ? -1 : sessionItems.findIndex((item) => item.session.id === sessionKey);
  const sessionIndex = sessionIndexRaw === -1 ? 0 : sessionIndexRaw;
  const selectedItem = sessionItems[sessionIndex] ?? null;
  const selectedSession = selectedItem?.session ?? null;
  const pickerItems = picker === null ? [] : deriveHarnesses(picker.session);

  // ── where every pane sits ──
  const layout = planLayout(terminalCols, terminalRows, focus, lastNav);
  const detailWidth = layout.detailWidth;
  const sectionRows = (section: NavSection): number =>
    layout.sections.find((entry) => entry.section === section)?.rows ?? 0;

  // ── the read-only preview ──
  const previewSessionId =
    selectedSession !== null && !isPendingId(selectedSession.id) ? selectedSession.id : null;
  const previewLive = selectedSession !== null && LIVE_STATUSES.has(selectedSession.status);
  // The selected session's browser Services follow the selection onto this machine's loopback,
  // after a short dwell so walking the list does not bind and release ports per keystroke.
  useEffect(() => {
    const tunnels = ctx.tunnels;
    if (tunnels === null) return;
    const timer = setTimeout(() => void tunnels.focus(previewSessionId), 600);
    return () => clearTimeout(timer);
  }, [ctx.tunnels, previewSessionId]);
  const transcript = useQuery({
    queryKey: TRANSCRIPT_KEY(previewSessionId ?? "none"),
    queryFn: () => fetchTranscript(ctx.api, previewSessionId ?? ""),
    enabled: previewSessionId !== null && selectedSession?.harness !== "shell" && detailWidth > 0,
    staleTime: 3000,
    // A live agent writes while you watch; the record is a read, not an
    // attach, so following it costs one GET while that session is selected.
    refetchInterval: previewLive ? 8000 : false,
    retry: 1,
  });
  const preview = useMemo(
    () =>
      transcript.data === undefined
        ? []
        : previewLines(transcript.data, {
            width: Math.max(16, detailWidth - 6),
            maxLines: PREVIEW_MAX_LINES,
          }),
    [transcript.data, detailWidth],
  );
  /**
   * How far back from the newest line the reader has walked. The preview is
   * pinned to the tail (a new turn appears without moving the view) and this
   * offset is the only thing that moves it, so a growing record can never
   * scroll the newest line off the bottom.
   */
  const [previewOffset, setPreviewOffset] = useState(0);
  // The pane's own rows, split between the facts, their divider and the record.
  // Slicing to exactly what fits is what keeps the newest line on screen — an
  // over-count would push it under the bottom border. A pane too short for the
  // facts drops them from the end rather than pushing the record out.
  const factRows = Math.max(0, Math.min(SESSION_FACT_ROWS, layout.detailRows - 2));
  const showFactRule = factRows > 0 && layout.detailRows - factRows > 1;
  // A session that is still starting has no record to show. The image builds, then the session
  // boots; a first build on a new setup takes about seven minutes. Snake fills the wait.
  const waiting =
    selectedSession !== null &&
    (selectedSession.status === "starting" || isPendingId(selectedSession.id));
  const snake = useSnake({
    width: Math.max(8, Math.min(40, detailWidth - 4)),
    // The pane minus the facts, the rule, the starting line, two lines of hints and the border.
    height: Math.max(4, Math.min(14, layout.detailRows - factRows - 8)),
    enabled: waiting,
  });
  // esc puts the game away for this session; space brings it back.
  const [snakeAwayFor, setSnakeAwayFor] = useState<string | null>(null);
  const snakeShown = waiting && snakeAwayFor !== selectedSession?.id;
  // `mend snake`: the game floats over the whole dashboard until esc, whatever is selected.
  const [snakeOverlay, setSnakeOverlay] = useState(ctx.openSnake === true);
  const overlayWidth = Math.max(16, Math.min(60, terminalCols - 8));
  const overlayHeight = Math.max(6, Math.min(20, terminalRows - 10));
  const overlaySnake = useSnake({
    width: overlayWidth,
    height: overlayHeight,
    enabled: snakeOverlay,
  });
  const previewRows = Math.max(1, layout.detailRows - factRows - (showFactRule ? 1 : 0));
  const previewView = previewWindow(preview, previewRows, previewOffset);

  /** Focus and the sidebar's open section move together. */
  const setFocus = (column: Column): void => {
    setFocusState(column);
    if (isNavSection(column)) setLastNav(column);
  };
  /** Selecting a conversation re-pins its preview to the newest line. */
  const selectSession = (id: string): void => {
    setSessionKey(id);
    setPreviewOffset(0);
  };
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

  // Keep each section's selection on screen — the one imperative escape hatch.
  // The row count is a dependency too: a section that opens, folds or is
  // resized must land on its selected row, not at whatever it was scrolled to.
  const projectScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const worktreeScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const sessionScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const projectRows = sectionRows("projects");
  const worktreeRows = sectionRows("worktrees");
  const sessionRows = sectionRows("sessions");
  useEffect(() => {
    keepSpanVisible(projectScrollRef.current, projectIndex, 1, projectRows);
  }, [projectIndex, projectRows]);
  useEffect(() => {
    keepSpanVisible(
      worktreeScrollRef.current,
      worktreeIndex * WORKTREE_ROW_HEIGHT,
      WORKTREE_ROW_HEIGHT,
      worktreeRows,
    );
  }, [worktreeIndex, worktreeRows]);
  useEffect(() => {
    keepSpanVisible(
      sessionScrollRef.current,
      sessionIndex * SESSION_ROW_HEIGHT,
      SESSION_ROW_HEIGHT,
      sessionRows,
    );
  }, [sessionIndex, sessionRows]);

  const attachFlow = async (session: SessionDto): Promise<void> => {
    const short = session.id.slice(0, 8);
    lockRef.current = true;
    renderer.suspend();
    const tunneled = openTunnels
      .filter((tunnel) => tunnel.service.sessionId === session.id)
      .map((tunnel) => `● ${tunnel.line} · tunnel\n`)
      .join("");
    process.stdout.write(
      `\nattached · ${session.harness} · ${short} · detach: Ctrl+]\n${tunneled}\n`,
    );
    let outcome: "detached" | "ended" | "dropped" | "interrupted" | "unavailable";
    try {
      outcome = await ctx.attachTty(session.id, session.harness);
      if (outcome === "unavailable") {
        // A live session whose terminal ended (idle: a workspace held open,
        // no PTY behind it). `a` still means "get me in" — REJOIN the shell
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
        } else if (existing === null) {
          const shell = await ctx.api<{ readonly id: string }>(
            "POST",
            `/sessions/${session.id}/shell`,
          );
          process.stdout.write(`no live terminal — opened a shell in the workspace\n\n`);
          outcome = await ctx.attachTty(session.id, "shell", shell.id);
        } else {
          process.stdout.write(`no live terminal — rejoining the open shell\n\n`);
          outcome = await ctx.attachTty(session.id, "shell", existing.id);
        }
      }
    } catch (error) {
      say(errorText(error));
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
            ? `disconnected · ${short} — refreshing session status`
            : `terminal ended · ${short} — refreshing session status`,
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

  // A new session appears as a `starting` row the moment the harness is
  // chosen; the keyboard stays free while the workspace provisions. Nothing
  // attaches by itself — the row reads running and `a` takes the terminal.
  const launchMutation = useMutation({
    mutationFn: async (vars: {
      readonly projectId: string;
      readonly harness: string;
      readonly name: string | null;
      readonly base: string | null;
      readonly pendingKey: string;
      readonly gateKey: string;
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
      setWorktreeKey(vars.pendingKey);
      selectSession(vars.pendingKey);
      setBusy(`provisioning ${vars.harness} workspace — a first launch builds the harness image ·`);
      setBusyStarted(Date.now());
    },
    onError: (error, vars) => {
      patchWorkbench((current) => removeSession(current, vars.projectId, vars.pendingKey));
      setBusy(null);
      say(errorText(error));
    },
    onSuccess: (session, vars) => {
      patchWorkbench((current) =>
        replaceSession(current, vars.projectId, vars.pendingKey, session),
      );
      setWorktreeKey((current) =>
        current === vars.pendingKey ? (session.worktreeId ?? session.id) : current,
      );
      setSessionKey((current) => (current === vars.pendingKey ? session.id : current));
      setBusy(null);
      say(`started · ${sessionDisplayName(session)} — a attaches`);
    },
    onSettled: (_data, _error, vars) => {
      gate.release(vars.gateKey);
      settleRefetch();
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (vars: {
      readonly projectId: string;
      readonly session: SessionDto;
      readonly harness: string | null;
      readonly gateKey: string;
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
        `resuming ${sessionDisplayName(vars.session)} — a fresh workspace restores the saved state ·`,
      );
      setBusyStarted(Date.now());
    },
    onError: (error) => {
      setBusy(null);
      say(errorText(error));
      refetch();
    },
    onSuccess: (resumed, vars) => {
      patchWorkbench((current) =>
        replaceSession(current, vars.projectId, vars.session.id, resumed),
      );
      setBusy(null);
      say(`resumed · ${sessionDisplayName(resumed)} — a attaches`);
    },
    onSettled: (_data, _error, vars) => {
      gate.release(vars.gateKey);
      settleRefetch();
    },
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
      say(`adopted · ${project.name} — w starts a worktree`);
      setProjectKey(project.id);
      setWorktreeKey(null);
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
  // A stop leaves Services running; this is their own stop, the ⇧K of a stopped agent's row.
  const stopServicesMutation = useMutation({
    mutationFn: (session: SessionDto) =>
      ctx.api<{ readonly stopped: number }>("POST", `/sessions/${session.id}/services/stop`),
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      patchWorkbench((current) => markServicesStopped(current, session.id));
    },
    onSuccess: (result, session) => {
      say(
        `stopped ${result.stopped} service${result.stopped === 1 ? "" : "s"} · ${sessionDisplayName(session)} — the workspace ends once nothing is live`,
      );
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSettled: settleRefetch,
  });

  const stopMutation = useMutation({
    mutationFn: (session: SessionDto) =>
      ctx.api<SessionDto>("POST", `/sessions/${session.id}/stop`),
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      // The row settles and its live process/service facts drop in one paint.
      patchWorkbench((current) => markSessionStopped(current, session.id));
      say(`stopped · ${sessionDisplayName(session)} — the record and review remain`);
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSettled: settleRefetch,
  });

  // A new conversation inside an existing worktree — the `n` key's flow.
  const launchInWorktreeMutation = useMutation({
    mutationFn: async (vars: {
      readonly projectId: string;
      readonly worktreeId: string;
      readonly harness: string;
      readonly pendingKey: string;
      readonly gateKey: string;
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
    onSuccess: (session, vars) => {
      patchWorkbench((current) =>
        replaceSession(current, vars.projectId, vars.pendingKey, session),
      );
      setSessionKey((current) => (current === vars.pendingKey ? session.id : current));
      setBusy(null);
      say(`started · ${sessionDisplayName(session)} — a attaches`);
    },
    onSettled: (_data, _error, vars) => {
      gate.release(vars.gateKey);
      settleRefetch();
    },
  });

  // The one explicit destructive act. Against a pre-worktree server the
  // session delete IS the old combined removal — same key, old semantics.
  const removeWorktreeMutation = useMutation({
    mutationFn: (group: WorktreeGroup) =>
      group.id === null
        ? ctx.api("DELETE", `/sessions/${group.sessions[0]?.session.id ?? ""}`)
        : ctx.api("DELETE", `/worktrees/${group.id}`),
    onMutate: async (group) => {
      await queryClient.cancelQueries({ queryKey: WORKBENCH_KEY });
      const projectId = selectedProject?.project.id;
      // The group leaves the list before the server answers; an error refetches truth.
      if (projectId !== undefined) {
        patchWorkbench((current) => removeWorktreeGroup(current, projectId, group));
      }
      setWorktreeKey(null);
      setSessionKey(null);
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
      setSessionKey(null);
      say(`removing session · ${sessionDisplayName(session)}`);
    },
    onError: (error) => {
      say(errorText(error));
      refetch();
    },
    onSuccess: (_result, session) => {
      say(`removed · ${sessionDisplayName(session)} — the worktree remains`);
      refetch();
    },
    onSettled: settleRefetch,
  });

  const confirmationVisible = (prefix: string): boolean =>
    busy === null &&
    status !== null &&
    Date.now() - status.at < 5000 &&
    status.text.startsWith(prefix);

  const armRemove = (): void => {
    // The worktree column removes the worktree; anywhere else removes the
    // selected conversation. A row always says what ⇧D will take.
    if (focus === "worktrees") {
      const group = selectedGroup;
      if (group === null || group.sessions.some((item) => isPendingId(item.session.id))) return;
      if (group.live > 0) {
        say(
          `${group.live} session${group.live === 1 ? "" : "s"} live — stop them first (⇧K) · ${group.name}`,
        );
        return;
      }
      if (removeArmed === `wt:${group.key}` && confirmationVisible("press ⇧D again")) {
        setRemoveArmed(null);
        removeWorktreeMutation.mutate(group);
        return;
      }
      setRemoveArmed(`wt:${group.key}`);
      const facts =
        group.sessions.length === 1
          ? "its session and change go with it"
          : `${group.sessions.length} sessions and the change go with it`;
      say(`press ⇧D again to remove worktree · ${group.name} — ${facts}`);
      return;
    }
    const session = selectedSession;
    if (session === null || isPendingId(session.id)) return;
    if (AGENT_LIVE_STATUSES.has(session.status)) {
      say(`the agent is still working — stop it first (⇧K) · ${sessionDisplayName(session)}`);
      return;
    }
    if (removeArmed === session.id && confirmationVisible("press ⇧D again")) {
      setRemoveArmed(null);
      removeSessionMutation.mutate(session);
      return;
    }
    setRemoveArmed(session.id);
    say(
      `press ⇧D again to remove session · ${sessionDisplayName(session)} — its record goes, the worktree stays`,
    );
  };

  const armStop = (): void => {
    // The worktree column arms a stop of EVERY live conversation in it.
    if (focus === "worktrees") {
      const group = selectedGroup;
      if (group === null) return;
      const live = group.sessions.filter((item) => LIVE_STATUSES.has(item.session.status));
      if (live.length === 0) {
        say("nothing to stop — the worktree is settled");
        return;
      }
      if (stopArmed === `wt:${group.key}` && confirmationVisible("press ⇧K again")) {
        setStopArmed(null);
        for (const item of live) stopMutation.mutate(item.session);
        return;
      }
      setStopArmed(`wt:${group.key}`);
      say(
        `press ⇧K again to stop ${live.length} live session${live.length === 1 ? "" : "s"} · ${group.name}`,
      );
      return;
    }
    const session = selectedSession;
    if (session === null || isPendingId(session.id)) return;
    // The agent is no longer live and Services keep the workspace up: ⇧K stops those.
    const hold = selectedItem === null ? null : sessionHold(selectedItem);
    if (hold !== null) {
      if (stopArmed === `svc:${session.id}` && confirmationVisible("press ⇧K again")) {
        setStopArmed(null);
        stopServicesMutation.mutate(session);
        return;
      }
      setStopArmed(`svc:${session.id}`);
      say(`press ⇧K again to stop the services · ${sessionDisplayName(session)} — ${hold}`);
      return;
    }
    if (!LIVE_STATUSES.has(session.status)) {
      say("nothing to stop — the session is settled");
      return;
    }
    if (stopArmed === session.id && confirmationVisible("press ⇧K again")) {
      setStopArmed(null);
      stopMutation.mutate(session);
      return;
    }
    setStopArmed(session.id);
    say(`press ⇧K again to stop · ${sessionDisplayName(session)}`);
  };

  /** Open the creation modal; the branch list starts loading immediately. */
  const openCreateModal = (projectId: string): void => {
    const request = ++branchRequest.current;
    const draft: CreatingState = {
      projectId,
      step: "name",
      name: "",
      branches: null,
      branchError: null,
      query: "",
      baseIndex: 0,
      base: null,
      joins: false,
      harnessIndex: 0,
    };
    creatingRef.current = draft;
    setCreating(draft);
    // The checkout mend ran in names its branch; creating in THAT project
    // prefills the base with it — the list highlights it once loaded.
    const prefill = projectId === homeProject?.id ? ctx.cwdBranch : null;
    void ctx.api<ReadonlyArray<BranchDto>>("GET", `/projects/${projectId}/branches`).then(
      (branches) =>
        setCreating((current) => {
          if (current?.projectId !== projectId || request !== branchRequest.current) return current;
          const match =
            prefill === null ? undefined : branches.find((candidate) => candidate.name === prefill);
          const ordered = filterBranches(branches, "");
          return {
            ...current,
            branches,
            branchError: null,
            // A late response may populate the list, but not change a base
            // the user has already selected or a filter they are navigating.
            ...(current.step === "name" ||
            (current.step === "base" && current.query === "" && current.baseIndex === 0)
              ? {
                  base: match === undefined || match.isDefault ? null : match.name,
                  baseIndex:
                    match === undefined
                      ? 0
                      : Math.max(
                          0,
                          ordered.findIndex((candidate) => candidate.name === match.name),
                        ),
                }
              : {}),
          };
        }),
      (error: unknown) => {
        if (creatingRef.current?.projectId !== projectId || request !== branchRequest.current)
          return;
        const message = errorText(error);
        say(`could not read branches — ${message}`);
        setCreating((current) =>
          current?.projectId === projectId
            ? { ...current, branches: [], branchError: message }
            : current,
        );
      },
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
    const gateKey = `launch:${current.projectId}:${current.name}`;
    if (!gate.take(gateKey)) {
      setCreating(null);
      say("that worktree is already starting — wait for it to finish before starting another");
      return;
    }
    setCreating(null);
    setFocus("sessions");
    launchMutation.mutate({
      projectId: current.projectId,
      harness: choice.harness,
      name: current.name === "" ? null : current.name,
      base: current.base,
      pendingKey: pendingId(),
      gateKey,
    });
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

  // ── the explicit verbs ──

  /** `a` — take the terminal, and only when there is a live one to take. */
  const attachSelected = (): void => {
    const plan = planAttach(selectedSession);
    switch (plan.kind) {
      case "attach":
        void attachFlow(plan.session);
        return;
      case "starting":
        say(
          `still starting · ${sessionDisplayName(plan.session)} — a attaches once the row reads running`,
        );
        return;
      case "settled":
        say(`settled · ${sessionDisplayName(plan.session)} — r resumes it, ⇧D removes it`);
        return;
      case "pending":
        say("still provisioning — the row fills in when the workspace answers");
        return;
      case "none":
        say("no session selected — n starts one");
        return;
    }
  };

  /** `r` — bring a settled conversation back, on a harness you pick. */
  const resumeSelected = (): void => {
    const plan = planResume(selectedSession);
    switch (plan.kind) {
      case "resume":
        if (gate.held(`resume:${plan.session.id}`)) {
          say(`already resuming · ${sessionDisplayName(plan.session)}`);
          return;
        }
        openPicker(plan.session);
        return;
      case "live":
        say(`already live · ${sessionDisplayName(plan.session)} — a attaches`);
        return;
      case "pending":
        say("still provisioning — nothing to resume yet");
        return;
      case "none":
        say("no session selected — n starts one");
        return;
    }
  };

  const resumeSession = (projectId: string, session: SessionDto, harness: string | null): void => {
    const gateKey = `resume:${session.id}`;
    if (!gate.take(gateKey)) {
      say(`already resuming · ${sessionDisplayName(session)}`);
      return;
    }
    setFocus("sessions");
    resumeMutation.mutate({ projectId, session, harness, gateKey });
  };

  /** `n` — another conversation in the selected worktree; a new worktree when there is none. */
  const newSession = (): void => {
    const projectId = selectedProject?.project.id;
    if (projectId === undefined) {
      say("no project selected");
      return;
    }
    const group = selectedGroup;
    // At the project tier nothing names a worktree yet, so the only thing `n`
    // can honestly start there is a new one — never a session in whichever
    // worktree happened to sort first.
    if (focus === "projects") {
      openCreateModal(projectId);
      return;
    }
    if (group === null || group.id === null) {
      // No worktree to join (or a server that predates shared worktrees):
      // the honest thing `n` can start is a new worktree.
      openCreateModal(projectId);
      return;
    }
    if (gate.held(`worktree-session:${group.id}`)) {
      say(`already starting a session in ${group.name}`);
      return;
    }
    openPicker(null, group);
  };

  const launchInWorktree = (projectId: string, group: WorktreeGroup, harness: string): void => {
    if (group.id === null) return;
    const gateKey = `worktree-session:${group.id}`;
    if (!gate.take(gateKey)) {
      say(`already starting a session in ${group.name}`);
      return;
    }
    setFocus("sessions");
    launchInWorktreeMutation.mutate({
      projectId,
      worktreeId: group.id,
      harness,
      pendingKey: pendingId(),
      gateKey,
    });
  };

  // ── movement ──

  const moveSelection = (delta: number): void => {
    if (picker !== null) {
      setPickerIndex((current) => clampIndex(pickerItems.length, current + delta));
      return;
    }
    switch (focus) {
      case "projects": {
        const item = projectItems[clampIndex(projectItems.length, projectIndex + delta)];
        if (item === undefined) return;
        setProjectKey(item.project.id);
        setWorktreeKey(null);
        setSessionKey(null);
        setPreviewOffset(0);
        return;
      }
      case "worktrees": {
        const group = worktreeGroups[clampIndex(worktreeGroups.length, worktreeIndex + delta)];
        if (group === undefined) return;
        setWorktreeKey(group.key);
        setSessionKey(null);
        setPreviewOffset(0);
        return;
      }
      case "sessions": {
        const item = sessionItems[clampIndex(sessionItems.length, sessionIndex + delta)];
        if (item === undefined) return;
        selectSession(item.session.id);
        return;
      }
      case "detail":
        // Down walks toward the newest line, so the offset shrinks.
        setPreviewOffset(
          Math.max(
            0,
            Math.min(Math.max(0, preview.length - previewRows), previewView.offset - delta),
          ),
        );
        return;
    }
  };

  const moveColumn = (delta: number): void => setFocus(stepColumn(focus, delta));

  useKeyboard((key) => {
    if (reviewing !== null) return;
    if (lockRef.current) return;
    if (key.ctrl && key.name === "c") return onQuit();
    if (snakeOverlay) {
      // The game over the dashboard owns the keyboard until esc or q.
      if (key.name === "up" || key.name === "down" || key.name === "left" || key.name === "right") {
        overlaySnake.steer(key.name);
      } else if (key.name === "space") {
        overlaySnake.togglePause();
      } else if (key.name === "escape" || key.name === "q") {
        setSnakeOverlay(false);
      }
      return;
    }
    if (waiting && focus === "detail" && picker === null && editing === null && creating === null) {
      // The snake, while a starting session is in the focused detail pane. The arrows steer it,
      // space pauses it, esc puts it away and space brings it back; h j k l and tab still move
      // the dashboard.
      if (snakeShown) {
        if (
          key.name === "up" ||
          key.name === "down" ||
          key.name === "left" ||
          key.name === "right"
        ) {
          snake.steer(key.name);
          return;
        }
        if (key.name === "space") return snake.togglePause();
        if (key.name === "escape") return setSnakeAwayFor(selectedSession?.id ?? null);
      } else if (key.name === "space") {
        return setSnakeAwayFor(null);
      }
    }
    const verb = verbForKey(key.name ?? "", key.shift === true);
    if (verb !== "stop") setStopArmed(null);
    if (verb !== "remove") setRemoveArmed(null);
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
            return { ...current, baseIndex: clampIndex(matches, current.baseIndex + delta) };
          }
          if (current.step === "harness") {
            const count = deriveHarnesses(null).length;
            return { ...current, harnessIndex: clampIndex(count, current.harnessIndex + delta) };
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
        case "l": {
          const choice = pickerItems[pickerIndex];
          const projectId = selectedProject?.project.id;
          const target = picker;
          if (choice === undefined || projectId === undefined) return;
          setPicker(null);
          if (target.worktree !== undefined) {
            if (choice.harness !== null)
              launchInWorktree(projectId, target.worktree, choice.harness);
          } else if (target.session !== null) {
            resumeSession(projectId, target.session, choice.harness);
          }
          return;
        }
        case "escape":
        case "q":
        case "h":
          return setPicker(null);
        default:
          return;
      }
    }
    // Ctrl-combinations belong to the terminal, never to a bare verb.
    if (key.ctrl === true) return;
    // Project focus never acts on an implicitly selected child session.
    if (
      focus === "projects" &&
      ["attach", "resume", "stop", "remove", "rename", "openWeb", "review"].includes(verb ?? "")
    ) {
      say("select a session first — → opens worktrees");
      return;
    }
    // One table decides what a keystroke means; the footer reads the same one.
    switch (verb) {
      case "quit":
        return onQuit();
      case "moveDown":
        return moveSelection(1);
      case "moveUp":
        return moveSelection(-1);
      case "pageDown":
        return moveSelection(10);
      case "pageUp":
        return moveSelection(-10);
      case "columnRight":
        // Enter DRILLS IN. It never attaches, resumes or starts anything:
        // the only things that take the terminal are a, r and n.
        return moveColumn(1);
      case "columnLeft":
        return moveColumn(-1);
      case "attach":
        return attachSelected();
      case "resume":
        return resumeSelected();
      case "newSession":
        return newSession();
      case "newWorktree":
        if (selectedProject !== null) openCreateModal(selectedProject.project.id);
        return;
      case "stop":
        return armStop();
      case "remove":
        return armRemove();
      case "refresh":
        say("refreshing…");
        refetch();
        void queryClient.invalidateQueries({ queryKey: ["transcript"] });
        return;
      case "rename": {
        const session = selectedSession;
        if (session !== null && !isPendingId(session.id)) setEditing(session);
        return;
      }
      case "openWeb": {
        const session = selectedSession;
        if (session !== null && !isPendingId(session.id)) {
          openUrl(`${ctx.config.url}/sessions/${session.id}`);
          say(`opened · ${ctx.config.url}/sessions/${session.id.slice(0, 8)}…`);
        }
        return;
      }
      case "review": {
        const session = selectedSession;
        if (session === null) return;
        if (isPendingId(session.id)) {
          say("still provisioning — nothing to review yet");
          return;
        }
        const target = reviewTargetForSession(
          session,
          selectedItem?.annotation ?? selectedGroup?.annotation,
          selectedProject?.project.name ?? "project",
        );
        if (target === null) {
          say("this session has no reviewable change yet");
          return;
        }
        setReviewing(target);
        return;
      }
      case null:
        return;
    }
  });

  // ── chrome ──
  const liveTotal = projectItems.reduce((sum, item) => sum + item.live, 0);
  const columnTitle = (column: Column): string => {
    if (column === "worktrees") {
      return selectedProject === null
        ? "worktrees"
        : `worktrees · ${worktreeGroups.length}${selectedProject.live > 0 ? ` · ${selectedProject.live} live` : ""}`;
    }
    if (column === "sessions") {
      return selectedGroup === null ? "sessions" : `sessions · ${sessionItems.length}`;
    }
    if (column === "detail") {
      if (selectedSession === null) return "session";
      return previewView.offset === 0
        ? "session · read-only"
        : `session · read-only · ${previewView.later} newer below`;
    }
    return COLUMN_TITLE[column];
  };
  const pickerTitle =
    picker === null
      ? ""
      : picker.worktree === undefined
        ? picker.session === null
          ? "new session — pick a harness"
          : `resume ${sessionDisplayName(picker.session)} — pick a harness`
        : `new session in ${picker.worktree.name} — pick a harness`;
  // One big fixed-size modal: every step visible at once, nothing shifts as
  // focus moves through name → base → harness.
  const creatingHeight = 2 + 1 + 1 + 6 + 1 + deriveHarnesses(null).length;
  const footerText =
    adoptOffer === null
      ? editing === null
        ? creating === null
          ? picker === null
            ? ` ${fitHints(verbHints(focus), Math.max(12, terminalCols - 2))}`
            : " ↑↓ move · enter start · esc cancel"
          : creating.step === "name"
            ? " enter continue · esc cancel"
            : creating.step === "base"
              ? " type to filter · ↑↓ move · enter choose base · esc back"
              : " ↑↓ move · enter launch · esc back"
        : " enter save · esc cancel"
      : " enter adopt · ←→ auth mode · esc not now";

  const loadFailure =
    data === undefined && failureReason !== null ? errorText(failureReason) : null;

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

  const breadcrumbValue = (column: Column): string => {
    if (column === "projects") return selectedProject?.project.name ?? "no project";
    if (column === "worktrees") return selectedGroup?.name ?? "no worktree";
    return selectedSession === null ? "no session" : sessionDisplayName(selectedSession);
  };

  /** A folded section's single fact: the state of what it has selected. */
  const sectionFact = (section: NavSection): string => {
    if (section === "projects") {
      if (selectedProject === null) return "";
      return selectedProject.live > 0 ? `${selectedProject.live} live` : "settled";
    }
    if (section === "worktrees") {
      if (selectedGroup === null) return "";
      return selectedGroup.live > 0 ? foldGroupStatus(selectedGroup) : "settled";
    }
    return selectedSession?.status ?? "";
  };

  const sectionEmpty = (section: NavSection): boolean =>
    section === "projects"
      ? selectedProject === null
      : section === "worktrees"
        ? selectedGroup === null
        : selectedSession === null;

  // A title wider than its frame is dropped whole by the border, so it is cut
  // to fit first — a pane with no name at all is worse than an elided one.
  const paneTitle = (column: Column, width: number): string =>
    fit(columnTitle(column), Math.max(6, width - 6));

  const renderSection = (entry: SectionLayout): ReactNode => {
    const inner = Math.max(4, layout.sidebarWidth - 2);
    if (!entry.expanded) {
      return (
        <Pane
          key={entry.section}
          title={paneTitle(entry.section, layout.sidebarWidth)}
          focused={false}
          height={entry.height}
        >
          <SummaryRow
            name={breadcrumbValue(entry.section)}
            fact={sectionFact(entry.section)}
            width={inner}
            empty={sectionEmpty(entry.section)}
          />
        </Pane>
      );
    }
    const focused = focus === entry.section;
    switch (entry.section) {
      case "projects":
        return (
          <Pane
            key={entry.section}
            title={paneTitle("projects", layout.sidebarWidth)}
            focused={focused}
            grow
          >
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
                  width={inner}
                />
              ))}
              {data !== undefined && projectItems.length === 0 ? (
                <EmptyNote text="none adopted yet" />
              ) : null}
            </scrollbox>
          </Pane>
        );
      case "worktrees":
        return (
          <Pane
            key={entry.section}
            title={paneTitle("worktrees", layout.sidebarWidth)}
            focused={focused}
            grow
          >
            <scrollbox
              ref={worktreeScrollRef}
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              style={paneScrollStyle}
            >
              {worktreeGroups.map((group, index) => (
                <WorktreeRow
                  key={group.key}
                  group={group}
                  selected={index === worktreeIndex}
                  width={inner}
                />
              ))}
              {data !== undefined && worktreeGroups.length === 0 ? (
                <EmptyNote text="no worktrees — w starts one" />
              ) : null}
            </scrollbox>
          </Pane>
        );
      case "sessions":
        return (
          <Pane
            key={entry.section}
            title={paneTitle("sessions", layout.sidebarWidth)}
            focused={focused}
            grow
          >
            <scrollbox
              ref={sessionScrollRef}
              flexGrow={1}
              flexShrink={1}
              minHeight={0}
              style={paneScrollStyle}
            >
              {sessionItems.map((item, index) => (
                <SessionRow
                  key={item.session.id}
                  item={item}
                  selected={index === sessionIndex}
                  width={inner}
                />
              ))}
              {data !== undefined && sessionItems.length === 0 ? (
                <EmptyNote
                  text={
                    selectedGroup === null ? "no worktree selected" : "no sessions — n starts one"
                  }
                />
              ) : null}
              {loadFailure === null ? null : (
                <text height={1} fg={INK_2} bg="transparent">
                  {`  ${loadFailure} — retrying`}
                </text>
              )}
            </scrollbox>
          </Pane>
        );
    }
  };

  const renderDetail = (): ReactNode => (
    <Pane title={paneTitle("detail", detailWidth + 2)} focused={focus === "detail"} grow>
      {selectedItem === null ? (
        <EmptyNote text="no session selected — n starts one" />
      ) : (
        <>
          <SessionFacts
            group={selectedGroup}
            item={selectedItem}
            rows={factRows}
            tunnels={openTunnels}
          />
          {showFactRule ? (
            <text height={1} bg="transparent" fg={FAINT}>
              {`  ${"─".repeat(Math.max(4, detailWidth - 4))}`}
            </text>
          ) : null}
          <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="column">
            {waiting ? (
              <>
                <text height={1} bg="transparent">
                  <span>{"  "}</span>
                  <span fg={INK_2}>starting</span>
                  <span fg={FAINT}>
                    {
                      " · the image builds, then the session boots · a first build on a new setup takes about 7 minutes"
                    }
                  </span>
                </text>
                {snakeShown ? (
                  <SnakeBoard handle={snake} focused={focus === "detail"} />
                ) : (
                  <EmptyNote text="snake is put away · space brings it back" />
                )}
              </>
            ) : previewSessionId === null ? (
              <EmptyNote text="provisioning — no record yet" />
            ) : selectedSession?.harness === "shell" ? (
              <EmptyNote text="shell — no conversation record; a attaches if live" />
            ) : transcript.isPending ? (
              <EmptyNote text="reading the record…" />
            ) : transcript.error === null ? (
              previewView.lines.length === 0 ? (
                <EmptyNote text="no conversation recorded yet" />
              ) : (
                previewView.lines.map((line, index) => (
                  <PreviewRow key={`${index}-${line.kind}`} line={line} />
                ))
              )
            ) : (
              <text height={1} fg={INK_2} bg="transparent">
                {`  could not read the record — ${errorText(transcript.error)}`}
              </text>
            )}
          </box>
        </>
      )}
    </Pane>
  );

  const offNav = layout.offscreen.filter(isNavSection);
  const detailOffscreen = layout.offscreen.includes("detail");

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={CANVAS}>
      <box height={1} flexDirection="row" justifyContent="space-between">
        <text height={1} bg="transparent">
          <span fg={INK}> mend</span>
          <span fg={MUTED}>
            {"  "}
            {projectItems.length} project{projectItems.length === 1 ? "" : "s"}
          </span>
          <span fg={FAINT}> · </span>
          <span fg={liveTotal > 0 ? MUTED : FAINT}>{liveTotal} live</span>
          {gate.count() > 0 ? (
            <>
              <span fg={FAINT}> · </span>
              <span fg={INK_2}>{gate.count()} starting</span>
            </>
          ) : null}
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
      {!layout.breadcrumb ? null : (
        <text height={1} bg="transparent">
          <span fg={FAINT}>{"  "}</span>
          {offNav.map((column, index) => (
            <span key={column}>
              {index > 0 ? <span fg={FAINT}>{" ▸ "}</span> : null}
              <span fg={index === offNav.length - 1 ? INK_2 : MUTED}>
                {fit(breadcrumbValue(column), 28)}
              </span>
            </span>
          ))}
          <span fg={FAINT}>
            {detailOffscreen ? `${offNav.length > 0 ? " · " : ""}record hidden · → opens it` : " ▸"}
          </span>
        </text>
      )}
      <box flexGrow={1} flexShrink={1} minHeight={0} flexDirection="row">
        {layout.sidebarWidth === 0 ? null : (
          <box
            width={layout.sidebarWidth}
            flexShrink={0}
            minHeight={0}
            flexDirection="column"
            backgroundColor="transparent"
          >
            {layout.sections.map(renderSection)}
          </box>
        )}
        {detailWidth === 0 ? null : renderDetail()}
      </box>

      {snakeOverlay ? (
        <box
          position="absolute"
          zIndex={13}
          left={Math.max(1, Math.floor((terminalCols - (overlayWidth + 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - (overlayHeight + 5)) / 2))}
          width={overlayWidth + 4}
          height={overlayHeight + 5}
          border
          borderStyle="rounded"
          borderColor={ACCENT}
          title=" snake "
          titleAlignment="left"
          backgroundColor={SURFACE}
          flexDirection="column"
        >
          <SnakeHeading handle={overlaySnake} hint="arrows steer · space pauses · esc closes" />
          <box marginLeft={1} flexDirection="column">
            <SnakeRows game={overlaySnake.game} />
          </box>
        </box>
      ) : null}

      {picker === null ? null : (
        <box
          position="absolute"
          zIndex={12}
          left={Math.max(1, Math.floor((terminalCols - Math.min(74, terminalCols - 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - (2 + pickerItems.length)) / 2))}
          width={Math.min(74, terminalCols - 4)}
          height={2 + pickerItems.length}
          border
          borderStyle="rounded"
          borderColor={ACCENT}
          title={` ${pickerTitle} `}
          titleAlignment="left"
          backgroundColor={SURFACE}
          flexDirection="column"
        >
          {pickerItems.map((item, index) => (
            <HarnessRow
              key={String(item.harness)}
              item={item}
              selected={index === pickerIndex}
              background={SURFACE}
            />
          ))}
        </box>
      )}

      {editing === null ? null : (
        <box
          position="absolute"
          zIndex={12}
          left={Math.max(1, Math.floor((terminalCols - Math.min(74, terminalCols - 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - 3) / 2))}
          width={Math.min(74, terminalCols - 4)}
          border
          borderStyle="rounded"
          borderColor={ACCENT}
          title={` label — ${editing.harness} ${editing.id.slice(0, 8)} `}
          titleAlignment="left"
          backgroundColor={SURFACE}
          height={3}
          flexShrink={0}
        >
          <input
            focused
            value={editing.label ?? ""}
            placeholder="a few words for what this session is doing (empty clears)"
            backgroundColor={SURFACE}
            focusedBackgroundColor={SURFACE}
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
      )}

      {adoptOffer === null ? null : (
        <box
          position="absolute"
          zIndex={11}
          left={Math.max(1, Math.floor((terminalCols - Math.min(70, terminalCols - 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - 7) / 2))}
          width={Math.min(70, terminalCols - 4)}
          height={7}
          border
          borderStyle="rounded"
          borderColor={ACCENT}
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
                <span fg={index === adoptOffer.modeIndex ? ACCENT : FAINT}>
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
      )}
      {creating === null ? null : (
        <box
          position="absolute"
          zIndex={10}
          left={Math.max(1, Math.floor((terminalCols - Math.min(74, terminalCols - 4)) / 2))}
          top={Math.max(1, Math.floor((terminalRows - creatingHeight) / 2))}
          width={Math.min(74, terminalCols - 4)}
          height={creatingHeight}
          border
          borderStyle="rounded"
          borderColor={ACCENT}
          title={` new worktree — ${selectedProject?.project.name ?? "project"} `}
          titleAlignment="left"
          backgroundColor={SURFACE}
          flexDirection="column"
        >
          <box height={1} flexShrink={0} flexDirection="row" backgroundColor={SURFACE}>
            <text height={1} bg={SURFACE}>
              <Gutter selected={creating.step === "name"} />
              <span fg={FAINT}>{"name     "}</span>
              {creating.step === "name" ? null : (
                <span fg={INK}>{creating.name === "" ? "auto" : creating.name}</span>
              )}
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
              {creating.step === "base" ? null : (
                <span fg={creating.step === "name" && !creating.joins ? FAINT : INK}>
                  {creating.joins
                    ? "fixed by the existing worktree"
                    : (creating.base ?? "default branch")}
                </span>
              )}
            </text>
            {creating.step === "base" && creating.branches !== null ? (
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
            ) : null}
          </box>
          {Array.from({ length: 6 }, (_, index) => {
            const branch =
              creating.joins || creating.branches === null
                ? undefined
                : filterBranches(creating.branches, creating.query)[index];
            const active = creating.step === "base";
            if (branch === undefined) {
              // The list's own state — loading, the error that stopped it, or
              // genuine emptiness — is stated on the first empty slot.
              const notice = creating.joins ? null : baseStepNotice(creating);
              return (
                <text
                  key={`slot-${index}`}
                  height={1}
                  bg={SURFACE}
                  fg={creating.branchError === null ? FAINT : ERROR}
                >
                  {index === 0 && notice !== null ? `     ${fit(notice, 66)}` : " "}
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
                  <span fg={active ? MUTED : FAINT}>{shortAge(branch.committedAt).padEnd(6)}</span>
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
      )}

      {loadFailure === null ? (
        <StatusLine busy={busy} busyStarted={busyStarted} status={status} />
      ) : (
        <text height={1} fg={ERROR} bg="transparent">
          {` could not load workbench — ${loadFailure} · retrying`}
        </text>
      )}
      <text height={1} fg={FAINT} bg="transparent">
        {footerText}
      </text>
    </box>
  );
};

// ─── entry ──────────────────────────────────────────────────────────────────

export const runDashboard = async (ctx: DashboardContext): Promise<void> => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, backgroundColor: CANVAS });
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
      pendingFamilies.add("workbench").add("review").add("transcript");
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
