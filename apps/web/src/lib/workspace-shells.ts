import { canSteerSession, canTypeInTerminal } from "@mend/domain/workbench";

import type { SessionProcessDto, SessionStatusDto } from "./api.ts";

/**
 * A workspace's shells, as the Terminal view lists them (Doop "Terminal · this workspace's
 * shells"). Sessions share a workspace, and the server lists processes per session: the view reads
 * every session of the worktree and lists, together, each live terminal one of them runs in (a
 * terminal agent, or a shell session's own command) and each shell opened beside them, with the
 * shells that ended in the workspace's latest run. Everything here is pure; the view only reads.
 */

/** A session of the workspace, with what its terminals need of it. */
export interface ShellSession {
  readonly id: string;
  readonly title: string;
  readonly harness: string;
  readonly status: SessionStatusDto;
  readonly ownerUserId: string | null;
  readonly sharedControlEnabledAt: Date | null;
  /** Its processes, once read; null until then (or when reading them failed). */
  readonly processes: ReadonlyArray<SessionProcessDto> | null;
}

/** One terminal in the list. */
export interface WorkspaceShell {
  /** The list's key and the view's pick: the shell's process id, or `session:<id>`. */
  readonly key: string;
  readonly sessionId: string;
  /** The shell's process; null for a session's own terminal, which attaches by session. */
  readonly processId: string | null;
  /** "Shell 1", or a session's title for its own terminal. */
  readonly name: string;
  /** What runs in it: "zsh", "Claude Code". */
  readonly program: string;
  readonly live: boolean;
  /** The shell was stopped (Close shell, or its workspace stopping) rather than exiting itself. */
  readonly stopped: boolean;
  readonly exitCode: number | null;
  readonly endedAt: Date | null;
  /** Whom the shell runs as, in a workspace where each person has their own user. */
  readonly runsAs: string | null;
  /** The owner of the session it belongs to: the one person who types in it. */
  readonly ownerUserId: string | null;
}

/** A row the engine still counts: not ended, in a live status. */
const isLive = (process: SessionProcessDto): boolean =>
  process.exitedAt === null &&
  (process.status === "starting" ||
    process.status === "running" ||
    process.status === "reachable" ||
    process.status === "unreachable");

/** "zsh" from `/bin/zsh -l`: the program's own name. */
const programOf = (argv: ReadonlyArray<string>): string => {
  const first = argv[0] ?? "";
  const name = first.split("/").findLast((part) => part !== "") ?? first;
  return name.replace(/^-/, "") || "shell";
};

/** "Shell 1" from the engine's "shell 1": the list says it in sentence case. */
const shellName = (label: string | null, fallback: string): string => {
  const name = label === null || label.trim() === "" ? fallback : label.trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
};

/**
 * The workspace's terminals, in the order the list shows them: sessions' own terminals first,
 * then the shells by when they opened. A shell that ended shows while it belongs to the
 * workspace's latest run (the machine the newest process ran on), so a stopped workspace still
 * shows what its shells did; shells from runs before that are left to the Record.
 * `programName` names a session's own terminal ("Claude Code" for `claude`).
 */
