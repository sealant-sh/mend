import type { LaunchAdmissionRule } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import { ConnectionChanged, Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import type { LaunchRequest } from "./new-session.js";
import type { LaunchAttempt } from "./session-model.js";
import type { LaunchExpected, Session, SessionProcess, SessionStatus } from "./types.js";

type LaunchBody = LaunchRequest & { readonly expected?: LaunchExpected };

const AGENT_RAN: LaunchAdmissionRule = "agentRan";

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
      return { session: at, processes: [], currentAgent: null, launchAdmission: AGENT_RAN };
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
    sessionDetail: async () => ({
      session: now,
      processes: [],
      currentAgent: null,
      launchAdmission: AGENT_RAN,
    }),
  };
};

const ALREADY_RAN = "an agent already ran in this session · it reads idle · nothing launched again";

const EXITED_AGENT: SessionProcess = {
  id: "agent-1",
  kind: "agent-pty",
  harness: "claude",
  status: "exited",
  exitedAt: S1,
  providerSessionId: null,
  label: "claude",
  runsAs: null,
  waiting: null,
};

const lateOriginal = () => {
  const launched: Array<LaunchBody> = [];
  let agent: SessionProcess | null = null;
  let runsBeforeRetry = false;
  return {
    launched,
    originalRan: () => {
      agent = EXITED_AGENT;
    },
    originalRunsBeforeRetry: () => {
      runsBeforeRetry = true;
    },
    launchSession: async (_: string, body: LaunchBody) => {
      launched.push(body);
      if (launched.length === 1)
        throw new MendApiError(
          "Mend could not do that. Try again; the server log has the detail.",
          504,
        );
      if (runsBeforeRetry) agent = EXITED_AGENT;
      if (agent !== null && body.expected?.settledAt === null)
        throw new MendApiError(ALREADY_RAN, 409, "SessionMovedOn", null, {
          _tag: "SessionMovedOn",
          sessionId: "s1",
          status: "idle",
          settledAt: null,
          reason: "agentRan",
          message: ALREADY_RAN,
        });
      return {};
    },
    sessionDetail: async () => ({
      session: session("idle"),
      processes: [],
      currentAgent: agent,
      launchAdmission: AGENT_RAN,
    }),
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
    await new Launches(store).launch("s1", START, {
      client: fakeServer(["refused"], [session("starting")]),
    });
    expect(store.said.at(-1)?.attempt).toMatchObject({
      n: 1,
      after: null,
      refusal: { line: "launch refused · Over the organization's budget.", confirmed: true },
    });
  });

  it("says a refusal whose confirming read failed as unconfirmed: whether it settled is unknown", async () => {
    const store = sink();
    await new Launches(store).launch("s1", START, { client: fakeServer(["refused"], []) });
    expect(store.said.at(-1)?.attempt.refusal).toMatchObject({ confirmed: false });
  });

  it("says no refusal for one the server settled failed before it answered: that failure says it", async () => {
    const store = sink();
    await new Launches(store).launch("s1", START, {
      client: fakeServer(["refused"], [session("failed", S1)]),
    });
    expect(store.said.at(-1)?.attempt).toEqual({ n: 1, after: null, refusal: null });
  });

  it("says no refusal for a launch with no answer: it may be running", async () => {
    const store = sink();
    await new Launches(store).launch("s1", START, { client: fakeServer(["unanswered"], []) });
    expect(store.said.map((one) => one.attempt)).toEqual([
      { n: 1, after: null, refusal: null },
      { n: 1, after: null, refusal: null },
    ]);
  });

  it("never sends a Retry for a launch whose answer was lost and which runs now", async () => {
    const server = fakeServer(["unanswered"], [session("running")]);
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect(await launches.offer("s1")).toMatchObject({ kind: "moved" });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("reads an edge's 5xx as no answer: nothing refused, and no Retry while it reads starting", async () => {
    const server = fakeServer(["edge-504"], [session("starting")]);
    const store = sink();
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server });
    expect(store.said.at(-1)?.attempt).toEqual({ n: 1, after: null, refusal: null });
    expect(await launches.offer("s1")).toMatchObject({ kind: "moved" });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("never sends a Retry while the session reads starting after a lost answer", async () => {
    const server = fakeServer(["unanswered"], [session("starting")]);
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("sends a Retry for a session that reads failed: the same launch over the failure the toast saw, the next attempt", async () => {
    const server = fakeServer(["ok", "ok"], [session("failed", S1)]);
    const store = sink();
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server });
    await launches.relaunch("s1", S1);
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: { ...START, expected: { settledAt: S1 } } },
    ]);
    expect(store.said.at(-1)?.attempt).toEqual({ n: 2, after: S1, refusal: null });
  });

  it("sends a Retry for a refused launch the server still reads starting: it never started", async () => {
    const server = fakeServer(["refused", "ok"], [session("starting")]);
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect((await launches.offer("s1")).kind).toBe("retry");
    await launches.relaunch("s1", null);
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: { ...START, expected: { settledAt: null } } },
    ]);
  });

  it("says a refusal only once nothing is on its way, so the toast it raises can offer Retry", async () => {
    const server = fakeServer(["refused"], [session("starting")]);
    const offers: Array<Promise<{ readonly kind: string }>> = [];
    const launches: Launches = new Launches({
      attempted: (sessionId, attempt) => {
        if (attempt.refusal !== null) offers.push(launches.offer(sessionId));
      },
      forget: () => {},
    });
    await launches.launch("s1", START, { client: server });
    expect(await Promise.all(offers)).toMatchObject([{ kind: "retry" }]);
  });

  it("never retries a refusal that says another launch of it is under way", async () => {
    const server = fakeServer(["under-way"], [session("starting")]);
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect(await launches.offer("s1")).toMatchObject({ kind: "moved" });
    await launches.relaunch("s1", null);
    expect(server.launched).toHaveLength(1);
  });

  it("sends one Retry for two clicks at once", async () => {
    const server = fakeServer(["refused", "ok", "ok"], [session("failed", S1)]);
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    await Promise.all([launches.relaunch("s1", S1), launches.relaunch("s1", S1)]);
    expect(server.launched).toHaveLength(2);
  });

  it("offers nothing to retry for a session this window did not launch, or a prompt no agent can take", async () => {
    const server = fakeServer([], [session("failed", S1)]);
    const launches = new Launches(sink());
    expect(await launches.offer("s2")).toEqual({ kind: "none" });
    await launches.relaunch("s2", S1);
    await launches.launch("s1", { mode: "pty", prompt: "a\0b" }, { client: server });
    expect(await launches.offer("s1")).toEqual({ kind: "none" });
    await launches.relaunch("s1", S1);
    expect(server.launched).toHaveLength(1);
  });

  it("sends nothing more when Mend says the session moved on, and gives back how it reads now", async () => {
    const running: Session = { ...session("running"), summary: "reading src/auth" };
    const server = fakeServer(["ok", "moved-on"], [session("failed", S1), running]);
    const store = sink();
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server });
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
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect(await launches.relaunch("s1", null)).toEqual({
      kind: "agentLive",
      read: running,
      said: AGENT_LIVE,
    });
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: { ...START, expected: { settledAt: null } } },
    ]);
  });

  it.each(["agentLive", "underWay"])(
    "offers Open when Mend refuses the Retry as moved on over an agent that is %s",
    async (reason) => {
      const running: Session = { ...session("running"), summary: "reading src/auth" };
      const server = {
        ...fakeServer(["refused"], [session("starting"), session("starting"), running]),
        launchSession: async (_: string, body: LaunchBody) => {
          server.launched.push({ sessionId: "s1", body });
          if (server.launched.length === 1)
            throw new MendApiError("Over the organization's budget.", 429);
          throw new MendApiError(MOVED_ON, 409, "SessionMovedOn", null, { reason });
        },
      };
      const launches = new Launches(sink());
      await launches.launch("s1", START, { client: server });
      expect(await launches.relaunch("s1", null)).toEqual({
        kind: "agentLive",
        read: running,
        said: MOVED_ON,
      });
    },
  );

  it("refuses the second of two windows' Retries from the same stale toast, and it sends nothing more", async () => {
    const server = admittingServer(session("starting"));
    const here = new Launches(sink());
    const there = new Launches(sink());
    await here.launch("s1", START, { client: server });
    server.settle(session("failed", S1));
    await there.launch("s1", START, { client: server });
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
  it("reads a launch Mend never answered as refused while no agent ever ran, so Retry sends it", async () => {
    const server = fakeServer(["unanswered", "ok"], [session("idle")]);
    const store = sink();
    const confirmed: Array<string> = [];
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server, confirmed: () => confirmed.push("s1") });
    expect(store.said.at(-1)?.attempt.refusal).toMatchObject({
      line: "launch not answered · Cannot reach Mend at http://localhost:3100.",
      confirmed: true,
    });
    expect(confirmed).toEqual([]);
    expect((await launches.offer("s1")).kind).toBe("retry");
    expect(await launches.relaunch("s1", null)).toEqual({ kind: "sent" });
    expect(server.launched.map((one) => one.body)).toEqual([
      START,
      { ...START, expected: { settledAt: null } },
    ]);
    expect(confirmed).toEqual(["s1"]);
  });

  it("offers no Retry for an unanswered launch once the idle session shows an agent ran", async () => {
    const server = {
      ...fakeServer(["unanswered"], []),
      sessionDetail: async () => ({
        session: session("idle"),
        processes: [],
        currentAgent: {
          id: "agent-1",
          kind: "agent-pty",
          harness: "claude",
          status: "exited",
          exitedAt: S1,
          providerSessionId: null,
          label: "claude",
          runsAs: null,
          waiting: null,
        },
        launchAdmission: AGENT_RAN,
      }),
    };
    const store = sink();
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server });
    expect(store.said.at(-1)?.attempt.refusal).toBeNull();
    expect((await launches.offer("s1")).kind).toBe("moved");
  });

  it("offers no Retry once the launch Mend never answered arrives late, runs and exits beside a shell", async () => {
    const server = lateOriginal();
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect((await launches.offer("s1")).kind).toBe("retry");
    server.originalRan();
    expect(await launches.offer("s1")).toEqual({ kind: "moved", read: session("idle") });
    expect(await launches.relaunch("s1", null)).toEqual({
      kind: "movedOn",
      read: session("idle"),
      said: null,
    });
    expect(server.launched).toEqual([START]);
  });

  it("says an agent already ran in the session when the late launch ran between Retry's read and its arrival", async () => {
    const server = lateOriginal();
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect((await launches.offer("s1")).kind).toBe("retry");
    server.originalRunsBeforeRetry();
    expect(await launches.relaunch("s1", null)).toEqual({
      kind: "alreadyRan",
      read: session("idle"),
      said: ALREADY_RAN,
    });
    expect(server.launched).toEqual([START, { ...START, expected: { settledAt: null } }]);
  });

  it("sends the first launch and its Retry on the client it was launched on", async () => {
    const original = fakeServer(["refused", "ok"], [session("idle")]);
    const attempts: LaunchAttempt[] = [];
    const launches = new Launches({
      attempted: (_id, attempt) => {
        attempts.push(attempt);
      },
      forget: () => undefined,
    });
    await launches.launch("s1", START, { client: original });
    expect((await launches.offer("s1")).kind).toBe("retry");
    expect(await launches.relaunch("s1", null)).toEqual({ kind: "sent" });
    expect(original.launched).toHaveLength(2);
    expect(attempts.some((attempt) => attempt.refusal?.line.includes("budget"))).toBe(true);
  });

  it("sends no launch or Retry once its client's connection changed, and says no attempt", async () => {
    const server = fakeServer(["refused", "ok"], [session("idle")]);
    let moved = false;
    const bound = {
      isCurrent: async () => !moved,
      sessionDetail: server.sessionDetail,
      launchSession: async (sessionId: string, body: LaunchBody) => {
        if (moved) throw new ConnectionChanged();
        return server.launchSession(sessionId, body);
      },
    };
    const attempts: LaunchAttempt[] = [];
    let confirmed = 0;
    const launches = new Launches({
      attempted: (_id, attempt) => {
        attempts.push(attempt);
      },
      forget: () => undefined,
    });

    moved = true;
    await launches.launch("s2", START, {
      client: bound,
      confirmed: () => {
        confirmed++;
      },
    });
    expect(server.launched).toEqual([]);
    expect(attempts).toEqual([]);
    expect(confirmed).toBe(0);

    moved = false;
    await launches.launch("s1", START, { client: bound });
    expect((await launches.offer("s1")).kind).toBe("retry");
    const said = attempts.length;
    moved = true;
    expect(await launches.relaunch("s1", null)).toEqual({ kind: "held" });
    expect(server.launched).toHaveLength(1);
    expect(attempts).toHaveLength(said);

    moved = false;
    expect(await launches.relaunch("s1", null)).toEqual({ kind: "sent" });
    expect(server.launched).toHaveLength(2);
    expect(attempts.at(-1)?.n).toBe(2);
  });
});

