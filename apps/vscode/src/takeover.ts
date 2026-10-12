/**
 * Editor-native takeover of a running session — the VS Code counterpart of `mend attach`
 * taking a phone pickup back over. The editor has no TTY client, so it cannot adopt the
 * engine's PTY; its takeover target is the OBSERVED mode instead: end the engine-owned agent,
 * keep the workspace leased by a shell, and resume the same provider conversation by hand in
 * the workspace terminal. Mend observes that process through the mounted harness home as
 * `<harness> (observed)`, carrying the same provider session id, so the record stays one
 * conversation.
 *
 * Pure helpers here; the VS Code calls live in `extension.ts`.
 */

export interface SessionProcessLite {
  readonly id: string;
  readonly kind: string;
  readonly harness: string | null;
  readonly status: string;
  readonly exitedAt: string | null;
  readonly providerSessionId: string | null;
}

/** Agents Mend runs itself — the ones the editor must end before continuing by hand. */
const ENGINE_AGENT_KINDS: ReadonlySet<string> = new Set(["agent-pty", "agent-protocol"]);

/** Live process statuses; `exitedAt` stays the authoritative end marker. */
const LIVE_PROCESS_STATUSES: ReadonlySet<string> = new Set(["starting", "running"]);

/**
 * The engine-owned agent the editor would take over: the newest live `agent-pty` (a terminal
 * TUI) or `agent-protocol` (a phone or web pickup). Null = nothing to take — an observed agent
 * is already the user's own process, and a shell-held workspace has no agent at all.
 */
export const liveEngineAgentOf = (
  processes: ReadonlyArray<SessionProcessLite>,
): SessionProcessLite | null =>
  processes.findLast(
    (process) =>
      ENGINE_AGENT_KINDS.has(process.kind) &&
      process.exitedAt === null &&
      LIVE_PROCESS_STATUSES.has(process.status),
  ) ?? null;

/** Where the agent currently runs, for the takeover prompt. */
export const agentModeLabel = (kind: string): string =>
  kind === "agent-protocol" ? "from a phone or the web" : "in a terminal";

/** Provider ids are UUID-shaped; anything else falls back to "the most recent" resume. */
const SAFE_PROVIDER_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * The shell line that continues the same conversation inside the workspace terminal. The
 * harness home is mounted there, so the provider's own resume finds the transcript the
 * engine-run agent was writing a moment ago. Null = no hand-run continuation for this harness.
 */
export const continueCommand = (
  harness: string,
  providerSessionId: string | null,
): string | null => {
  const id =
    providerSessionId !== null && SAFE_PROVIDER_ID.test(providerSessionId)
      ? providerSessionId
      : null;
  switch (harness) {
    case "codex":
      return id === null ? "codex resume --last" : `codex resume ${id}`;
    case "claude":
      return id === null ? "claude --continue" : `claude --resume ${id}`;
    default:
      return null;
  }
};

/**
 * A takeover opens the workspace in a NEW window, and only that window's extension host can
 * create a terminal inside the workspace. The intent crosses over as a record in global state,
 * keyed by the remote authority the new window will carry; it expires unclaimed after this
 * long (a cancelled Remote-SSH connect must not fire a resume days later).
 */
export const PENDING_TAKEOVER_TTL_MS = 10 * 60_000;

export interface PendingTakeover {
  readonly authority: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly harness: string;
  readonly command: string;
  readonly at: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode a stored record; anything malformed reads as no pending takeover. */
export const parsePendingTakeover = (value: unknown): PendingTakeover | null => {
  if (!isRecord(value)) return null;
  const { authority, workspaceId, sessionId, harness, command, at } = value;
  if (
    typeof authority !== "string" ||
    typeof workspaceId !== "string" ||
    typeof sessionId !== "string" ||
    typeof harness !== "string" ||
    typeof command !== "string" ||
    typeof at !== "number"
  ) {
    return null;
  }
  return { authority, workspaceId, sessionId, harness, command, at };
};

/**
 * The pending takeover THIS window should perform: the record names the window's remote
 * authority in full, allowing case normalization, and is still fresh. A workspace-id substring
 * cannot identify its destination. A window on another authority, a local window, or a stale
 * record all read as none — the caller clears a stale record either way.
 */
export const pendingTakeoverFor = (
  stored: unknown,
  remoteAuthority: string | undefined,
  now: number,
): PendingTakeover | null => {
  const pending = parsePendingTakeover(stored);
  if (pending === null || remoteAuthority === undefined) return null;
  if (now - pending.at > PENDING_TAKEOVER_TTL_MS) return null;
  return remoteAuthority.toLowerCase() === pending.authority.toLowerCase() ? pending : null;
};

export const isStalePendingTakeover = (stored: unknown, now: number): boolean => {
  const pending = parsePendingTakeover(stored);
  return pending !== null && now - pending.at > PENDING_TAKEOVER_TTL_MS;
};
