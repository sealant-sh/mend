import { LIVE_STATUSES, type SessionDto, type SessionStatusDto } from "#/lib/api";

/**
 * The vocabulary — status is a dot + a word (DESIGN.md §4), the word is an
 * observation (plan §16.4), and "recorded"/"observed" are only claimed when
 * a Sealant run stands behind the session.
 */

export type Tone = "accent" | "green" | "amber" | "red" | "hollow";

const unexpectedStatus = (status: never): never => {
  throw new Error(`Unhandled session status: ${String(status)}`);
};

export const isLive = (session: SessionDto): boolean => LIVE_STATUSES.has(session.status);

export const statusTone = (status: SessionStatusDto): Tone => {
  switch (status) {
    case "running":
      return "accent";
    case "waiting":
      return "amber";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "starting":
    case "idle":
    case "stopped":
      return "hollow";
    default:
      return unexpectedStatus(status);
  }
};

/** The short form the header strip uses, lower-case mono. */
export const statusWord = (session: SessionDto): string => {
  const recorded = session.sealantRunId !== null;
  switch (session.status) {
    case "starting":
      return "starting";
    case "running":
      return recorded ? "running · recorded" : "running";
    case "waiting":
      return "waiting for input";
    case "idle":
      return "idle";
    case "completed":
      return recorded ? "completed · observed" : "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return unexpectedStatus(session.status);
  }
};

/** A session's title: its harness and its label, else its branch. */
export const sessionTitle = (session: SessionDto): string =>
  `${session.harness} · ${session.label ?? session.branch}`;

/** Minutes and hours only — the inbox is a glance, not a log. */
export const ago = (iso: string | null, now: number): string | null => {
  if (iso === null) return null;
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

export const checkpointLabel = (index: number, trigger: string): string => `${index} · ${trigger}`;

export const clock = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};
