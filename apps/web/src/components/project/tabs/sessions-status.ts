import type { Tone } from "#/components/kit/status";
import type { SessionDto } from "#/lib/api";

/**
 * A session's dot and mono word as a worktree row shows it: what was observed, never a verdict.
 * `recorded` (a Sealant run behind it) is what lets "completed" say "observed".
 */
export const sessionStatusWord = (
  session: Pick<SessionDto, "status" | "sealantRunId">,
): { readonly tone: Tone; readonly word: string } => {
  switch (session.status) {
    case "starting":
      return { tone: "off", word: "starting" };
    case "running":
      return { tone: "run", word: "running" };
    case "waiting":
      return { tone: "wait", word: "waiting for input" };
    case "idle":
      return { tone: "off", word: "idle" };
    case "stopping":
      return { tone: "off", word: "stopping" };
    case "completed":
      return {
        tone: "ok",
        word: session.sealantRunId === null ? "completed" : "completed · observed",
      };
    case "failed":
      return { tone: "bad", word: "failed" };
    case "stopped":
      return { tone: "off", word: "stopped" };
  }
};

/** What a session is called on its own line: its label, else its short id. */
export const sessionName = (session: Pick<SessionDto, "label" | "id">): string =>
  session.label ?? `session ${session.id.slice(0, 8)}`;
