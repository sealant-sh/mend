import { Schema } from "effect";

import { Timestamp } from "../timestamp.ts";

/** Why a terminal agent waits for the person, as its own hooks reported it. Never inferred. */
export const AgentWaitKind = Schema.Literals(["permission", "question", "prompt"]);
export type AgentWaitKind = typeof AgentWaitKind.Type;

const HookField = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[\x20-\x7e]+$/),
);

export class AgentWait extends Schema.Class<AgentWait>("AgentWait")({
  kind: AgentWaitKind,
  /** The tool a permission wait is about (`Bash`, `shell`); null for the others, or when unknown. */
  tool: Schema.NullOr(HookField),
  /** Server time the wait was first reported; kept across a repeat of the same wait. */
  since: Timestamp,
}) {}

export const HOOKED_HARNESSES = ["claude", "codex"] as const;
export type HookedHarness = (typeof HOOKED_HARNESSES)[number];

/** What the helper forwards from one hook: five small fields, never prompt text, tool input or messages. */
export class AgentHookReport extends Schema.Class<AgentHookReport>("AgentHookReport")({
  harness: Schema.Literals(HOOKED_HARNESSES),
  event: HookField,
  /** Claude's `Notification` only. */
  notificationType: Schema.NullOr(HookField),
  tool: Schema.NullOr(HookField),
  /** The harness's own session id from the hook payload's `session_id`; null when the payload had none. */
  providerSessionId: Schema.NullOr(HookField),
}) {}

export type AgentSignal =
  | { readonly _tag: "waits"; readonly kind: AgentWaitKind; readonly tool: string | null }
  | { readonly _tag: "continues" };

const waits = (kind: AgentWaitKind, tool: string | null = null): AgentSignal => ({
  _tag: "waits",
  kind,
  tool,
});
const CONTINUES: AgentSignal = { _tag: "continues" };

export interface AgentHook {
  readonly event: string;
  /** Claude's matcher for the event; Codex hooks match every occurrence. */
  readonly matcher?: string;
  /** Null: an occurrence Mend does not read. */
  readonly signal: (report: AgentHookReport) => AgentSignal | null;
}

const CLAUDE_NOTIFICATION_WAITS: Readonly<Record<string, AgentWaitKind>> = {
  permission_prompt: "permission",
  elicitation_dialog: "question",
  idle_prompt: "prompt",
};

/**
 * The one table both ends derive from: Claude's `--settings` hooks, Codex's `[hooks]` and the
 * server's reading of a report. `PreToolUse` is absent on purpose: it fires before the permission
 * ask, so it cannot clear one.
 */
export const AGENT_HOOKS: Readonly<Record<HookedHarness, ReadonlyArray<AgentHook>>> = {
  claude: [
    { event: "SessionStart", signal: () => null },
    { event: "PermissionRequest", signal: (report) => waits("permission", report.tool) },
    {
      event: "Notification",
      matcher: Object.keys(CLAUDE_NOTIFICATION_WAITS).join("|"),
      signal: (report) => {
        const kind =
          report.notificationType === null
            ? undefined
            : CLAUDE_NOTIFICATION_WAITS[report.notificationType];
        return kind === undefined ? null : waits(kind);
      },
    },
    { event: "Stop", signal: () => waits("prompt") },
    { event: "UserPromptSubmit", signal: () => CONTINUES },
    { event: "PostToolUse", signal: () => CONTINUES },
  ],
  codex: [
    { event: "SessionStart", signal: () => null },
    { event: "PermissionRequest", signal: (report) => waits("permission", report.tool) },
    { event: "Stop", signal: () => waits("prompt") },
    { event: "UserPromptSubmit", signal: () => CONTINUES },
    { event: "PostToolUse", signal: () => CONTINUES },
  ],
};

export const agentSignalOf = (report: AgentHookReport): AgentSignal | null =>
  AGENT_HOOKS[report.harness].find((hook) => hook.event === report.event)?.signal(report) ?? null;

/** Which of the session's live terminal agents a report is about, if any. */
export type AgentHookTarget<P> =
  | { readonly _tag: "process"; readonly process: P }
  | { readonly _tag: "claim"; readonly process: P; readonly providerSessionId: string }
  | { readonly _tag: "other-process" }
  | { readonly _tag: "unidentified" };

/**
 * `liveAgents` are the session's live agent-pty rows of the report's harness. A report names its
 * process by the harness's own session id. A row that does not know its id yet is claimed only by
 * a `SessionStart`, and only when it is the one such row. Codex's TUI takes no session id on its
 * command line (`codex-rs/tui/src/cli.rs`, rust-v0.160.0: the resume id is internal), so a fresh
 * Codex's id is unknown until it runs; it fires `SessionStart` first thing, and the agent Mend
 * launched is the first process in its workspace (shells open later, through the engine), so
 * that agent's `SessionStart` is the first report of its harness the session can receive. Any
 * id after that (a hand-run `codex`, a `codex exec` the agent starts, Claude after `/clear`)
 * names another process.
 */
export const agentHookTarget = <P extends { readonly providerSessionId: string | null }>(
  report: AgentHookReport,
  liveAgents: ReadonlyArray<P>,
): AgentHookTarget<P> => {
  if (report.providerSessionId === null) return { _tag: "unidentified" };
  const named = liveAgents.find((agent) => agent.providerSessionId === report.providerSessionId);
  if (named !== undefined) return { _tag: "process", process: named };
  const [unnamed, ...more] = liveAgents.filter((agent) => agent.providerSessionId === null);
  return report.event === "SessionStart" && unnamed !== undefined && more.length === 0
    ? { _tag: "claim", process: unnamed, providerSessionId: report.providerSessionId }
    : { _tag: "other-process" };
};

/**
 * Idempotent: a repeat of the same kind answers `current` itself, keeping `since` and a known tool
 * the repeat lacks (Claude's `permission_prompt` follows `PermissionRequest` by ~6 s without one).
 * A permission for another known tool is a new wait: the first one's `PostToolUse` never came.
 */
export const nextAgentWait = (
  current: AgentWait | null,
  signal: AgentSignal,
  now: Date,
): AgentWait | null => {
  if (signal._tag === "continues") return null;
  if (
    current === null ||
    current.kind !== signal.kind ||
    (signal.tool !== null && current.tool !== null && signal.tool !== current.tool)
  ) {
    return new AgentWait({ kind: signal.kind, tool: signal.tool, since: now });
  }
  const tool = signal.tool ?? current.tool;
  return tool === current.tool ? current : new AgentWait({ ...current, tool });
};

export const agentWaitWords = (harness: string, wait: AgentWait): string => {
  switch (wait.kind) {
    case "permission":
      return wait.tool === null
        ? `${harness} needs your permission`
        : `${harness} needs your permission to use ${wait.tool}`;
    case "question":
      return `${harness} asks you a question`;
    case "prompt":
      return `${harness} finished its turn`;
  }
};
