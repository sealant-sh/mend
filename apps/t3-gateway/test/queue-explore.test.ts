import { describe, expect, it } from "vitest";

import {
  adopted,
  DEFAULT_QUEUE_TIMINGS,
  emptyQueue,
  fail,
  launchAnswered,
  newEntry,
  nextStep,
  nextWake,
  notLive,
  POST_UNCERTAIN,
  restoredQueue,
  resume,
  sessionStopped,
  storedOf,
  takeBack,
  type ThreadQueue,
} from "../src/queue.ts";

/**
 * Every interleaving, within small bounds, of what moves one thread's gateway queue (ADR 0012, "The
 * gateway holds the queue"): the hub's steps, Mend's answers to `POST /turns` and to a launch, the
 * agent coming up or stopping, a Mend turn opening, the person taking a message back or resuming,
 * the clock, and a gateway restart. The queue is the real module; what the hub does with each
 * answer (`hub.ts`, the send step and `launchAgain`) is restated in `answerPost` and
 * `answerLaunch`, the only code here that stands in for the gateway.
 *
 * The promises, checked after every event:
 *
 * - One message at a time is on its way to Mend, and it is sent only while the agent is live, no
 *   Mend turn is open and the queue is not held.
 * - A message is POSTed again only after Mend answered each earlier POST of it "not live": never
 *   after Mend took it, refused it, or gave no answer the gateway kept (a restart, Mend
 *   unavailable).
 * - A message the person took back is never POSTed afterwards.
 *
 * `session-stop.test.ts` drives one of these schedules through a fake Mend (Stop while a POST is
 * out, then its late answer); this walks every order of them, two messages at a time.
 */

const POSITION = { historyRevision: 1, worktreeEpoch: 1 };
const RUNS = ["run-a", "run-b"] as const;
type Run = (typeof RUNS)[number];
type Answer = "taken" | "not-live" | "refused" | "unavailable";

/**
 * How many times one path may take each event that is not a step or an answer: the Session's Stop,
 * a gateway restart, a take-back, a clock jump and a Mend turn opening.
 */
interface Bounds {
  stops: number;
  restarts: number;
  takeBacks: number;
  ticks: number;
  turns: number;
}

interface View {
  agentLive: boolean;
  turnOpen: boolean;
  status: string;
  /** The session row's updatedAt, in seconds: only its order matters. */
  updatedAt: number;
  evidence: number;
}

/** A call the hub is waiting on: a POST about to be written or out, or a launch out. */
interface Call {
  readonly kind: "write" | "post" | "launch";
  readonly run: Run;
}

interface World {
  queue: ThreadQueue;
  view: View;
  now: number;
  calls: Array<Call>;
  /** Every POST of a message and how it was answered; "unknown" when its answer was lost. */
  posts: Record<Run, Array<Answer | "out" | "unknown">>;
  takenBack: Record<Run, boolean>;
  budget: Bounds;
  /** Whether a message sent after a relaunch is held to "never while a Mend turn is open". */
  checkTurnOpen: boolean;
}

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

const initial = (bounds: Bounds, checkTurnOpen: boolean): World => {
  const queue = emptyQueue();
  for (const run of RUNS)
    queue.entries.push(
      newEntry({
        historyPosition: POSITION,
        postId: `post-${run}`,
        runId: run,
        messageId: `message-${run}`,
        text: run,
        requestedAt: iso(0),
        token: "token",
        sender: "sender",
      }),
    );
  return {
    queue,
    view: { agentLive: true, turnOpen: false, status: "running", updatedAt: 1, evidence: 1 },
    now: 0,
    calls: [],
    posts: { "run-a": [], "run-b": [] },
    takenBack: { "run-a": false, "run-b": false },
    budget: { ...bounds },
    checkTurnOpen,
  };
};

const entryOf = (world: World, run: Run) =>
  world.queue.entries.find((entry) => entry.runId === run);

const sessionView = (world: World) => ({
  historyPosition: POSITION,
  historyFenced: false,
  known: true,
  agentLive: world.view.agentLive,
  turnOpen: world.view.turnOpen,
  status: world.view.status,
  updatedAt: iso(world.view.updatedAt),
  summary: null,
  evidence: world.view.evidence,
});

/** A broken promise, as the step that broke it. */
class Broken extends Error {}

/** The hub's step: `nextStep`, kept, then the call it starts. */
const step = (world: World) => {
  const heldBefore = world.queue.held;
  const chosen = nextStep(world.queue, sessionView(world), world.now, DEFAULT_QUEUE_TIMINGS);
  if (chosen === null) return;
  if (chosen.kind === "prepare") throw new Broken("a prepare step with no preparation");
  const run = RUNS.find((candidate) => candidate === chosen.entry.runId);
  if (run === undefined) throw new Broken(`a step for an unknown message ${chosen.entry.runId}`);
  if (heldBefore) throw new Broken(`${chosen.kind} of ${run} while the queue was held`);
  if (world.view.turnOpen && (world.checkTurnOpen || chosen.entry.launches === 0))
    throw new Broken(`${chosen.kind} of ${run} while a Mend turn was open`);
  if (world.takenBack[run]) throw new Broken(`${chosen.kind} of ${run} after it was taken back`);
  if (chosen.kind === "send") {
    if (!world.view.agentLive) throw new Broken(`send of ${run} with no live agent`);
    world.calls.push({ kind: "write", run });
  } else world.calls.push({ kind: "launch", run });
};

