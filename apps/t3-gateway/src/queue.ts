import type { PendingRun } from "./shell.ts";

/**
 * The gateway's queue of one thread (ADR 0012, "The gateway holds the queue"), as plain data and
 * the rules that move it. Every invariant lives here; the hub only reads what Mend says and carries
 * out the step this module chooses.
 *
 * A message never guesses which Mend turn is its own. If the session's agent is live, it is sent
 * with `POST /sessions/:id/turns`, which answers the turn: an exact identity. If the agent has
 * stopped (the idle stop), the session is launched again with no prompt, and once Mend reports the
 * agent live the message is sent the same way.
 *
 * Every wait is bounded and every retry waits for evidence:
 *
 * - A launch fails when the launch call fails, when Mend settles the session as ended after the
 *   launch answered, or when no live agent appears within `launchDeadlineMs`.
 * - A `POST /turns` answered "not live" while the row still reads the agent running (an idle stop
 *   finishing, Mend restarting, a launch answered before its agent attached) is sent again only
 *   after a backoff and a fresh read of the session, never in the same pass; after `sendDeadlineMs`
 *   the message fails with Mend's refusal. A relaunch starts that count again: a new agent.
 * - A settled message (taken back, failed) is never rewritten by a late answer.
 *
 * Deadlines and retry times are on a monotonic clock (`performance.now()`), never wall time, so
 * they are not kept across a restart: a restored message waits for nothing but its turn.
 *
 * The queue is kept in the gateway's state file (`StoredEntry`, ADR 0012, "State"), so a restart
 * loses no message. A message being sent when the gateway stopped cannot be known to have reached
 * Mend or not; it comes back failed, saying so, and is never sent twice (`restoredEntry`).
 *
 * - `queued`: waiting behind an open turn, for its turn in the queue, or for a retry.
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
  /** The sender's device token: their message is sent as them. Never stored. */
  readonly token: string;
  /** The sender's bearer session, which the state file keeps instead of the token. */
  readonly sender: string;
  state: EntryState;
  error: string | null;
  /** How many launches this message asked for. */
  launches: number;
  /** While `launching`: the session's `updatedAt` as the launch answered it (Mend's clock). */
  launchAnsweredAt: string | null;
  /** While `launching`: when the gateway gives up waiting for a live agent (monotonic clock). */
  launchDeadline: number | null;
  /** After a "not live" answer: not before this, and only after a read newer than `retryEvidence`. */
  retryAt: number | null;
  retryEvidence: number;
  /** How many "not live" answers this message had; the backoff doubles with each. */
  notLiveAnswers: number;
  /** When the gateway stops retrying a message Mend keeps answering "not live", and why it said so. */
  sendDeadline: number | null;
  lastRefusal: string | null;
  /** Taken back while `sending`: the turn `POST /turns` answers is interrupted. */
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
  /** How many reads of this session from Mend the hub has applied: fresh evidence counts up. */
  readonly evidence: number;
}

export interface QueueTimings {
  /**
   * How long a relaunch may take to bring a live agent up. Mend answers a launch within 30 s
   * (`LAUNCH_ANSWER_WINDOW`) and goes on in the background; on the box a relaunch on a fresh
   * workspace took 67–80 s (2026-10-04), and a launch may also wait for the previous session's
   * workspace to save or for a workspace image to build. Ten minutes is well above all of that and
   * still ends a launch Mend forgot (a restart mid-launch) in bounded time.
   */
  readonly launchDeadlineMs: number;
  /** The first wait after a "not live" answer; it doubles up to `retryMaxMs`. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /**
   * How long Mend may keep answering "not live" to a message whose session reads live. The idle
   * stop takes 15–19 s to finish on the box, a restart re-hosts its processes on boot, and a launch
   * answered at its 30 s window attaches its agent shortly after: two minutes covers them.
   */
  readonly sendDeadlineMs: number;
}

export const DEFAULT_QUEUE_TIMINGS: QueueTimings = {
  launchDeadlineMs: 10 * 60_000,
  retryBaseMs: 1_000,
  retryMaxMs: 15_000,
  sendDeadlineMs: 2 * 60_000,
};

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

export const newEntry = (input: {
  readonly runId: string;
  readonly messageId: string;
  readonly text: string;
  readonly requestedAt: string;
  readonly token: string;
  readonly sender: string;
}): QueueEntry => ({
  ...input,
  state: "queued",
  error: null,
  launches: 0,
  launchAnsweredAt: null,
  launchDeadline: null,
  retryAt: null,
  retryEvidence: 0,
  notLiveAnswers: 0,
  sendDeadline: null,
  lastRefusal: null,
  takenBack: false,
});

