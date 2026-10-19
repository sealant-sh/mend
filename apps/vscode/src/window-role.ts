import { MendWorkspace } from "./editor-home.js";
import type { Project, ProjectDetail, Session, SessionProcess } from "./types.js";

/** What this VS Code window is to Mend: a session's workspace, or anything else. */
export type WindowRole =
  | { readonly kind: "local" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

/** The gateway user is `<usernamePrefix>-<workspaceId>`, and a prefix may itself hold dashes. */
const TRAILING_WORKSPACE_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export const windowRole = (
  remoteName: string | undefined,
  folderAuthorities: ReadonlyArray<string>,
): WindowRole => {
  const workspace = MendWorkspace.ofWindow(remoteName, folderAuthorities);
  const workspaceId =
    workspace === null ? undefined : TRAILING_WORKSPACE_ID.exec(workspace.user)?.[1];
  return workspaceId === undefined ? { kind: "local" } : { kind: "workspace", workspaceId };
};

const LIVE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting", "idle"]);

/**
 * The session a workspace window belongs to. Several sessions of one worktree share its
 * workspace; the live one wins, then the newest.
 */
export const sessionOfWorkspace = (
  details: ReadonlyArray<ProjectDetail>,
  workspaceId: string,
): { readonly project: Project; readonly session: Session } | null => {
  const candidates = details
    .flatMap((detail) =>
      detail.sessions
        .filter((session) => session.sealantWorkspaceId === workspaceId)
        .map((session) => ({ project: detail.project, session })),
    )
    .toSorted(
      (left, right) =>
        Number(LIVE_STATUSES.has(right.session.status)) -
          Number(LIVE_STATUSES.has(left.session.status)) ||
        right.session.createdAt.localeCompare(left.session.createdAt),
    );
  return candidates[0] ?? null;
};

/** The terminal tab a workspace window attaches for its session. */
export type AgentTab =
  | { readonly kind: "pty"; readonly processId: string; readonly name: string }
  | { readonly kind: "conversation"; readonly name: string; readonly line: string }
  | { readonly kind: "none" };

const PROCESS_LIVE: ReadonlySet<string> = new Set(["starting", "running"]);

/**
 * A terminal tab's name: what runs in it, then the session. An unlabelled session goes by its
 * short id, since its row name already leads with the harness the tab names first.
 */
export const terminalTabName = (
  session: Pick<Session, "harness" | "label" | "id">,
  process: Pick<SessionProcess, "kind" | "harness"> | null,
): string => {
  const runs =
    process === null || process.kind === "shell" ? "shell" : (process.harness ?? session.harness);
  return `${runs} · ${session.label ?? session.id.slice(0, 8)}`;
};

export const agentTab = (
  session: Pick<Session, "harness" | "label" | "id">,
  processes: ReadonlyArray<SessionProcess>,
): AgentTab => {
  const newestLive = (kind: string) =>
    processes.findLast(
      (process) =>
        process.kind === kind && process.exitedAt === null && PROCESS_LIVE.has(process.status),
    );
  const pty = newestLive("agent-pty");
  if (pty !== undefined) {
    return { kind: "pty", processId: pty.id, name: terminalTabName(session, pty) };
  }
  const conversation = newestLive("agent-protocol");
  if (conversation !== undefined) {
    const harness = conversation.harness ?? session.harness;
    const origin =
      conversation.label === null || conversation.label === harness
        ? "your phone or the web"
        : conversation.label;
    return {
      kind: "conversation",
      name: terminalTabName(session, conversation),
      line: `${harness} is running as a conversation (from ${origin}) · Continue here to type to it`,
    };
  }
  const shell = newestLive("shell");
  return shell === undefined
    ? { kind: "none" }
    : { kind: "pty", processId: shell.id, name: terminalTabName(session, shell) };
};

/** What a conversation's tab says when Mend's mode handoff refuses its harness. */
export const handoffRefusedLine = (harness: string): string =>
  `${harness} can't continue in a terminal yet · open the terminal to watch`;