/** The hub prepares the input, marks the POST uncertain, keeps the queue, and writes the POST. */
const write = (world: World, run: Run) => {
  const entry = entryOf(world, run);
  const post = entry?.post;
  if (post == null) throw new Broken(`a POST of ${run} with no post`);
  if (world.posts[run].some((answer) => answer !== "not-live"))
    throw new Broken(`${run} POSTed again after ${world.posts[run].join(", ")}`);
  post.input ??= `input of ${run}`;
  post.uncertain = true;
  world.posts[run].push("out");
  world.calls.push({ kind: "post", run });
};

/** `hub.ts`'s handling of a `POST /turns` answer, restated. */
const answerPost = (world: World, run: Run, answer: Answer) => {
  const entry = entryOf(world, run);
  world.posts[run][world.posts[run].lastIndexOf("out")] = answer;
  if (entry === undefined || entry.post === null) return;
  const post = entry.post;
  if (answer === "taken") {
    post.uncertain = false;
    adopted(world.queue, entry);
  } else if (answer === "unavailable") {
    entry.state = "queued";
    entry.historyHeld = true;
    entry.error = POST_UNCERTAIN;
    world.queue.held = true;
  } else {
    post.uncertain = false;
    post.input = null;
    if (answer === "not-live")
      notLive(world.queue, entry, {
        now: world.now,
        evidence: world.view.evidence,
        refusal: "not live",
        timings: DEFAULT_QUEUE_TIMINGS,
      });
    else fail(world.queue, entry, "refused");
  }
};

/** `hub.ts`'s `launchAgain` once Mend answered: stamped with the session row, or failed. */
const answerLaunch = (world: World, run: Run, ok: boolean) => {
  const entry = entryOf(world, run);
  if (entry === undefined) return;
  if (ok) launchAnswered(entry, iso(world.view.updatedAt));
  else fail(world.queue, entry, "launch refused");
};

/**
 * A copy every event may change. The queue's entries are copied field by field: their strings,
 * selections and image lists are never mutated in place, so they are shared.
 */
const clone = (world: World): World => ({
  queue: {
    ...world.queue,
    entries: world.queue.entries.map((entry) => ({
      ...entry,
      post: entry.post === null ? null : { ...entry.post },
    })),
    preparation: world.queue.preparation === null ? null : { ...world.queue.preparation },
  },
  view: { ...world.view },
  now: world.now,
  calls: [...world.calls],
  posts: { "run-a": [...world.posts["run-a"]], "run-b": [...world.posts["run-b"]] },
  takenBack: { ...world.takenBack },
  budget: { ...world.budget },
  checkTurnOpen: world.checkTurnOpen,
});

/** A fresh read of the session from Mend: new evidence, and a newer row. */
const read = (next: World) => {
  next.view.evidence += 1;
  next.view.updatedAt += 1;
};

/** Every event that can happen next, each as a function of a copy of the world. */
const events = (world: World): Array<[string, (next: World) => void]> => {
  const out: Array<[string, (next: World) => void]> = [["step", step]];
  world.calls.forEach((call, index) => {
    const done = (next: World) => next.calls.splice(index, 1);
    if (call.kind === "write")
      out.push([
        `write ${call.run}`,
        (next) => {
          done(next);
          write(next, call.run);
        },
      ]);
    else if (call.kind === "post")
      for (const answer of ["taken", "not-live", "refused", "unavailable"] as const)
        out.push([
          `${answer} ${call.run}`,
          (next) => {
            done(next);
            answerPost(next, call.run, answer);
          },
        ]);
    else
      for (const ok of [true, false])
        out.push([
          `launch ${ok ? "answered" : "refused"} ${call.run}`,
          (next) => {
            done(next);
            answerLaunch(next, call.run, ok);
          },
        ]);
  });
  if (!world.view.agentLive)
    out.push([
      "agent live",
      (next) => {
        read(next);
        next.view.agentLive = true;
        next.view.status = "running";
      },
    ]);
  if (world.view.agentLive && world.budget.stops > 0)
    out.push([
      "session stops",
      (next) => {
        read(next);
        next.budget.stops -= 1;
        next.view.agentLive = false;
        next.view.turnOpen = false;
        next.view.status = "stopped";
        sessionStopped(next.queue, iso(next.view.updatedAt));
      },
    ]);
  if (world.budget.turns > 0 || world.view.turnOpen)
    out.push([
      world.view.turnOpen ? "Mend turn ends" : "Mend turn opens",
      (next) => {
        read(next);
        if (!next.view.turnOpen) next.budget.turns -= 1;
        next.view.turnOpen = !next.view.turnOpen;
      },
    ]);
  if (world.budget.takeBacks > 0)
    for (const run of RUNS)
      for (const hold of [false, true])
        out.push([
          `take back ${run}${hold ? ", holding the queue" : ""}`,
          (next) => {
            if (takeBack(next.queue, run, hold)) {
              next.budget.takeBacks -= 1;
              next.takenBack[run] = true;
            }
          },
        ]);
  if (world.queue.held) out.push(["resume", (next) => resume(next.queue)]);
  if (world.budget.ticks > 0) {
    const wake = nextWake(world.queue);
    if (wake !== null && wake > world.now)
      out.push([
        "a retry's wait passes",
        (next) => {
          next.budget.ticks -= 1;
          next.now = wake;
          read(next);
        },
      ]);
    out.push([
      "every deadline passes",
      (next) => {
        next.budget.ticks -= 1;
        next.now += DEFAULT_QUEUE_TIMINGS.launchDeadlineMs;
        read(next);
      },
    ]);
  }
  if (world.budget.restarts > 0)
    out.push([
      "gateway restarts",
      (next) => {
        next.budget.restarts -= 1;
        const stored = JSON.parse(JSON.stringify(storedOf(next.queue)));
        next.queue = restoredQueue(stored, () => "token");
        next.calls = [];
        for (const run of RUNS)
          next.posts[run] = next.posts[run].map((answer) =>
            answer === "out" ? "unknown" : answer,
          );
        // A restarted gateway's monotonic clock starts again.
        next.now = 0;
      },
    ]);
  return out;
};