export const workspaceShells = (
  sessions: ReadonlyArray<ShellSession>,
  programName: (harness: string) => string,
): ReadonlyArray<WorkspaceShell> => {
  const rows = sessions.flatMap((session) =>
    (session.processes ?? []).map((process) => ({ session, process })),
  );
  const newest = rows.reduce<SessionProcessDto | null>(
    (latest, { process }) =>
      latest === null || process.createdAt.getTime() > latest.createdAt.getTime()
        ? process
        : latest,
    null,
  );
  const latestRun = newest?.sealantWorkspaceId ?? null;

  const own = sessions.flatMap((session): ReadonlyArray<WorkspaceShell> => {
    const agent = (session.processes ?? []).find(
      (process) => process.kind === "agent-pty" && isLive(process),
    );
    if (agent === undefined) return [];
    return [
      {
        key: `session:${session.id}`,
        sessionId: session.id,
        processId: null,
        name: session.title,
        program: session.harness === "shell" ? programOf(agent.argv) : programName(session.harness),
        live: true,
        stopped: false,
        exitCode: null,
        endedAt: null,
        runsAs: agent.runsAs,
        ownerUserId: session.ownerUserId,
      },
    ];
  });

  const shells = rows
    .filter(
      ({ process }) =>
        process.kind === "shell" && (isLive(process) || process.sealantWorkspaceId === latestRun),
    )
    .toSorted((a, b) => a.process.createdAt.getTime() - b.process.createdAt.getTime())
    .map(
      ({ session, process }, index): WorkspaceShell => ({
        key: process.id,
        sessionId: session.id,
        processId: process.id,
        name: shellName(process.label, `shell ${index + 1}`),
        program: programOf(process.argv),
        live: isLive(process),
        stopped: process.status === "stopped",
        exitCode: process.exitCode,
        endedAt: process.exitedAt,
        runsAs: process.runsAs,
        ownerUserId: session.ownerUserId,
      }),
    );

  return [...own, ...shells];
};

/**
 * Whether the workspace runs now: a session in it is running, or any of its processes is live (a
 * shell, a Service). A screen alone doesn't hold a workspace up.
 */
export const workspaceRuns = (sessions: ReadonlyArray<ShellSession>): boolean =>
  sessions.some(
    (session) =>
      session.status === "running" ||
      session.status === "waiting" ||
      session.status === "starting" ||
      (session.processes ?? []).some((process) => process.kind !== "screen" && isLive(process)),
  );

/** What `viewerId` may do with the workspace's terminals (docs/adr/0013). */
export interface ShellAccess {
  /** Watches a terminal of `sessionId`: its owner, and anyone while the owner shares control. */
  readonly watches: (sessionId: string) => boolean;
  /** Types in, and closes, a terminal of `sessionId`: its owner only, even under shared control. */
  readonly types: (sessionId: string) => boolean;
  /** The session a new shell opens on: the page's own when the viewer owns it, else another they own. */
  readonly opensOn: string | null;
}

export const shellAccess = (
  sessions: ReadonlyArray<ShellSession>,
  pageSessionId: string,
  viewerId: string,
): ShellAccess => {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const owned = sessions.filter((session) => canTypeInTerminal(session, viewerId));
  return {
    watches: (sessionId) => {
      const session = byId.get(sessionId);
      return session !== undefined && canSteerSession(session, viewerId);
    },
    types: (sessionId) => {
      const session = byId.get(sessionId);
      return session !== undefined && canTypeInTerminal(session, viewerId);
    },
    opensOn: (owned.find((session) => session.id === pageSessionId) ?? owned[0])?.id ?? null,
  };
};

/** "1 shell", "2 shells": what the Terminal tab and its "+" item say while shells run. */
export const runningShellsFact = (shells: ReadonlyArray<WorkspaceShell>): string | undefined => {
  const running = shells.filter((shell) => shell.live && shell.processId !== null).length;
  if (running === 0) return undefined;
  return running === 1 ? "1 shell" : `${running} shells`;
};

/**
 * What a shell's line under its name says: "zsh · Running · Ada Lovelace" while it runs,
 * "Exited with code 0 · 9m" once it ended, "Closed · 9m" when it was stopped.
 */
export const shellLine = (
  shell: WorkspaceShell,
  nameOf: (userId: string) => string | null,
  ago: (date: Date) => string,
): string => {
  if (shell.live) {
    const who = shell.runsAs === null ? null : nameOf(shell.runsAs);
    return [shell.program, "Running", who].filter((part) => part !== null).join(" · ");
  }
  const end = shell.endedAt === null ? null : ago(shell.endedAt);
  const how = shell.stopped
    ? "Closed"
    : shell.exitCode === null
      ? "Ended"
      : `Exited with code ${shell.exitCode}`;
  return end === null ? how : `${how} · ${end}`;
};
