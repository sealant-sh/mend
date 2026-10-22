import { describe, expect, it } from "vitest";

import { Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import type { LaunchRequest } from "./new-session.js";
import type { LaunchAttempt } from "./session-model.js";
import type { LaunchExpected, Session, SessionStatus } from "./types.js";

type LaunchBody = LaunchRequest & { readonly expected?: LaunchExpected };

const START: LaunchRequest = { mode: "pty", prompt: "add rate limiting", model: "opus" };
const S1 = "2026-10-19T09:00:06.000Z";
const MOVED_ON = "the session moved on · it reads running · nothing launched";
const AGENT_LIVE =
  "the session's agent is live · nothing restarted · attach to it, or stop it and launch again";

const session = (status: SessionStatus, settledAt: string | null = null): Session => ({
  id: "s1",
  projectId: "p1",
  harness: "claude",
  model: null,
  label: null,
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status,
  sealantWorkspaceId: null,
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  settledAt,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
});

/**
 * A server: each launch answers as `answers` says in turn (ok, a refusal, or no answer at all),
 * and each read returns `reads` in turn (the last one repeats).
 */
const fakeServer = (
  answers: ReadonlyArray<
    "ok" | "refused" | "under-way" | "unanswered" | "edge-504" | "moved-on" | "agent-live"
  >,
  reads: ReadonlyArray<Session>,
) => {
  const launched: Array<{ readonly sessionId: string; readonly body: LaunchBody }> = [];
  let answer = 0;
  let read = 0;
  return {
    launched,
    launchSession: async (sessionId: string, body: LaunchBody) => {
      launched.push({ sessionId, body });
      const said = answers[answer++] ?? "ok";
      if (said === "refused") throw new MendApiError("Over the organization's budget.", 429);
      if (said === "moved-on") throw new MendApiError(MOVED_ON, 409, "SessionMovedOn");
      if (said === "agent-live") throw new MendApiError(AGENT_LIVE, 409, "SessionAgentLive");
      if (said === "under-way")
        throw new MendApiError(
          "starting · a launch of this session is already under way · nothing new started",
          422,
          "StoreFailure",
        );
      if (said === "unanswered")
        throw new MendApiError("Cannot reach Mend at http://localhost:3100.", null);
      if (said === "edge-504")
        throw new MendApiError(
          "Mend could not do that. Try again; the server log has the detail.",
          504,
        );
      return {};
    },
    sessionDetail: async () => {
      const at = reads[Math.min(read++, reads.length - 1)];
      if (at === undefined) throw new Error("no read");
      return { session: at };
    },
  };
};

/**
 * One server two windows share, admitting as `refusalOf` does: a launch naming `expected` only
 * over that settle with no agent live, one without only with no agent live. An admitted launch runs.
 */
const admittingServer = (initial: Session) => {
  let now = initial;
  let agentLive = false;
  const bodies: Array<LaunchBody> = [];
  const admitted: Array<LaunchBody> = [];
  const live = () => agentLive;
  return {
    bodies,
    admitted,
    /** The agent exited and the session settled as `settled` reads. */
    settle: (settled: Session) => {
      now = settled;
      agentLive = false;
    },
    launchSession: async (_: string, body: LaunchBody) => {
      bodies.push(body);
      if (body.expected !== undefined && (live() || now.settledAt !== body.expected.settledAt))
        throw new MendApiError(
          `the session moved on · it reads ${now.status} · nothing launched`,
          409,
          "SessionMovedOn",
        );
      if (body.expected === undefined && live())
        throw new MendApiError(AGENT_LIVE, 409, "SessionAgentLive");
      admitted.push(body);
      agentLive = true;
      now = { ...now, status: "running", settledAt: null, summary: "reading src/auth" };
      return {};
    },
    sessionDetail: async () => ({ session: now }),
  };
};

const sink = () => {
  const said: Array<{ readonly sessionId: string; readonly attempt: LaunchAttempt }> = [];
  const forgot: Array<string> = [];
  return {
    said,
    forgot,
    attempted: (sessionId: string, attempt: LaunchAttempt) => said.push({ sessionId, attempt }),
    forget: (sessionId: string) => forgot.push(sessionId),
  };
};

describe("Launches", () => {
  it("says each attempt to the store, and a refusal in the server's words", async () => {
    const store = sink();
    await new Launches(fakeServer(["refused"], [session("starting")]), store).launch("s1", START);
    expect(store.said.at(-1)?.attempt).toMatchObject({
      n: 1,
      after: null,
      refusal: { line: "launch refused · Over the organization's budget.", confirmed: true },
    });
  });

  it("says a refusal whose confirming read failed as unconfirmed: whether it settled is unknown", async () => {
    const store = sink();
    await new Launches(fakeServer(["refused"], []), store).launch("s1", START);
    expect(store.said.at(-1)?.attempt.refusal).toMatchObject({ confirmed: false });
  });

  it("says no refusal for one the server settled failed before it answered: that failure says it", async () => {
    const store = sink();
    await new Launches(fakeServer(["refused"], [session("failed", S1)]), store).launch("s1", START);
    expect(store.said.at(-1)?.attempt).toEqual({ n: 1, after: null, refusal: null });
  });

  it("says no refusal for a launch with no answer: it may be running", async () => {
    const store = sink();
    await new Launches(fakeServer(["unanswered"], []), store).launch("s1", START);
    expect(store.said.map((one) => one.attempt)).toEqual([
      { n: 1, after: null, refusal: null },
      { n: 1, after: null, refusal: null },
    ]);
  });

  it("never sends a Retry for a launch whose answer was lost and which runs now", async () => {
    const server = fakeServer(["unanswered"], [session("running")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    expect(await launches.offer("s1")).toMatchObject({ kind: "moved" });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("reads an edge's 5xx as no answer: nothing refused, and no Retry while it reads starting", async () => {
    const server = fakeServer(["edge-504"], [session("starting")]);
    const store = sink();
    const launches = new Launches(server, store);
    await launches.launch("s1", START);
    expect(store.said.at(-1)?.attempt).toEqual({ n: 1, after: null, refusal: null });
    expect(await launches.offer("s1")).toMatchObject({ kind: "moved" });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("never sends a Retry while the session reads starting after a lost answer", async () => {
    const server = fakeServer(["unanswered"], [session("starting")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("sends a Retry for a session that reads failed: the same launch over the failure the toast saw, the next attempt", async () => {
    const server = fakeServer(["ok", "ok"], [session("failed", S1)]);
    const store = sink();
    const launches = new Launches(server, store);
    await launches.launch("s1", START);
    await launches.relaunch("s1", S1);
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: { ...START, expected: { settledAt: S1 } } },
    ]);
    expect(store.said.at(-1)?.attempt).toEqual({ n: 2, after: S1, refusal: null });
  });

  it("sends a Retry for a refused launch the server still reads starting: it never started", async () => {
    const server = fakeServer(["refused", "ok"], [session("starting")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    expect((await launches.offer("s1")).kind).toBe("retry");
    await launches.relaunch("s1", null);
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: START },
    ]);
  });

  it("says a refusal only once nothing is on its way, so the toast it raises can offer Retry", async () => {
    const server = fakeServer(["refused"], [session("starting")]);
    const offers: Array<Promise<{ readonly kind: string }>> = [];
    const launches: Launches = new Launches(server, {
      attempted: (sessionId, attempt) => {
        if (attempt.refusal !== null) offers.push(launches.offer(sessionId));
      },
      forget: () => {},
    });
    await launches.launch("s1", START);
    expect(await Promise.all(offers)).toMatchObject([{ kind: "retry" }]);
  });

  it("never retries a refusal that says another launch of it is under way", async () => {
    const server = fakeServer(["under-way"], [session("starting")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    expect(await launches.offer("s1")).toMatchObject({ kind: "moved" });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("sends one Retry for two clicks at once", async () => {
    const server = fakeServer(["refused", "ok", "ok"], [session("failed", S1)]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    await Promise.all([launches.relaunch("s1", S1), launches.relaunch("s1", S1)]);
    expect(server.launched).toHaveLength(2);
  });

  it("offers nothing to retry for a session this window did not launch, or a prompt no agent can take", async () => {
    const server = fakeServer([], [session("failed", S1)]);
    const launches = new Launches(server, sink());
    expect(await launches.offer("s2")).toEqual({ kind: "none" });
    await launches.relaunch("s2", S1);
    await launches.launch("s1", { mode: "pty", prompt: "a\0b" });
    expect(await launches.offer("s1")).toEqual({ kind: "none" });
    await launches.relaunch("s1", S1);
    expect(server.launched).toHaveLength(1);
  });

  it("sends nothing more when Mend says the session moved on, and gives back how it reads now", async () => {
    const running: Session = { ...session("running"), summary: "reading src/auth" };
    const server = fakeServer(["ok", "moved-on"], [session("failed", S1), running]);
    const store = sink();
    const launches = new Launches(server, store);
    await launches.launch("s1", START);
    expect(await launches.relaunch("s1", S1)).toEqual({
      kind: "movedOn",
      read: running,
      said: MOVED_ON,
    });
    expect(server.launched).toHaveLength(2);
    expect(store.forgot).toEqual(["s1"]);
  });

  it("starts no second agent when Mend says one is live, and gives back how it reads for Open", async () => {
    const running: Session = { ...session("running"), summary: "reading src/auth" };
    const server = fakeServer(
      ["refused", "agent-live"],
      [session("starting"), session("starting"), running],
    );
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    expect(await launches.relaunch("s1", null)).toEqual({
      kind: "agentLive",
      read: running,
      said: AGENT_LIVE,
    });
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: START },
    ]);
  });

  it("refuses the second of two windows' Retries from the same stale toast, and it sends nothing more", async () => {
    const server = admittingServer(session("starting"));
    const here = new Launches(server, sink());
    const there = new Launches(server, sink());
    await here.launch("s1", START);
    server.settle(session("failed", S1));
    await there.launch("s1", START);
    server.settle(session("failed", S1));
    const answers = await Promise.all([here.relaunch("s1", S1), there.relaunch("s1", S1)]);
    expect(server.admitted).toEqual([START, START, { ...START, expected: { settledAt: S1 } }]);
    expect(server.bodies).toHaveLength(4);
    expect(answers).toMatchObject([
      { kind: "sent" },
      { kind: "movedOn", read: { status: "running", summary: "reading src/auth" } },
    ]);
  });
});

describe("a held handoff's launch", () => {
  it("keeps the bound client for the first launch and its Retry after a connection switch", async () => {
    const original = fakeServer(["refused", "ok"], [session("idle")]);
    const switched = fakeServer(["ok"], [session("idle")]);
    const attempts: LaunchAttempt[] = [];
    const launches = new Launches(switched, {
      attempted: (_id, attempt) => {
        attempts.push(attempt);
      },
      forget: () => undefined,
    });
    await launches.launch("s1", START, original);
    expect((await launches.offer("s1")).kind).toBe("retry");
    expect(await launches.relaunch("s1", null)).toEqual({ kind: "sent" });
    expect(original.launched).toHaveLength(2);
    expect(switched.launched).toEqual([]);
    expect(attempts.some((attempt) => attempt.refusal?.line.includes("budget"))).toBe(true);
  });
});
