import { describe, expect, it } from "vitest";

import {
  type CommandDetail,
  commandEndOf,
  endLine,
  exitStatusOf,
  followLogs,
  durationLine,
  isSessionId,
  type LogPage,
  parseDuration,
  parseLogsArgs,
  parseWaitArgs,
  pickProcess,
  pickServiceAttempt,
  runArgvIssue,
  type ServiceStartRead,
  type ServiceViewSlice,
  waitForCommand,
  waitForServiceStart,
} from "./run-scripts.ts";
import { MendRequestError } from "./server-request.ts";

/**
 * A clock that only moves when a sleep the code under test waits on runs out: no wall time in
 * these tests. A sleep runs out on the next turn of the event loop; one aborted before then never
 * moves the clock, as a cleared timer never fires.
 */
const fakeClock = () => {
  let now = 0;
  const slept: Array<number> = [];
  return {
    now: () => now,
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve) => {
        setImmediate(() => {
          if (signal?.aborted !== true) {
            slept.push(ms);
            now += ms;
          }
          resolve();
        });
      }),
    slept,
  };
};

const page = (
  nextFrom: string,
  status: LogPage["status"],
  ...texts: ReadonlyArray<string>
): LogPage => ({
  nextFrom,
  status,
  chunks: texts.map((text, index) => ({
    sequence: String(index),
    dataBase64: Buffer.from(text).toString("base64"),
  })),
});

const running = {
  id: "process-1",
  status: "running",
  exitCode: null,
  exitedAt: null,
  sealantSessionId: "pty-1",
};

const detailOf = (
  status: string,
  agent: CommandDetail["currentAgent"],
  processes?: CommandDetail["processes"],
): CommandDetail => ({
  session: { id: "session-1", status },
  currentAgent: agent,
  ...(processes === undefined ? {} : { processes }),
});

describe("runArgvIssue", () => {
  it("takes a command the platform takes", () => {
    expect(runArgvIssue(["bash", "-lc", "set -e\necho hi"])).toBeNull();
  });

  it("names a script that starts with a newline by its position, never by its text", () => {
    const issue = runArgvIssue(["bash", "-lc", "\nexport TOKEN=hunter2\necho hi"]);
    expect(issue).toBe(
      "argument 2 starts with a newline · the platform refuses arguments with leading or trailing whitespace · trim it and run again",
    );
    expect(issue).not.toContain("hunter2");
  });

  it("names trailing whitespace, an empty argument and an untrimmed program", () => {
    expect(runArgvIssue(["echo", "hi "])).toContain("argument 1 ends with a space");
    expect(runArgvIssue(["echo", "hi\t"])).toContain("argument 1 ends with a tab");
    expect(runArgvIssue(["git", "commit", "-m", ""])).toBe(
      "argument 3 is empty · the platform refuses empty arguments",
    );
    expect(runArgvIssue([" make"])).toContain("the program starts with a space");
  });

  it("refuses more than 64 words", () => {
    expect(runArgvIssue(Array.from({ length: 64 }, () => "x"))).toBeNull();
    expect(runArgvIssue(Array.from({ length: 65 }, () => "x"))).toContain("65 words");
  });
});

describe("the command's end", () => {
  it("is the command's own row once it exited, its code as reported", () => {
    const end = commandEndOf(
      detailOf("idle", { ...running, status: "exited", exitCode: 3, exitedAt: "2026-10-10" }),
    );
    expect(end).toEqual({ processId: "process-1", status: "exited", exitCode: 3 });
    expect(end === null ? null : exitStatusOf(end)).toBe(3);
    expect(end === null ? null : endLine(end)).toBe("exited · code 3");
  });

  it("is nothing while the command runs, whatever the session reads", () => {
    expect(commandEndOf(detailOf("running", running))).toBeNull();
    expect(commandEndOf(detailOf("starting", null))).toBeNull();
  });

  it("is the session's settle when no command ran", () => {
    expect(commandEndOf(detailOf("failed", null))).toEqual({
      processId: null,
      status: "failed",
      exitCode: null,
    });
  });

  it("exits 1 when no code was reported, or one no process exits with", () => {
    expect(exitStatusOf({ processId: null, status: "stopped", exitCode: null })).toBe(1);
    expect(exitStatusOf({ processId: null, status: "exited", exitCode: -1 })).toBe(1);
    expect(exitStatusOf({ processId: null, status: "exited", exitCode: 300 })).toBe(1);
    expect(exitStatusOf({ processId: null, status: "exited", exitCode: 0 })).toBe(0);
    expect(endLine({ processId: null, status: "stopped", exitCode: null })).toBe(
      "stopped · no exit code reported",
    );
  });
});

