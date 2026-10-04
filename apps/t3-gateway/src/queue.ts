import type { PendingRun } from "./shell.ts";

/**
 * The gateway's queue of one thread (ADR 0012, "The gateway holds the queue"), as plain data and
 * the rules that move it. Every invariant lives here; the hub only reads what Mend says and carries
 * out the step this module chooses.
 *
 * A message never guesses which Mend turn is its own. If the session's agent is live, it is sent
 * with `POST /sessions/:id/turns`, which answers the turn: an exact identity. If the agent has
 * stopped (the idle stop), the session is launched again with no prompt, and once Mend reports the
 * agent live the message is sent the same way. A launch fails only when the launch call fails or
 * Mend settles the session as ended after the launch answered.
 *
 * - `queued`: waiting behind an open turn, or for its turn in the queue.
 * - `launching`: the session is being launched again; sent once the agent is live.
 * - `sending`: `POST /turns` is in flight.
 * - `failed`, `cancelled`: settled; kept a while so the client sees why.
 */

export type EntryState = "queued" | "launching" | "sending" | "failed" | "cancelled";

export interface QueueEntry {
  readonly runId: string;
  readonly messageId: string;
  readonly text: string;
  readonly requestedAt: string;
  /** The sender's device token: their message is sent as them. */
  readonly token: string;
  state: EntryState;
  error: string | null;
  /** The session's `updatedAt` as the launch answered it, on Mend's own clock. */
  launchAnsweredAt: string | null;
  /** How many launches this message asked for. */
  launches: number;
  /**
   * Taken back while on its way: a `launching` message is never sent (the launch may still bring
   * the agent up), and the turn a `sending` message's `POST /turns` answers is interrupted. It
   * shows as cancelled at once, and settles once Mend answered.
   */
  takenBack: boolean;
}

export interface ThreadQueue {
  entries: Array<QueueEntry>;
  /** An interrupt held the queue: nothing queued is sent until it is resumed. */
  held: boolean;
}

/** What the hub knows of the session right now, from Mend. */
export interface SessionView {
  /** The session is still a protocol thread the person sees. */
  readonly known: boolean;
  /** Its agent is running and takes turns. */
  readonly agentLive: boolean;
  /** A Mend turn is queued or running, whoever opened it. */
  readonly turnOpen: boolean;
  readonly status: string | null;
  readonly updatedAt: string | null;
  readonly summary: string | null;
}

export type QueueStep =
  | { readonly kind: "send"; readonly entry: QueueEntry }
  | { readonly kind: "launch"; readonly entry: QueueEntry };

/** How many messages a thread keeps showing once they settled. */
export const SETTLED_KEPT = 20;
/** How many launches one message may ask for before it fails (an agent that will not stay up). */
export const MAX_LAUNCHES = 2;
/** Session statuses that end a launch: provisioning failed or the agent went away. */
const ENDED: ReadonlySet<string> = new Set(["failed", "stopped", "completed"]);

export const emptyQueue = (): ThreadQueue => ({ entries: [], held: false });

/** A message that can still reach Mend. */
export const canProgress = (entry: QueueEntry): boolean =>
  entry.state === "queued" || entry.state === "launching" || entry.state === "sending";

/** Whether any message in any queue can still progress: what holds the hub alive. */
export const anyProgress = (queues: Iterable<ThreadQueue>): boolean => {
  for (const queue of queues) {
    if (queue.entries.some(canProgress)) return true;
  }
  return false;
};

const hasQueued = (queue: ThreadQueue) => queue.entries.some((entry) => entry.state === "queued");

/** Keeps the queue's own rules after any change: an empty queue is not held, settled ones are few. */
const tidy = (queue: ThreadQueue) => {
  if (!hasQueued(queue)) queue.held = false;
  const settled = queue.entries.filter(
    (entry) => entry.state === "failed" || entry.state === "cancelled",
  );
  const surplus = new Set(settled.slice(0, Math.max(0, settled.length - SETTLED_KEPT)));
  if (surplus.size > 0) queue.entries = queue.entries.filter((entry) => !surplus.has(entry));
};

/** Ends a message Mend did not take; one taken back is just cancelled. */
export const fail = (queue: ThreadQueue, entry: QueueEntry, reason: string) => {
  entry.state = entry.takenBack ? "cancelled" : "failed";
  entry.error = entry.takenBack ? null : reason;
  entry.takenBack = false;
  tidy(queue);
};

