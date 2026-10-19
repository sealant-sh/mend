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
/** Frames that name nothing to re-read: the feed lost track (`resync`), or the roster moved. */
const EVERYTHING_EVENTS: ReadonlySet<string> = new Set(["resync", "organization"]);

/** The account's own access changed (removed, or its sign-in revoked): what it read may be gone. */
export const accessChanged = (event: EventPointer): boolean =>
  event.type === "user" && event.facet === "access";

/**
 * The reads a batch of frames needs: a session frame re-reads that session, a project or worktree
 * frame that project, and a change to the account's access everything. Progress lines, comments
 * and the account's other facts move nothing the view shows.
 */
export const readPlan = (events: ReadonlyArray<EventPointer>): ReadPlan => {
  const projects = new Set<string>();
  const sessions = new Set<string>();
  if (events.some((event) => EVERYTHING_EVENTS.has(event.type) || accessChanged(event)))
    return { all: true, projects, sessions };
  for (const event of events) {
    if (SESSION_EVENTS.has(event.type) && event.sessionId !== null) sessions.add(event.sessionId);
    else if (PROJECT_EVENTS.has(event.type) && event.projectId !== null)
      projects.add(event.projectId);
  }
  return { all: false, projects, sessions };
};

/** Whether a plan reads anything: a frame whose plan is empty is never scheduled. */
export const readsAnything = (plan: ReadPlan): boolean =>
  plan.all || plan.projects.size > 0 || plan.sessions.size > 0;

/**
 * `read` over `items`, at most `limit` at once. The first failure stops new reads and is thrown
 * once every read already begun has ended, so no later read starts beside one still running.
 */
export const limited = async <Item, Result>(
  items: ReadonlyArray<Item>,
  limit: number,
  read: (item: Item) => Promise<Result>,
): Promise<ReadonlyArray<Result>> => {
  const results: Array<{ readonly index: number; readonly result: Result }> = [];
  const failures: Array<unknown> = [];
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (let next = queue.next(); !next.done && failures.length === 0; next = queue.next()) {
      const [index, item] = next.value;
      try {
        results.push({ index, result: await read(item) });
      } catch (cause) {
        failures.push(cause);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
  return results.toSorted((left, right) => left.index - right.index).map(({ result }) => result);
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
