import {
  agentIsLive,
  ApiError,
  isLiveProcess,
  type SessionDetailDto,
  type SessionProcessDto,
} from "#/lib/api";

/**
 * What a terminal does after `/api/tty` closed before it ever opened.
 *
 * A browser WebSocket never learns the HTTP status of a refused upgrade: a 403, a 502 "the session
 * has no live PTY", and a dropped network all arrive as close code 1006. So the socket's close
 * alone cannot say whether to try again. The server can: the terminal asks it whether the PTY's
 * process is still live, over the ordinary API, and decides from that answer.
 *
 * - `live`: the process runs, so the refusal was transient (a platform hiccup, a network drop).
 *   Reconnect on the ladder.
 * - `ended`: the process exited. There is no PTY to attach and never will be. Stop, and show what
 *   the record holds.
 * - `refused`: the server will not tell this caller about the process (signed out, not visible,
 *   deleted). Retrying cannot change that.
 * - `unknown`: the question itself did not get an answer. Treat it like a network drop.
 */
export type PtyLiveness = "live" | "ended" | "refused" | "unknown";

export type UnopenedCloseVerdict = "reconnect" | "ended" | "refused";

export const afterUnopenedClose = (liveness: PtyLiveness): UnopenedCloseVerdict =>
  liveness === "ended" ? "ended" : liveness === "refused" ? "refused" : "reconnect";

/** A session tab's PTY is the session's agent: live while the agent is. */
export const sessionPtyLiveness = (detail: SessionDetailDto): PtyLiveness =>
  agentIsLive(detail.session, detail.currentAgent) ? "live" : "ended";

/** A shell tab's PTY is one process: live until it exits. A process that vanished is refused. */
export const processPtyLiveness = (
  processes: ReadonlyArray<SessionProcessDto>,
  processId: string,
): PtyLiveness => {
  const process = processes.find((candidate) => candidate.id === processId);
  if (process === undefined) return "refused";
  return isLiveProcess(process) ? "live" : "ended";
};

/**
 * A failed liveness read, classified: the server said no (401, 403, 404) is a refusal; anything
 * else, including no answer at all (status 0), is unknown.
 */
export const livenessOfError = (error: unknown): PtyLiveness =>
  error instanceof ApiError &&
  (error.status === 401 || error.status === 403 || error.status === 404)
    ? "refused"
    : "unknown";
