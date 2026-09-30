import { describe, expect, it } from "vitest";

import {
  followStart,
  startingLineOf,
  type StartingDetail,
  type StartingSession,
} from "./launch-follow.ts";
import { MendRequestError } from "./server-request.ts";

const starting = (summary: string | null = null): StartingSession => ({
  id: "session-1",
  status: "starting",
  summary,
});
const running: StartingSession = { id: "session-1", status: "running", summary: null };
const ptyAgent = {
  status: "running",
  exitCode: null,
  exitedAt: null,
  harness: "claude",
  sealantSessionId: "pty-1",
  kind: "agent-pty",
};

/** A follower over scripted reads: each read answers the next entry, the last one repeats. */
const follow = (
  start: Promise<StartingSession> | null,
  reads: ReadonlyArray<StartingDetail<StartingSession> | Error>,
) => {
  const lines: Array<string> = [];
  let index = 0;
  let clock = 0;
  const outcome = followStart<StartingSession>({
    start,
    read: async () => {
      const next = reads[Math.min(index, reads.length - 1)];
      index += 1;
      if (next === undefined) throw new Error("no scripted read");
      if (next instanceof Error) throw next;
      return next;
    },
    onLine: (line) => lines.push(line),
    sleep: async (ms) => {
      clock += ms;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    now: () => clock,
  });
  return { outcome, lines, reads: () => index };
};

const never = new Promise<StartingSession>(() => undefined);

describe("followStart", () => {
  it("follows an early `starting` answer until the agent's terminal runs, saying each new line", async () => {
    const run = follow(Promise.resolve(starting()), [
      {
        session: starting("waiting · the previous session in this worktree is saving"),
        currentAgent: null,
      },
      { session: starting("building the workspace image"), currentAgent: null },
      { session: starting("building the workspace image"), currentAgent: null },
      { session: running, currentAgent: ptyAgent },
    ]);
    expect(await run.outcome).toEqual({ kind: "live", session: running });
    expect(run.lines).toEqual([
      "waiting · the previous session in this worktree is saving",
      "starting · building the workspace image",
    ]);
  });

  it("reads the session while the old long launch is held, and attaches once it answers running", async () => {
    const { promise: start, resolve: answer } = Promise.withResolvers<StartingSession>();
    const run = follow(start, [{ session: starting("booting"), currentAgent: null }]);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(run.lines).toEqual(["starting · booting"]);
    answer(running);
    expect(await run.outcome).toEqual({ kind: "live", session: running });
  });

  it("does not fail when the launch request times out or is cut: the session decides", async () => {
    const run = follow(
      Promise.reject(new MendRequestError("timeout", "POST /sessions/session-1/launch no answer")),
      [
        { session: starting("building the workspace image"), currentAgent: null },
        { session: running, currentAgent: ptyAgent },
      ],
    );
    expect(await run.outcome).toEqual({ kind: "live", session: running });
  });

  it("treats an edge's 504 on the launch as no answer, not a refusal", async () => {
    const run = follow(
      Promise.reject(new MendRequestError("http", "POST /sessions/session-1/launch → 504", 504)),
      [{ session: running, currentAgent: ptyAgent }],
    );
    expect((await run.outcome).kind).toBe("live");
  });

  it("returns Mend's own refusal in its words", async () => {
    const run = follow(
      Promise.reject(new MendRequestError("http", "the session is not yours to steer", 403)),
      [{ session: starting(), currentAgent: null }],
    );
    expect(await run.outcome).toEqual({
      kind: "refused",
      message: "the session is not yours to steer",
    });
  });

  it("says the session settled when it fails before its agent runs", async () => {
    const failed = { id: "session-1", status: "failed", summary: "workspace image build failed" };
    const run = follow(never, [
      { session: starting(), currentAgent: null },
      { session: failed, currentAgent: null },
    ]);
    expect(await run.outcome).toEqual({ kind: "settled", session: failed });
  });

  it("does not read a resume's settled session as its end before it was seen starting", async () => {
    const completed = { id: "session-1", status: "completed", summary: null };
    const run = follow(never, [
      { session: completed, currentAgent: null },
      { session: completed, currentAgent: null },
      { session: starting(), currentAgent: null },
      { session: running, currentAgent: ptyAgent },
    ]);
    expect(await run.outcome).toEqual({ kind: "live", session: running });
  });

  it("never takes a live protocol agent (a phone pickup) for a terminal", async () => {
    const run = follow(never, [
      { session: running, currentAgent: { ...ptyAgent, kind: "agent-protocol" } },
      { session: running, currentAgent: ptyAgent },
    ]);
    expect(await run.outcome).toEqual({ kind: "live", session: running });
    expect(run.reads()).toBe(2);
  });

  it("gives up only after reads fail for a minute with the launch call ended", async () => {
    const unreachable = new MendRequestError(
      "unreachable",
      "cannot reach the Mend server at https://mend.test — is it running?",
    );
    const run = follow(Promise.reject(new MendRequestError("dropped", "cut")), [unreachable]);
    expect(await run.outcome).toEqual({ kind: "unreachable", message: unreachable.message });
    // Two seconds a read, sixty seconds of them.
    expect(run.reads()).toBe(31);
  });

  it("follows a session something else started", async () => {
    const run = follow(null, [
      { session: starting("booting"), currentAgent: null },
      { session: running, currentAgent: ptyAgent },
    ]);
    expect((await run.outcome).kind).toBe("live");
  });
});

describe("startingLineOf", () => {
  it("leads with the status word unless the server's words already carry one", () => {
    expect(startingLineOf(starting())).toBe("starting");
    expect(startingLineOf(starting("building the workspace image"))).toBe(
      "starting · building the workspace image",
    );
    expect(
      startingLineOf(starting("waiting · the previous session in this worktree is saving")),
    ).toBe("waiting · the previous session in this worktree is saving");
  });
});
