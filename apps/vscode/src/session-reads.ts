import { AgentWait, agentWaitWords } from "@mend/domain/workbench";

import type { EventPointer, PendingRequest } from "./client.js";
import type { WaitFact } from "./session-model.js";
import type { SessionDetail } from "./types.js";

/**
 * What the store reads, decided without reading: which re-reads a run of event frames asks for,
 * and why a waiting session waits, from what a read returned.
 */

/** What a run of event frames asks the store to read again. */
export interface ReadPlan {
  readonly all: boolean;
  readonly projects: ReadonlySet<string>;
  readonly sessions: ReadonlySet<string>;
}

const SESSION_EVENTS: ReadonlySet<string> = new Set([
  "session",
  "session-process",
  "agent-conversation",
  "session-change",
  "shared-control-off",
]);
const PROJECT_EVENTS: ReadonlySet<string> = new Set(["project", "worktree"]);

/**
 * The reads a batch of frames needs: a session frame re-reads that session, a project or worktree
 * frame that project. Progress lines, comments and account facts move nothing the view shows.
 */
export const readPlan = (events: ReadonlyArray<EventPointer>): ReadPlan => {
  const projects = new Set<string>();
  const sessions = new Set<string>();
  for (const event of events) {
    if (SESSION_EVENTS.has(event.type) && event.sessionId !== null) sessions.add(event.sessionId);
    else if (PROJECT_EVENTS.has(event.type) && event.projectId !== null)
      projects.add(event.projectId);
  }
  return { all: false, projects, sessions };
};

/** Why a session waits, from its detail: a terminal agent's own report, else nothing yet. */
export const terminalWait = (detail: Pick<SessionDetail, "processes">): WaitFact | null => {
  const agent = detail.processes.findLast(
    (process) => process.kind === "agent-pty" && process.exitedAt === null,
  );
  const wait = agent?.waiting ?? null;
  if (agent === undefined || wait === null) return null;
  const harness = agent.harness ?? agent.label ?? "the agent";
  const words = agentWaitWords(
    harness,
    new AgentWait({ kind: wait.kind, tool: wait.tool, since: new Date(wait.since) }),
  );
  return { key: wait.since, words, since: wait.since, via: "terminal" };
};

/** A conversation's wait: its oldest pending request, in the request's own title. */
export const conversationWait = (requests: ReadonlyArray<PendingRequest>): WaitFact | null => {
  const [request] = requests.toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
  return request === undefined
    ? null
    : {
        key: request.id,
        words: request.title ?? "a request",
        since: request.createdAt,
        via: "conversation",
      };
};
