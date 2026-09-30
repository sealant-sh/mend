import { Effect, Schema } from "effect";

import {
  SealantRunId,
  SealantWorkspaceId,
  ServiceId,
  SessionId,
  SessionProcessId,
} from "../ids.ts";
import { Timestamp } from "../timestamp.ts";
import { EFFORT_LEVELS, PERMISSION_MODES } from "./harness-launch.ts";

/**
 * What kind of work a workspace process is doing. A session is the worktree
 * plus its record; everything that interacts with it is a process of one of
 * these kinds (docs/SESSION-SERVICES.md):
 *
 * - `shell`          the image's login shell in the worktree (PTY)
 * - `agent-pty`      a coding-agent TUI — `codex`, `claude`, `opencode` (PTY)
 * - `agent-protocol` a protocol-driven agent (`codex app-server`, claude
 *                    stream-json) — reserved; nothing launches one yet
 * - `agent-external` a coding agent Mend OBSERVED but did not launch — run by
 *                    hand inside a shell, an SSH session, or an editor
 *                    terminal, detected through the session's harness home.
 *                    No PTY of ours (`sealantSessionId` null); liveness is
 *                    observed from harness-state writes, and the row ends when
 *                    the writes go quiet.
 * - `service`        a recipe command: dev server, database (logs + port)
 *
 * A session holds several agent processes over its life (relaunch, follow-up,
 * resume); the change stays one per session because it is worktree vs base.
 */
export const SessionProcessKind = Schema.Literals([
  "shell",
  "agent-pty",
  "agent-protocol",
  "agent-external",
  "service",
]);
export type SessionProcessKind = typeof SessionProcessKind.Type;

/** The kinds whose liveness makes a session `running`. */
export const AGENT_PROCESS_KINDS: ReadonlySet<SessionProcessKind> = new Set<SessionProcessKind>([
  "agent-pty",
  "agent-protocol",
  "agent-external",
]);

export const isAgentProcessKind = (kind: SessionProcessKind): boolean =>
  AGENT_PROCESS_KINDS.has(kind);

/**
 * Observed lifecycle only — never a judgment about the work. `reachable` /
 * `unreachable` belong to Services: the forwarded port answered, or did not.
 */
export const SessionProcessStatus = Schema.Literals([
  "starting",
  "running",
  "reachable",
  "unreachable",
  "exited",
  "stopped",
]);
export type SessionProcessStatus = typeof SessionProcessStatus.Type;

/** Statuses a live (unended) row can carry; `exitedAt` is the authoritative end marker. */
export const LIVE_PROCESS_STATUSES: ReadonlySet<SessionProcessStatus> =
  new Set<SessionProcessStatus>(["starting", "running", "reachable", "unreachable"]);

/**
 * agent-protocol rows: the adapter options this launch applied. Claude carries
 * them on argv, codex only in adapter memory — persisting them is what lets a
 * boot-time rehydrate (or a graceful relaunch) reopen the pipe with the same
 * model, effort, and permission stance.
 */
export const ProtocolLaunchOptions = Schema.Struct({
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.Literals(EFFORT_LEVELS)),
  permissionMode: Schema.Literals(PERMISSION_MODES),
});
export type ProtocolLaunchOptions = typeof ProtocolLaunchOptions.Type;

/**
 * One platform PTY (or supervised process, or adopted Service port) in a
 * session's current workspace. A session has many of these over its life —
 * the agent, shells, Services — each independently attachable and
 * independently settled. Live rows are the workspace's leases: the container
 * is reclaimed only when the last one ends.
 */
export class SessionProcess extends Schema.Class<SessionProcess>("SessionProcess")({
  id: SessionProcessId,
  sessionId: SessionId,
  /** The workspace incarnation this process ran in; processes never migrate. */
  sealantWorkspaceId: SealantWorkspaceId,
  /** The platform interactive-session id — the attach handle. Null for adopted Services (no process of ours). */
  sealantSessionId: Schema.NullOr(Schema.String),
  /** The run recording this process — its record outlives the process AND the workspace. */
  sealantRunId: Schema.NullOr(SealantRunId),
  /** Server-owned launch intent used to reconcile retries after process acceptance. */
  launchCorrelationId: Schema.NullOr(Schema.String),
  /** Stable Service identity when this process is one Service attempt. */
  serviceId: Schema.NullOr(ServiceId),
  /** Monotonic within one Service; null for non-Service and legacy projection rows. */
  attemptOrdinal: Schema.NullOr(Schema.Int),
  kind: SessionProcessKind,
  /**
   * Agent processes: the adapter that launched this process — `codex` · `claude` · `opencode` ·
   * `shell` (an open-workbench launch inside an agent session). Null for shells and Services.
   */
  harness: Schema.NullOr(Schema.String),
  /**
   * Agent processes: the harness's OWN session id, harvested when the process ends (or known
   * up front for a native resume). Resume addresses the latest agent process's id.
   */
  providerSessionId: Schema.NullOr(Schema.String),
  /** agent-protocol rows: the persisted adapter options; null for every other kind and legacy rows. */
  protocolOptions: Schema.NullOr(ProtocolLaunchOptions),
  /** Human name for pickers and lists ("claude", "shell", "web"). */
  label: Schema.NullOr(Schema.String),
  argv: Schema.Array(Schema.String),
  status: SessionProcessStatus,
  /** Observed exit code, when the platform reported one. */
  exitCode: Schema.NullOr(Schema.Int),
  /** Services: the port the process listens on INSIDE the workspace. */
  workspacePort: Schema.NullOr(Schema.Int),
  /** Services: declared transport. UDP relays datagrams; there is no probe. */
  protocol: Schema.Literals(["tcp", "udp"]),
  /** Services: the host port Mend binds on its private interfaces. */
  hostPort: Schema.NullOr(Schema.Int),
  createdAt: Timestamp,
  /**
   * When the process's record first carried output: the first screen an agent drew. Null while
   * it has drawn nothing, for a process with no run of ours, and on rows from before it was
   * observed. Older servers omit it.
   */
  firstOutputAt: Schema.NullOr(Timestamp).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  exitedAt: Schema.NullOr(Timestamp),
  updatedAt: Timestamp,
}) {}