describe("followLogs", () => {
  it("writes every recorded page, follows until the process ended and the record stopped", async () => {
    const clock = fakeClock();
    const pages = new Map<string, Array<LogPage>>([
      ["0", [page("2", "running", "hel", "lo\r\n")]],
      ["2", [page("2", "running"), page("3", "exited", "bye\r\n"), page("3", "exited")]],
      ["3", [page("3", "exited"), page("3", "exited")]],
    ]);
    const asked: Array<string> = [];
    let written = "";
    const last = await followLogs({
      from: "0",
      follow: true,
      read: async (from) => {
        asked.push(from);
        const next = pages.get(from)?.shift();
        if (next === undefined) throw new Error(`no page from ${from}`);
        return next;
      },
      write: async (bytes) => {
        written += Buffer.from(bytes).toString();
      },
      ...clock,
    });
    expect(written).toBe("hello\r\nbye\r\n");
    expect(last).toEqual({ next: "3", status: "exited" });
    // Two reads in a row found nothing new after the exit.
    expect(asked).toEqual(["0", "2", "2", "3", "3"]);
  });

  it("without --follow, prints what is recorded now and returns while the process runs", async () => {
    const clock = fakeClock();
    let written = "";
    const reads = [page("1", "running", "one\n"), page("1", "running")];
    const last = await followLogs({
      from: "0",
      follow: false,
      read: async () => reads.shift() ?? page("1", "running"),
      write: async (bytes) => {
        written += Buffer.from(bytes).toString();
      },
      ...clock,
    });
    expect(written).toBe("one\n");
    expect(last).toEqual({ next: "1", status: "running" });
    expect(clock.slept).toEqual([]);
  });

  it("reads through a gateway blip, and stops at once on a refusal", async () => {
    const clock = fakeClock();
    let calls = 0;
    const last = await followLogs({
      from: "0",
      follow: false,
      read: async () => {
        calls += 1;
        if (calls === 1) throw new MendRequestError("http", "bad gateway", 502);
        return page("0", "exited");
      },
      write: async () => undefined,
      ...clock,
    });
    expect(last.status).toBe("exited");
    await expect(
      followLogs({
        from: "0",
        follow: false,
        read: async () => {
          throw new MendRequestError("http", "not found", 404);
        },
        write: async () => undefined,
        ...fakeClock(),
      }),
    ).rejects.toThrow("not found");
  });
});

describe("waitForCommand", () => {
  it("returns the end once the command's row says it exited", async () => {
    const clock = fakeClock();
    const reads = [
      detailOf("running", running),
      detailOf("idle", { ...running, status: "exited", exitCode: 0, exitedAt: "now" }),
    ];
    const outcome = await waitForCommand({
      read: async () => reads.shift() ?? detailOf("running", running),
      processId: null,
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "ended",
      end: { processId: "process-1", status: "exited", exitCode: 0 },
    });
  });

  it("gives up when the deadline passes, never sleeping past it, with the last read", async () => {
    const clock = fakeClock();
    const outcome = await waitForCommand({
      read: async () => detailOf("running", running),
      processId: null,
      deadline: 2500,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "timeout", last: detailOf("running", running) });
    expect(clock.slept).toEqual([1000, 1000, 500]);
  });

  it("bounds retries by the deadline: gateway failures past it time out, never end", async () => {
    const clock = fakeClock();
    // Five seconds of gateway failures, then a read that would say the command succeeded.
    const outcome = await waitForCommand({
      read: async () => {
        if (clock.now() < 5000) throw new MendRequestError("http", "bad gateway", 502);
        return detailOf("idle", { ...running, status: "exited", exitCode: 0, exitedAt: "now" });
      },
      processId: null,
      deadline: 1000,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "timeout", last: null });
    expect(clock.now()).toBe(1000);
  });

  it("bounds a read in flight by the deadline", async () => {
    const clock = fakeClock();
    const outcome = await waitForCommand({
      read: () => new Promise<CommandDetail>(() => undefined),
      processId: null,
      deadline: 1000,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "timeout", last: null });
    expect(clock.now()).toBe(1000);
  });

  it("does not take the previous process's end while a resume is starting", async () => {
    const clock = fakeClock();
    const previous = { ...running, status: "exited", exitCode: 0, exitedAt: "before" };
    const next = { ...running, id: "process-2", sealantSessionId: "pty-2" };
    const reads = [
      detailOf("starting", previous, [previous]),
      detailOf("running", next, [previous, next]),
      detailOf("idle", { ...next, status: "exited", exitCode: 4, exitedAt: "now" }, [previous]),
    ];
    const outcome = await waitForCommand({
      read: async () => reads.shift() ?? detailOf("running", next),
      processId: null,
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "ended",
      end: { processId: "process-2", status: "exited", exitCode: 4 },
    });
  });

  it("bound to a process, waits for that process alone", async () => {
    const clock = fakeClock();
    const previous = { ...running, status: "exited", exitCode: 0, exitedAt: "before" };
    const next = { ...running, id: "process-2", sealantSessionId: "pty-2" };
    const nextEnded = { ...next, status: "exited", exitCode: 9, exitedAt: "now" };
    const reads = [
      detailOf("idle", previous, [previous, next]),
      detailOf("idle", previous, [previous, nextEnded]),
    ];
    const outcome = await waitForCommand({
      read: async () => reads.shift() ?? detailOf("running", next),
      processId: "process-2",
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "ended",
      end: { processId: "process-2", status: "exited", exitCode: 9 },
    });
  });
});

