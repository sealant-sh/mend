import { describe, expect, it } from "vitest";

import { Launches } from "./launches.js";
import { MendApiError } from "./mend-http.js";
import type { LaunchRequest } from "./new-session.js";
import type { LaunchAttempt } from "./session-model.js";
import type { Session, SessionStatus } from "./types.js";

const START: LaunchRequest = { mode: "pty", prompt: "add rate limiting", model: "opus" };
const S1 = "2026-10-19T09:00:06.000Z";

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
  answers: ReadonlyArray<"ok" | "refused" | "under-way" | "unanswered" | "edge-504">,
  reads: ReadonlyArray<Session>,
) => {
  const launched: Array<{ readonly sessionId: string; readonly body: LaunchRequest }> = [];
  let answer = 0;
  let read = 0;
  return {
    launched,
    launchSession: async (sessionId: string, body: LaunchRequest) => {
      launched.push({ sessionId, body });
      const said = answers[answer++] ?? "ok";
      if (said === "refused") throw new MendApiError("Over the organization's budget.", 429);
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

const sink = () => {
  const said: Array<{ readonly sessionId: string; readonly attempt: LaunchAttempt }> = [];
  return {
    said,
    attempted: (sessionId: string, attempt: LaunchAttempt) => said.push({ sessionId, attempt }),
  };
};

describe("Launches", () => {
  it("says each attempt to the store, and a refusal in the server's words", async () => {
    const store = sink();
    await new Launches(fakeServer(["refused"], []), store).launch("s1", START);
    expect(store.said.at(-1)?.attempt).toMatchObject({
      n: 1,
      after: null,
      refusal: { line: "launch refused · Over the organization's budget." },
    });
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
    expect(await launches.offer("s1")).toEqual({ kind: "moved" });
    await launches.relaunch("s1");
    expect(server.launched).toHaveLength(1);
  });

  it("reads an edge's 5xx as no answer: nothing refused, and no Retry while it reads starting", async () => {
    const server = fakeServer(["edge-504"], [session("starting")]);
    const store = sink();
    const launches = new Launches(server, store);
    await launches.launch("s1", START);
    expect(store.said.at(-1)?.attempt).toEqual({ n: 1, after: null, refusal: null });
    expect(await launches.offer("s1")).toEqual({ kind: "moved" });
    await launches.relaunch("s1");
    expect(server.launched).toHaveLength(1);
  });

  it("never sends a Retry while the session reads starting after a lost answer", async () => {
    const server = fakeServer(["unanswered"], [session("starting")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    await launches.relaunch("s1");
    expect(server.launched).toHaveLength(1);
  });

  it("sends a Retry for a session that reads failed: the same launch, the next attempt, after its settle", async () => {
    const server = fakeServer(["ok", "ok"], [session("failed", S1)]);
    const store = sink();
    const launches = new Launches(server, store);
    await launches.launch("s1", START);
    await launches.relaunch("s1");
    expect(server.launched).toEqual([
      { sessionId: "s1", body: START },
      { sessionId: "s1", body: START },
    ]);
    expect(store.said.at(-1)?.attempt).toEqual({ n: 2, after: S1, refusal: null });
  });

  it("sends a Retry for a refused launch the server still reads starting: it never started", async () => {
    const server = fakeServer(["refused", "ok"], [session("starting")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    expect((await launches.offer("s1")).kind).toBe("retry");
    await launches.relaunch("s1");
    expect(server.launched).toHaveLength(2);
  });

  it("says a refusal only once nothing is on its way, so the toast it raises can offer Retry", async () => {
    const server = fakeServer(["refused"], [session("starting")]);
    const offers: Array<Promise<{ readonly kind: string }>> = [];
    const launches: Launches = new Launches(server, {
      attempted: (sessionId, attempt) => {
        if (attempt.refusal !== null) offers.push(launches.offer(sessionId));
      },
    });
    await launches.launch("s1", START);
    expect(await Promise.all(offers)).toMatchObject([{ kind: "retry" }]);
  });

  it("never retries a refusal that says another launch of it is under way", async () => {
    const server = fakeServer(["under-way"], [session("starting")]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    expect(await launches.offer("s1")).toEqual({ kind: "moved" });
    await launches.relaunch("s1");
    expect(server.launched).toHaveLength(1);
  });

  it("sends one Retry for two clicks at once", async () => {
    const server = fakeServer(["refused", "ok", "ok"], [session("failed", S1)]);
    const launches = new Launches(server, sink());
    await launches.launch("s1", START);
    await Promise.all([launches.relaunch("s1"), launches.relaunch("s1")]);
    expect(server.launched).toHaveLength(2);
  });

  it("offers nothing to retry for a session this window did not launch, or a prompt no agent can take", async () => {
    const server = fakeServer([], [session("failed", S1)]);
    const launches = new Launches(server, sink());
    expect(await launches.offer("s2")).toEqual({ kind: "none" });
    await launches.relaunch("s2");
    await launches.launch("s1", { mode: "pty", prompt: "a\0b" });
    expect(await launches.offer("s1")).toEqual({ kind: "none" });
    await launches.relaunch("s1");
    expect(server.launched).toHaveLength(1);
  });
});