const SHELL: SessionProcess = {
  id: "shell-1",
  kind: "shell",
  harness: null,
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  label: "shell",
  runsAs: null,
  waiting: null,
};

const unansweredServer = (
  admission: "older" | "agentRan",
  original: "deliveredLate" | "neverArrived",
) => {
  const launched: Array<LaunchBody> = [];
  const executions: Array<string> = [];
  let agent: SessionProcess | null = null;
  let held: (() => void) | null = null;
  const admit = (body: LaunchBody) => {
    if (admission === "agentRan" && body.expected?.settledAt === null && agent !== null)
      throw new MendApiError(ALREADY_RAN, 409, "SessionMovedOn", null, {
        _tag: "SessionMovedOn",
        sessionId: "s1",
        status: "idle",
        settledAt: null,
        reason: "agentRan",
        message: ALREADY_RAN,
      });
    executions.push(body.prompt ?? "");
    agent = EXITED_AGENT;
  };
  const deliver = () => {
    const late = held;
    held = null;
    late?.();
  };
  return {
    launched,
    executions,
    deliver,
    launchSession: async (_: string, body: LaunchBody) => {
      launched.push(body);
      if (launched.length === 1) {
        if (original === "deliveredLate") held = () => admit(body);
        throw new MendApiError(
          "Mend could not do that. Try again; the server log has the detail.",
          504,
        );
      }
      deliver();
      admit(body);
      return {};
    },
    sessionDetail: async () => ({
      session: session("idle"),
      processes: agent === null ? [] : [SHELL, agent],
      currentAgent: agent,
      launchAdmission: admission === "agentRan" ? AGENT_RAN : null,
    }),
  };
};