/** One turn of the event loop. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

describe("followLogs back-pressure", () => {
  it("reads the next page only once the last page's bytes were written", async () => {
    const clock = fakeClock();
    const events: Array<string> = [];
    const pages = [page("1", "running", "a"), page("2", "exited", "b"), page("2", "exited")];
    const held: Array<() => void> = [];
    const done = followLogs({
      from: "0",
      follow: false,
      read: async (from) => {
        events.push(`read ${from}`);
        return pages.shift() ?? page("2", "exited");
      },
      write: (bytes) =>
        new Promise<void>((resolve) => {
          events.push(`write ${Buffer.from(bytes).toString()}`);
          held.push(resolve);
        }),
      ...clock,
    });
    // The first write is held: no second read until it is released.
    while (held.length === 0) await turn();
    await turn();
    expect(events).toEqual(["read 0", "write a"]);
    held.shift()?.();
    while (held.length === 0) await turn();
    await turn();
    expect(events).toEqual(["read 0", "write a", "read 1", "write b"]);
    held.shift()?.();
    expect(await done).toEqual({ next: "2", status: "exited" });
  });
});

describe("pickProcess", () => {
  const shell = { ...running, id: "shell-9", kind: "shell" };
  it("takes the session's command by default, another process by its id prefix", () => {
    const detail = detailOf("running", running, [running, shell]);
    expect(pickProcess(detail, null)).toEqual({ process: running });
    expect(pickProcess(detail, "shell")).toEqual({ process: shell });
    expect(pickProcess(detail, "nope")).toEqual({
      error: 'no process of this session matches "nope"',
    });
    expect(pickProcess(detailOf("starting", null), null)).toEqual({
      error: "this session has run nothing yet",
    });
  });
});

describe("arguments", () => {
  it("parses mend logs", () => {
    expect(parseLogsArgs(["3f2a", "-f", "--from", "12", "--process", "ab"])).toEqual({
      args: { session: "3f2a", follow: true, from: "12", process: "ab", service: null },
    });
    expect(parseLogsArgs([])).toEqual({
      args: { session: null, follow: false, from: "0", process: null, service: null },
    });
    expect(parseLogsArgs(["--service", "web", "-f"])).toEqual({
      args: { session: null, follow: true, from: "0", process: null, service: "web" },
    });
    expect(parseLogsArgs(["--service", "web", "--process", "ab"])).toEqual({
      error: "--process and --service each name one process; pass one of them",
    });
    expect(parseLogsArgs(["--from", "x"])).toEqual({
      error: "--from takes a record sequence, e.g. 0",
    });
    expect(parseLogsArgs(["a", "b"])).toEqual({ error: 'one session only; "b" is extra' });
  });

  it("parses mend wait", () => {
    expect(parseWaitArgs(["3f2a", "--timeout", "1.5", "--json", "--process", "p1"])).toEqual({
      args: { session: "3f2a", process: "p1", timeoutMs: 1500, json: true },
    });
    expect(parseWaitArgs(["--timeout", "0"])).toEqual({
      error: "--timeout takes a duration above 0: 90 or 90s, 5m, 1h",
    });
    expect(parseWaitArgs(["--timeout", "5m"])).toEqual({
      args: { session: null, process: null, timeoutMs: 300_000, json: false },
    });
    expect(parseWaitArgs(["--tail"])).toEqual({ error: "unknown flag --tail" });
  });

  it("reads a duration as mend wait and mend service run --wait take it", () => {
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1.5")).toBe(1500);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    for (const bad of ["0", "0s", "", "5x", "-1", "1m30s", "m"])
      expect(parseDuration(bad)).toBe(null);
    expect(durationLine(1000)).toBe("1 s");
    expect(durationLine(600_000)).toBe("10 min");
    expect(durationLine(90_000)).toBe("1 min 30 s");
    expect(durationLine(5_400_000)).toBe("1 h 30 min");
  });

  it("knows a full session id", () => {
    expect(isSessionId("0c9f7e1a-6b2d-4c6e-9a51-3f2a7d1b8c40")).toBe(true);
    expect(isSessionId("0c9f7e1a")).toBe(false);
  });
});

// ─── a Service's start ──────────────────────────────────────────────────────

type Attempt = ServiceViewSlice["attempts"][number];

const attemptOf = (
  id: string,
  ended: { status: string; exitCode: number | null } | null = null,
): Attempt => ({
  id,
  status: ended?.status ?? "running",
  exitCode: ended?.exitCode ?? null,
  exitedAt: ended === null ? null : "now",
  sealantSessionId: `pty-${id}`,
});

const serviceOf = (
  observed: "reachable" | "unreachable",
  attempts: ReadonlyArray<Attempt> = [attemptOf("attempt-2")],
  overrides: Partial<ServiceViewSlice["service"]> = {},
): ServiceViewSlice => ({
  service: {
    id: "service-1",
    sessionId: "session-1",
    name: "web",
    currentAttemptId: attempts.at(-1)?.id ?? null,
    ...overrides,
  },
  attempts,
  currentForward: { id: "forward-1" },
  latestObservation: { forwardId: "forward-1", state: observed },
});

const startRead = (
  service: ServiceViewSlice | null,
  sessionStatus: string | null = "idle",
): ServiceStartRead => ({
  services: service === null ? [] : [service],
  sessionStatus,
});

const target = {
  sessionId: "session-1",
  name: "web",
  attemptId: "attempt-2",
  priorAttemptId: null,
};

describe("waitForServiceStart", () => {
  it("keeps waiting while the Service builds past the server's minute, and returns once it answers", async () => {
    const clock = fakeClock();
    // 64 s of a cold build (verify stack, mend#642), then the 20 s probe sees the port.
    const outcome = await waitForServiceStart({
      read: async () => startRead(serviceOf(clock.now() < 84_000 ? "unreachable" : "reachable")),
      target,
      deadline: 600_000,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "answered", processId: "attempt-2" });
    expect(clock.now()).toBe(84_000);
  });

  it("ends with the process's status and code when it exits while starting", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          serviceOf(
            "unreachable",
            clock.now() < 6000
              ? [attemptOf("attempt-2")]
              : [attemptOf("attempt-2", { status: "exited", exitCode: 1 })],
          ),
        ),
      target,
      deadline: 600_000,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "process-ended",
      processId: "attempt-2",
      status: "exited",
      exitCode: 1,
    });
  });

  it("says the workspace ended when the session settled with the attempt, or is gone", async () => {
    const ended = serviceOf("unreachable", [
      attemptOf("attempt-2", { status: "exited", exitCode: null }),
    ]);
    const cases: ReadonlyArray<{
      readonly read: ServiceStartRead;
      readonly status: string | null;
    }> = [
      { read: startRead(ended, "stopped"), status: "stopped" },
      { read: startRead(serviceOf("unreachable"), null), status: null },
    ];
    for (const { read, status } of cases) {
      const outcome = await waitForServiceStart({
        read: async () => read,
        target,
        deadline: null,
        ...fakeClock(),
      });
      expect(outcome).toEqual({ kind: "workspace-ended", sessionStatus: status });
    }
  });

  it("does not take a retained session's settled status for the end while its attempt runs", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          serviceOf(clock.now() < 4000 ? "unreachable" : "reachable"),
          clock.now() < 2000 ? "completed" : "idle",
        ),
      target,
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "answered", processId: "attempt-2" });
  });

  it("times out while still starting, never sleeping past the deadline, with the last state", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () => startRead(serviceOf("unreachable")),
      target,
      deadline: 5000,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "timeout",
      last: { kind: "starting", processId: "attempt-2" },
    });
    expect(clock.slept).toEqual([2000, 2000, 1000]);
  });

  it("an earlier attempt's answer is not this start's: it waits for the attempt that began after", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          clock.now() < 4000
            ? serviceOf("reachable", [attemptOf("attempt-1")])
            : serviceOf("reachable", [
                attemptOf("attempt-1", { status: "stopped", exitCode: null }),
                attemptOf("attempt-2"),
              ]),
        ),
      target: { ...target, attemptId: null, priorAttemptId: "attempt-1" },
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "answered", processId: "attempt-2" });
    expect(clock.now()).toBe(4000);
  });

  it("gives up looking when a start that got no answer left no attempt within a minute", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () => startRead(serviceOf("unreachable", [attemptOf("attempt-1")])),
      target: { ...target, attemptId: null, priorAttemptId: "attempt-1" },
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({ kind: "no-attempt" });
    expect(clock.now()).toBe(60_000);
  });

  it("reads through a gateway blip, and throws a refusal at once", async () => {
    const clock = fakeClock();
    let calls = 0;
    const outcome = await waitForServiceStart({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new MendRequestError("http", "bad gateway", 502);
        return startRead(serviceOf("reachable"));
      },
      target,
      deadline: null,
      ...clock,
    });
    expect(outcome.kind).toBe("answered");
    await expect(
      waitForServiceStart({
        read: async () => {
          throw new MendRequestError("http", "forbidden", 403);
        },
        target,
        deadline: null,
        ...fakeClock(),
      }),
    ).rejects.toThrow("forbidden");
  });
});

describe("pickServiceAttempt", () => {
  it("takes a Service's current attempt by its name or a prefix of its id", () => {
    const web = serviceOf("reachable");
    expect(pickServiceAttempt([web], "web", null)).toEqual({
      service: web,
      processId: "attempt-2",
    });
    expect(pickServiceAttempt([web], "service-", null)).toEqual({
      service: web,
      processId: "attempt-2",
    });
  });

  it("reads an ended attempt: the record outlives the process", () => {
    const web = serviceOf("unreachable", [
      attemptOf("attempt-2", { status: "exited", exitCode: 1 }),
    ]);
    expect(pickServiceAttempt([web], "web", null)).toEqual({
      service: web,
      processId: "attempt-2",
    });
  });

  it("refuses a Service with no attempt yet, saying why nothing is recorded", () => {
    const adopted = serviceOf("reachable", []);
    expect(pickServiceAttempt([adopted], "web", null)).toEqual({
      error:
        "Service web has no attempt yet: Mend has run no process for it, so nothing is recorded (an adopted port has none; mend service run starts one)",
      named: true,
    });
  });

  it("refuses an attempt whose terminal has not opened", () => {
    const opening = serviceOf("unreachable", [
      { ...attemptOf("attempt-2"), sealantSessionId: null },
    ]);
    const picked = pickServiceAttempt([opening], "web", null);
    expect("error" in picked && picked.error).toContain("has not opened its terminal yet");
  });

  it("takes the running one of two Services of one name, and asks for the session otherwise", () => {
    const live = serviceOf("reachable");
    const ended = serviceOf(
      "unreachable",
      [attemptOf("attempt-9", { status: "exited", exitCode: 0 })],
      { id: "service-2", sessionId: "session-2" },
    );
    expect(pickServiceAttempt([live, ended], "web", null)).toEqual({
      service: live,
      processId: "attempt-2",
    });
    const twin = serviceOf("reachable", [attemptOf("attempt-5")], {
      id: "service-3",
      sessionId: "session-3",
    });
    expect(pickServiceAttempt([live, twin], "web", null)).toMatchObject({ named: true });
    expect(pickServiceAttempt([live, twin], "web", "session-3")).toEqual({
      service: twin,
      processId: "attempt-5",
    });
    expect(pickServiceAttempt([live], "api", null)).toMatchObject({ named: false });
  });
});
