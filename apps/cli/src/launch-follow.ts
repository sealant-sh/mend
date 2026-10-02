import { GATEWAY_STATUSES, MendRequestError } from "./server-request.ts";
import type { AgentProcessLike } from "./shared.ts";

/**
 * Following a session while it starts. A first launch can build a workspace image for minutes, so
 * the CLI never rests on one held request: the launch call goes out, and the session itself is
 * read every couple of seconds until its agent has a live terminal or the session settles. A
 * server that answers the launch at once (`starting`) and one that holds it until the agent runs
 * are followed the same way, and a launch request that times out or is cut by an edge is not a
 * failure while the session keeps starting.
 */

/** The slice of a session the follower reads. */
export interface StartingSession {
  readonly id: string;
  readonly status: string;
  /** While starting, what the server says it is doing; at settle, what the harness reported. */
  readonly summary: string | null;
}

/** The slice of `GET /sessions/:id` the follower reads. */
export interface StartingDetail<S extends StartingSession> {
  readonly session: S;
  readonly currentAgent: AgentProcessLike | null;
}

export type StartOutcome<S extends StartingSession> =
  /** The agent runs: attach now. */
  | { readonly kind: "live"; readonly session: S }
  /** The session settled (or began stopping) before its agent ran. */
  | { readonly kind: "settled"; readonly session: S }
  /** The server refused the launch, in its own words. */
  | { readonly kind: "refused"; readonly message: string }
  /** Nothing answered for too long — the launch call and every read since. */
  | { readonly kind: "unreachable"; readonly message: string };

export interface FollowStartOptions<S extends StartingSession> {
  /**
   * The launch (or resume) call — it may answer early with `starting`, or hold until the agent
   * runs. Null follows a session something else started.
   */
  readonly start: Promise<S> | null;
  /** One read of the session. */
  readonly read: () => Promise<StartingDetail<S>>;
  /** Called with each new status line (`starting · preparing the workspace`). */
  readonly onLine: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** How long to wait before the first read and between reads. */
  readonly pollMs?: number;
  /** How long reads may fail in a row, once the start call has ended, before giving up. */
  readonly unreachableAfterMs?: number;
}

const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "stopping"]);

/** The agent process holds a live terminal the CLI can attach to (a protocol agent has none). */
const agentRuns = (agent: AgentProcessLike | null): boolean =>
  agent !== null &&
  agent.kind !== "agent-protocol" &&
  agent.exitedAt === null &&
  agent.status === "running" &&
  agent.sealantSessionId !== null;

/**
 * The line a starting session reads as: the server's own words when it gives them
 * (`waiting · the previous session in this worktree is saving`), led by the status word when they
 * do not already start with one; the bare status otherwise.
 */
export const startingLineOf = (session: StartingSession): string => {
  const summary = session.summary?.trim() ?? "";
  if (summary === "") return session.status;
  if (/^[a-z][a-z -]*·/u.test(summary)) return summary;
  return `${session.status} · ${summary}`;
};

type LaunchState<S> =
  | { readonly kind: "pending" }
  | { readonly kind: "answered"; readonly session: S }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "no-answer" };

/** Whether a failed start call is the server's refusal, or only a call that got no answer. */
const refusalOf = (error: unknown): string | null =>
  error instanceof MendRequestError &&
  error.kind === "http" &&
  (error.status === null || !GATEWAY_STATUSES.has(error.status))
    ? error.message
    : null;

export const followStart = async <S extends StartingSession>(
  options: FollowStartOptions<S>,
): Promise<StartOutcome<S>> => {
  const pollMs = options.pollMs ?? 2000;
  const unreachableAfterMs = options.unreachableAfterMs ?? 60_000;
  // A holder, not a `let`: the start call's callbacks write it while the loop below reads it.
  const launch: { state: LaunchState<S> } = {
    state: options.start === null ? { kind: "no-answer" } : { kind: "pending" },
  };
  const start = options.start;
  const launched = (async () => {
    if (start === null) return;
    try {
      launch.state = { kind: "answered", session: await start };
    } catch (error) {
      // A refusal is the server's answer. Anything else (a timeout, an edge cutting a long
      // request, a blip) says nothing about the session — reading it does.
      const refusal = refusalOf(error);
      launch.state =
        refusal === null ? { kind: "no-answer" } : { kind: "refused", message: refusal };
    }
  })();
  let lastLine: string | null = null;
  let failingSince: number | null = null;
  // A resume starts from a settled session: a settled read counts only once the session was seen
  // starting, or the start call has ended.
  let seenStarting = false;
  for (;;) {
    // While the start call is out, the first of it answering or the poll interval.
    if (launch.state.kind === "pending") await Promise.race([launched, options.sleep(pollMs)]);
    const state = launch.state;
    if (state.kind === "refused") return { kind: "refused", message: state.message };
    // The long answer: the server held the launch until the agent ran.
    if (state.kind === "answered" && state.session.status === "running") {
      return { kind: "live", session: state.session };
    }
    let detail: StartingDetail<S>;
    try {
      detail = await options.read();
    } catch (error) {
      const refusal = refusalOf(error);
      if (refusal !== null) return { kind: "refused", message: refusal };
      failingSince ??= options.now();
      if (state.kind !== "pending" && options.now() - failingSince >= unreachableAfterMs) {
        return {
          kind: "unreachable",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (state.kind !== "pending") await options.sleep(pollMs);
      continue;
    }
    failingSince = null;
    const { session, currentAgent } = detail;
    if (agentRuns(currentAgent)) return { kind: "live", session };
    if (SETTLED.has(session.status)) {
      if (seenStarting || state.kind !== "pending") return { kind: "settled", session };
    } else {
      seenStarting = true;
    }
    // A server without process rows: the start call's own `running` answer is the word.
    if (
      currentAgent === null &&
      state.kind === "answered" &&
      state.session.status === "running" &&
      session.status === "running"
    ) {
      return { kind: "live", session };
    }
    const line = startingLineOf(session);
    if (line !== lastLine) {
      lastLine = line;
      options.onLine(line);
    }
    // Once the start call has ended, the reads are the only clock.
    if (state.kind !== "pending") await options.sleep(pollMs);
  }
};