describe("a launch Mend never answered, by what the server says of its Retry", () => {
  it("offers no Retry from a server that does not say it refuses one once an agent ran: her prompt runs once", async () => {
    const server = unansweredServer("older", "deliveredLate");
    const store = sink();
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server });
    const refusal = store.said.at(-1)?.attempt.refusal;
    const offer = await launches.offer("s1");
    const retry = await launches.relaunch("s1", null);
    server.deliver();
    expect({
      refusal,
      offer,
      retry,
      launched: server.launched,
      executions: server.executions,
    }).toMatchObject({
      refusal: {
        line: "launch not confirmed · Mend did not answer · check the session",
        confirmed: true,
        unanswered: true,
      },
      offer: { kind: "none" },
      retry: { kind: "held" },
      launched: [START],
      executions: [START.prompt],
    });
  });

  it("offers Retry from a server that refuses it once an agent ran, which says the late launch ran it", async () => {
    const server = unansweredServer("agentRan", "deliveredLate");
    const store = sink();
    const launches = new Launches(store);
    await launches.launch("s1", START, { client: server });
    expect(store.said.at(-1)?.attempt.refusal).toMatchObject({
      line: "launch not answered · Mend could not do that. Try again; the server log has the detail.",
      confirmed: true,
      unanswered: true,
    });
    expect((await launches.offer("s1")).kind).toBe("retry");
    expect(await launches.relaunch("s1", null)).toMatchObject({
      kind: "alreadyRan",
      said: ALREADY_RAN,
    });
    expect(server.launched).toEqual([START, { ...START, expected: { settledAt: null } }]);
    expect(server.executions).toEqual([START.prompt]);
  });

  it("sends one Retry for a launch that never arrived, on a server that refuses one once an agent ran", async () => {
    const server = unansweredServer("agentRan", "neverArrived");
    const launches = new Launches(sink());
    await launches.launch("s1", START, { client: server });
    expect((await launches.offer("s1")).kind).toBe("retry");
    expect(await launches.relaunch("s1", null)).toEqual({ kind: "sent" });
    expect(server.launched).toEqual([START, { ...START, expected: { settledAt: null } }]);
    expect(server.executions).toEqual([START.prompt]);
  });

  it.each([
    { admission: "older", offer: "none", launched: 1 },
    { admission: "agentRan", offer: "retry", launched: 2 },
  ] as const)(
    "a new session's first launch, as New session sends it, offers $offer from a server with $admission admission",
    async ({ admission, offer, launched }) => {
      const server = unansweredServer(admission, "neverArrived");
      const launches = new Launches(sink());
      const created = { id: "s1" };
      await launches.launch(created.id, START, { client: server });
      expect((await launches.offer(created.id)).kind).toBe(offer);
      await launches.relaunch(created.id, null);
      expect(server.launched).toHaveLength(launched);
    },
  );
});
