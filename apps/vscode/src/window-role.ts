import { MendWorkspace } from "./editor-home.js";
import { displaySession } from "./session-lines.js";
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
 * The session a workspace window shows. `found` attaches it; `missing` attaches nothing, since
 * another session of the worktree is not the one she asked for, and says why; `none` is a window
 * whose workspace holds no session this person can see.
 */
export type WindowSession =
  | { readonly kind: "found"; readonly project: Project; readonly session: Session }
  | { readonly kind: "missing"; readonly line: string }
  | { readonly kind: "none" };

/** Why a window attaches nothing for a session Mend no longer lists. */
export const missingSessionLine = (sessionId: string): string =>
  `Mend lists no session ${sessionId.slice(0, 8)} now · no agent attached`;

/** Why a window attaches nothing for a session whose workspace is another. */
export const notInWorkspaceLine = (
  session: Pick<Session, "label" | "harness" | "id" | "status">,
): string =>
  `${displaySession(session)} is ${session.status} and not in this workspace · no agent attached`;

/**
 * Whether a window must read the workspace again before it shows `requested`. Every explicit
 * request is checked, the one it already shows included: that session may since have gone or
 * moved. Only the window falling back to what it shows skips the read.
 */
export const requestOfWindow = (facts: {
  readonly explicit: string | null;
  readonly shown: string | null;
}): { readonly requested: string | null; readonly check: boolean } => {
  const requested = facts.explicit ?? facts.shown;
  return {
    requested,
    check: facts.explicit !== null || requested === null || requested !== facts.shown,
  };
};

/**
 * Several sessions of one worktree share its workspace. A requested session is shown only if the
 * workspace still holds it; with none requested, the live one, then the newest.
 */
export const sessionOfWorkspace = (
  details: ReadonlyArray<ProjectDetail>,
  workspaceId: string,
  requested: string | null = null,
): WindowSession => {
  const all = details.flatMap((detail) =>
    detail.sessions.map((session) => ({ project: detail.project, session })),
  );
  if (requested !== null) {
    const asked = all.find(({ session }) => session.id === requested);
    if (asked === undefined) return { kind: "missing", line: missingSessionLine(requested) };
    return asked.session.sealantWorkspaceId === workspaceId
      ? { kind: "found", ...asked }
      : { kind: "missing", line: notInWorkspaceLine(asked.session) };
  }
  const shown = all
    .filter(({ session }) => session.sealantWorkspaceId === workspaceId)
    .toSorted(
      (left, right) =>
        Number(LIVE_STATUSES.has(right.session.status)) -
          Number(LIVE_STATUSES.has(left.session.status)) ||
        right.session.createdAt.localeCompare(left.session.createdAt),
    )[0];
  return shown === undefined ? { kind: "none" } : { kind: "found", ...shown };
};

/** The terminal tab a workspace window attaches for its session. */
export type AgentTab =
  | { readonly kind: "pty"; readonly processId: string; readonly name: string }
  | {
      readonly kind: "conversation";
      readonly processId: string;
      readonly name: string;
      readonly line: string;
    }
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
      processId: conversation.id,
      name: terminalTabName(session, conversation),
      line: `${harness} is running as a conversation (from ${origin}) · Continue here to type to it`,
    };
  }
  const shell = newestLive("shell");
  return shell === undefined
    ? { kind: "none" }
    : { kind: "pty", processId: shell.id, name: terminalTabName(session, shell) };
};

/**
 * What a conversation's tab says when Mend's mode handoff says no. Only `HandoffUnsupported` means
 * the harness cannot continue in a terminal; any other refusal (a conversation with no saved turn
 * yet answers 422 too) is the server's own sentence.
 */
export const handoffRefusedLine = (
  harness: string,
  refusal: { readonly tag: string | null; readonly words: string },
): string =>
  refusal.tag === "HandoffUnsupported"
    ? `${harness} can't continue in a terminal yet · open the terminal to watch`
    : refusal.words;