/** Fails every message that could still progress, for one reason (the session went, the devices). */
export const failAll = (queue: ThreadQueue, reason: string) => {
  for (const entry of queue.entries) {
    if (!canProgress(entry)) continue;
    entry.state = entry.takenBack ? "cancelled" : "failed";
    entry.error = entry.takenBack ? null : reason;
    entry.takenBack = false;
  }
  tidy(queue);
};

/** The message became its Mend turn: it leaves the queue. */
export const adopted = (queue: ThreadQueue, entry: QueueEntry) => {
  queue.entries = queue.entries.filter((candidate) => candidate !== entry);
  tidy(queue);
};

/** `holdQueue` on any interrupt: what is still queued waits for a resume. */
export const holdIfQueued = (queue: ThreadQueue, holdQueue: boolean) => {
  if (holdQueue && hasQueued(queue)) queue.held = true;
};

export const resume = (queue: ThreadQueue) => {
  queue.held = false;
};

/**
 * Takes a message back, wherever it is on its way: queued or launching, it simply never goes
 * out; sending, its turn is interrupted when `POST /turns` answers. With `holdQueue`, what is
 * still queued then waits. False when the message is not in the queue or already settled.
 */
export const takeBack = (queue: ThreadQueue, runId: string, holdQueue: boolean): boolean => {
  const entry = queue.entries.find((candidate) => candidate.runId === runId);
  if (entry === undefined || !canProgress(entry) || entry.takenBack) return false;
  if (entry.state === "queued") entry.state = "cancelled";
  else entry.takenBack = true;
  holdIfQueued(queue, holdQueue);
  tidy(queue);
  return true;
};

/** `POST /turns` answered that the agent is not live: launch again, unless that keeps failing. */
export const notLive = (queue: ThreadQueue, entry: QueueEntry) => {
  if (entry.takenBack) {
    fail(queue, entry, "");
    return;
  }
  if (entry.launches >= MAX_LAUNCHES) {
    fail(queue, entry, "Mend could not keep the session's agent running to take this message.");
    return;
  }
  entry.state = "queued";
  entry.launchAnsweredAt = null;
  tidy(queue);
};

/**
 * The next step for one thread, after any read. Settles what Mend's state decides (the session
 * gone, a launch that ended), then picks at most one message to move: never a second while one is
 * on its way, never while a Mend turn is open, never while held.
 */
export const nextStep = (queue: ThreadQueue, view: SessionView): QueueStep | null => {
  if (!view.known) {
    failAll(queue, "The session is gone from Mend, or is no longer a protocol session.");
    return null;
  }
  const launching = queue.entries.find((entry) => entry.state === "launching");
  if (launching !== undefined) {
    if (launching.launchAnsweredAt === null) return null;
    if (view.agentLive) {
      // Taken back: the agent is up, and the message never goes out.
      if (launching.takenBack) {
        fail(queue, launching, "");
        return null;
      }
      launching.state = "sending";
      return { kind: "send", entry: launching };
    }
    const endedAfterLaunch =
      view.status !== null &&
      ENDED.has(view.status) &&
      view.updatedAt !== null &&
      Date.parse(view.updatedAt) > Date.parse(launching.launchAnsweredAt);
    if (endedAfterLaunch) {
      fail(queue, launching, view.summary ?? `The session ${view.status} while it launched.`);
    }
    return null;
  }
  if (queue.held) return null;
  if (queue.entries.some((entry) => entry.state === "sending")) return null;
  if (view.turnOpen) return null;
  const next = queue.entries.find((entry) => entry.state === "queued");
  if (next === undefined) return null;
  if (view.agentLive) {
    next.state = "sending";
    return { kind: "send", entry: next };
  }
  next.state = "launching";
  next.launches += 1;
  return { kind: "launch", entry: next };
};

/** The run status t3code shows for a message still in the queue. */
export const pendingStateOf = (entry: QueueEntry): PendingRun["state"] => {
  if (entry.takenBack) return "cancelled";
  switch (entry.state) {
    case "queued":
      return "queued";
    case "launching":
      return "preparing";
    case "sending":
      return "starting";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
};