/** A message that can still reach Mend: only these hold the hub alive. */
export const canProgress = (entry: QueueEntry): boolean =>
  entry.state === "queued" || entry.state === "launching" || entry.state === "sending";

/** Whether any message in any queue can still progress. */
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

/**
 * Ends a message Mend did not take; one taken back is just cancelled. A message already settled
 * (taken back, or failed for another reason) stays as it is: a late answer never rewrites it.
 */
export const fail = (queue: ThreadQueue, entry: QueueEntry, reason: string) => {
  if (!canProgress(entry)) return;
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
 * Takes a message back, wherever it is on its way. Queued or launching, it is cancelled at once:
 * it stops blocking the thread and stops holding the hub (a launch already asked for may still
 * bring the agent up). Sending, its turn is interrupted when `POST /turns` answers. With
 * `holdQueue`, what is still queued then waits. False when the message is not in the queue or
 * already settled.
 */
export const takeBack = (queue: ThreadQueue, runId: string, holdQueue: boolean): boolean => {
  const entry = queue.entries.find((candidate) => candidate.runId === runId);
  if (entry === undefined || !canProgress(entry) || entry.takenBack) return false;
  if (entry.state === "sending") entry.takenBack = true;
  else entry.state = "cancelled";
  holdIfQueued(queue, holdQueue);
  tidy(queue);
  return true;
};

/** A launch answered: the agent is awaited from here (`launching` with its answer stamped). */
export const launchAnswered = (entry: QueueEntry, sessionUpdatedAt: string) => {
  if (entry.state === "launching") entry.launchAnsweredAt = sessionUpdatedAt;
};

/**
 * `POST /turns` answered that the agent is not live. The message goes back to the queue, to be
 * sent again after a backoff and a fresh read of the session (never in the same pass), until
 * `sendDeadlineMs` has passed since the first such answer.
 */
export const notLive = (
  queue: ThreadQueue,
  entry: QueueEntry,
  input: {
    readonly now: number;
    readonly evidence: number;
    readonly refusal: string;
    readonly timings: QueueTimings;
  },
) => {
  if (!canProgress(entry)) return;
  if (entry.takenBack) {
    fail(queue, entry, "");
    return;
  }
  const deadline = entry.sendDeadline ?? input.now + input.timings.sendDeadlineMs;
  if (input.now >= deadline) {
    fail(queue, entry, input.refusal);
    return;
  }
  entry.notLiveAnswers += 1;
  entry.state = "queued";
  entry.sendDeadline = deadline;
  entry.lastRefusal = input.refusal;
  entry.retryEvidence = input.evidence;
  entry.retryAt =
    input.now +
    Math.min(input.timings.retryMaxMs, input.timings.retryBaseMs * 2 ** (entry.notLiveAnswers - 1));
  tidy(queue);
};

/**
 * The next step for one thread, after any read or wake-up. Settles what Mend's state and the
 * clock decide (the session gone, a launch that ended or ran out of time, a retry past its
 * deadline), then picks at most one message to move: never a second while one is on its way,
 * never while a Mend turn is open, never while held, never a retry before its time and evidence.
 */
export const nextStep = (
  queue: ThreadQueue,
  view: SessionView,
  now: number,
  timings: QueueTimings,
): QueueStep | null => {
  if (!view.known) {
    failAll(queue, "The session is gone from Mend, or is no longer a protocol session.");
    return null;
  }
  const launching = queue.entries.find((entry) => entry.state === "launching");
  if (launching !== undefined) {
    if (launching.launchAnsweredAt !== null && view.agentLive) {
      launching.state = "sending";
      return { kind: "send", entry: launching };
    }
    const endedAfterLaunch =
      launching.launchAnsweredAt !== null &&
      view.status !== null &&
      ENDED.has(view.status) &&
      view.updatedAt !== null &&
      Date.parse(view.updatedAt) > Date.parse(launching.launchAnsweredAt);
    if (endedAfterLaunch) {
      fail(queue, launching, view.summary ?? `The session ${view.status} while it launched.`);
    } else if (launching.launchDeadline !== null && now >= launching.launchDeadline) {
      fail(
        queue,
        launching,
        `Mend did not bring the session's agent up within ${Math.round(timings.launchDeadlineMs / 60_000)} minutes.`,
      );
    } else {
      return null;
    }
  }
  if (queue.held) return null;
  if (queue.entries.some((entry) => entry.state === "sending")) return null;
  if (view.turnOpen) return null;
  const next = queue.entries.find((entry) => entry.state === "queued");
  if (next === undefined) return null;
  if (next.retryAt !== null) {
    if (next.sendDeadline !== null && now >= next.sendDeadline) {
      fail(queue, next, next.lastRefusal ?? "Mend kept answering that the agent is not live.");
      return nextStep(queue, view, now, timings);
    }
    if (now < next.retryAt || view.evidence <= next.retryEvidence) return null;
  }
  next.retryAt = null;
  if (view.agentLive) {
    next.state = "sending";
    return { kind: "send", entry: next };
  }
  if (next.launches >= MAX_LAUNCHES) {
    fail(queue, next, "Mend could not keep the session's agent running to take this message.");
    return nextStep(queue, view, now, timings);
  }
  next.state = "launching";
  next.launches += 1;
  next.launchAnsweredAt = null;
  next.launchDeadline = now + timings.launchDeadlineMs;
  // A new agent: the 409s the last one gave (and their deadline and backoff) say nothing about it.
  next.sendDeadline = null;
  next.notLiveAnswers = 0;
  next.lastRefusal = null;
  return { kind: "launch", entry: next };
};

/** When this thread's queue next needs a look without any read: a retry, or a launch deadline. */
export const nextWake = (queue: ThreadQueue): number | null => {
  let wake: number | null = null;
  for (const entry of queue.entries) {
    const at =
      entry.state === "launching"
        ? entry.launchDeadline
        : entry.state === "queued"
          ? entry.retryAt
          : null;
    if (at !== null && (wake === null || at < wake)) wake = at;
  }
  return wake;
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

// ─── Kept across a restart ────────────────────────────────────────────────────

/** One message as the state file keeps it: no token, no clock, only what outlives a restart. */
export interface StoredEntry {
  readonly runId: string;
  readonly messageId: string;
  readonly text: string;
  readonly requestedAt: string;
  /** The sender's bearer session; their device token is looked up from it on restore. */
  readonly sender: string;
  readonly state: EntryState;
  readonly error: string | null;
  readonly launches: number;
}

export interface StoredQueue {
  readonly held: boolean;
  readonly entries: ReadonlyArray<StoredEntry>;
}

export const storedOf = (queue: ThreadQueue): StoredQueue => ({
  held: queue.held,
  entries: queue.entries.map((entry) => ({
    runId: entry.runId,
    messageId: entry.messageId,
    text: entry.text,
    requestedAt: entry.requestedAt,
    sender: entry.sender,
    state: entry.state,
    error: entry.error,
    launches: entry.launches,
  })),
});

/** What a message being sent when the gateway stopped says: it may or may not be in Mend. */
export const SENT_BEFORE_RESTART =
  "The gateway restarted while it was sending this message, so it cannot tell whether Mend took it. Look at the thread before sending it again.";
/** What a message says whose sender's device is no longer paired with the gateway. */
export const SENDER_GONE =
  "The device that sent this message is no longer paired with the gateway.";

/**
 * A stored message as it comes back, with its sender's token, or null when the device is gone.
 * Waiting, or being launched for, it waits again from the start of its turn (a launch it asked
 * for still counts). Being sent, it failed: the gateway never guesses whether Mend took it.
 */
export const restoredEntry = (stored: StoredEntry, token: string | null): QueueEntry => {
  const entry = newEntry({
    runId: stored.runId,
    messageId: stored.messageId,
    text: stored.text,
    requestedAt: stored.requestedAt,
    token: token ?? "",
    sender: stored.sender,
  });
  entry.launches = stored.launches;
  const settle = (state: "failed" | "cancelled", error: string | null) => {
    entry.state = state;
    entry.error = error;
    return entry;
  };
  switch (stored.state) {
    case "failed":
      return settle("failed", stored.error);
    case "cancelled":
      return settle("cancelled", null);
    case "sending":
      return settle("failed", SENT_BEFORE_RESTART);
    case "queued":
    case "launching":
      return token === null ? settle("failed", SENDER_GONE) : entry;
  }
};

/** A stored queue as it comes back; held only while something is still queued. */
export const restoredQueue = (
  stored: StoredQueue,
  tokenOf: (sender: string) => string | null,
): ThreadQueue => {
  const queue: ThreadQueue = {
    entries: stored.entries.map((entry) => restoredEntry(entry, tokenOf(entry.sender))),
    held: stored.held,
  };
  tidy(queue);
  return queue;
};