/** The fields of a world that can differ between two reachable worlds: its identity in the walk. */
const keyOf = (world: World) =>
  JSON.stringify([
    world.queue.held,
    world.queue.entries.map((entry) => [
      entry.runId,
      entry.state,
      entry.error,
      entry.historyHeld,
      entry.post?.input ?? null,
      entry.post?.uncertain ?? null,
      entry.launches,
      entry.launchAnsweredAt,
      entry.launchDeadline,
      entry.retryAt,
      entry.retryEvidence,
      entry.notLiveAnswers,
      entry.sendDeadline,
      entry.lastRefusal,
      entry.takenBack,
      entry.stoppedDuringSend,
    ]),
    world.view,
    world.now,
    world.calls,
    world.posts,
    world.takenBack,
    world.budget,
  ]);

/** A path through the walk, kept as a link to the one before it. */
interface Trail {
  readonly name: string;
  readonly before: Trail | null;
}
const names = (trail: Trail | null): Array<string> =>
  trail === null ? [] : [...names(trail.before), trail.name];

/** Every world reachable from the start, breadth first, until none is new or a promise breaks. */
const explore = (bounds: Bounds, checkTurnOpen: boolean) => {
  const seen = new Set<string>();
  let frontier: Array<{ world: World; trail: Trail | null }> = [
    { world: initial(bounds, checkTurnOpen), trail: null },
  ];
  while (frontier.length > 0) {
    const next: typeof frontier = [];
    for (const { world, trail } of frontier)
      for (const [name, apply] of events(world)) {
        const after = clone(world);
        try {
          apply(after);
          const onItsWay = after.queue.entries.filter(
            (entry) => entry.state === "sending" || entry.state === "launching",
          );
          if (onItsWay.length > 1)
            throw new Broken(
              `${onItsWay.map((entry) => entry.runId).join(" and ")} both on their way`,
            );
        } catch (error) {
          if (error instanceof Broken)
            return { states: seen.size, broken: [...names(trail), name, `→ ${error.message}`] };
          throw error;
        }
        const key = keyOf(after);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ world: after, trail: { name, before: trail } });
      }
    frontier = next;
  }
  return { states: seen.size, broken: null };
};

/** One of each bounded event per path: about 400,000 worlds, the whole space within these bounds. */
const FULL: Bounds = { stops: 1, restarts: 1, takeBacks: 1, ticks: 1, turns: 1 };

const brokenPromise = (broken: ReadonlyArray<string> | null) =>
  broken === null ? null : `a promise broke:\n  ${broken.join("\n  ")}`;

describe("the gateway queue under every interleaving (ADR 0012)", () => {
  it("sends one message at a time, only to a free live agent, and never twice unless Mend said not live", () => {
    const { states, broken } = explore(FULL, false);
    expect(brokenPromise(broken)).toBeNull();
    // About 400,000 worlds: far fewer means the walk lost events, not that the queue got simpler.
    expect(states).toBeGreaterThan(100_000);
  });

  // SLNT-1023: once a relaunched agent is live, the message the gateway launched it for is sent
  // even while a Mend turn is open. When that is decided, this test passes and loses its `fails`.
  // No retry: Vitest retries before `fails` inverts the result, so CI's one retry would rerun this
  // expected failure every time and report it as a flake, and a retry could only turn it red.
  it.fails(
    "waits for an open Mend turn before sending a message it relaunched for",
    { retry: 0 },
    () => {
      expect(brokenPromise(explore(FULL, true).broken)).toBeNull();
    },
  );
});
