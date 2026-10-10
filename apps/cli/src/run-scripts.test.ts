import { serviceStartCorrelation } from "@mend/domain/workbench";
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
  RUN_ARGV_MAX_WORD_BYTES,
  interactiveShellIssue,
  runArgvIssue,
  answeredAttemptId,
  findStartAttempt,
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

describe("interactiveShellIssue", () => {
  it("refuses a shell with no script or -c: nothing typed would reach it (fresh install 2026-10-10)", () => {
    for (const argv of [
      ["bash"],
      ["/bin/bash", "--login"],
      ["sh", "-l"],
      ["zsh", "-i"],
      ["fish"],
      ["bash", "-s", "arg"],
      ["bash", "--"],
    ]) {
      expect(interactiveShellIssue(argv), argv.join(" ")).toContain("Open a shell");
    }
    expect(interactiveShellIssue(["/usr/bin/zsh"])).toBe(
      `zsh with no script or -c waits for input mend run never sends · for a shell: "Open a shell" on the web, mend shell <session>, or mend run --detach and mend attach · for commands: mend run -- zsh -c '…'`,
    );
  });

  it("takes a shell given commands or a script, and every other program", () => {
    for (const argv of [
      ["bash", "-c", "echo hi"],
      ["bash", "-lc", "make test"],
      ["sh", "-ec", "true"],
      ["bash", "-ic", "true"],
      ["fish", "--command", "echo hi"],
      ["bash", "scripts/check.sh"],
      ["bash", "-x", "scripts/check.sh"],
      ["bash", "--norc", "--", "scripts/check.sh"],
      ["python3"],
      ["make", "test"],
      ["bashful"],
    ]) {
      expect(interactiveShellIssue(argv), argv.join(" ")).toBeNull();
    }
  });
});

describe("runArgvIssue", () => {
  it("takes a command the platform takes", () => {
    expect(runArgvIssue(["bash", "-lc", "set -e\necho hi"])).toBeNull();
  });

  it("takes arguments that are empty, whitespace-led or multi-line (Core 0.39.0-next.712)", () => {
    expect(runArgvIssue(["bash", "-lc", "\nexport TOKEN=hunter2\necho hi"])).toBeNull();
    expect(runArgvIssue(["echo", "hi "])).toBeNull();
    expect(runArgvIssue(["echo", "hi\t"])).toBeNull();
    expect(runArgvIssue(["git", "commit", "-m", ""])).toBeNull();
  });

  it("refuses an empty or untrimmed program", () => {
    expect(runArgvIssue([""])).toBe("the program is empty");
    expect(runArgvIssue([" make"])).toBe("the program starts with a space · trim it and run again");
    expect(runArgvIssue(["make\n"])).toBe(
      "the program ends with a newline · trim it and run again",
    );
  });

  it("names a NUL byte or a lone surrogate by position, never by the text", () => {
    const issue = runArgvIssue(["sh", "-c", "TOKEN=hunter2\u0000"]);
    expect(issue).toBe("argument 2 contains a NUL byte, which no process argument can carry");
    expect(issue).not.toContain("hunter2");
    expect(runArgvIssue(["echo", "\uD800"])).toBe(
      "argument 1 is not well-formed Unicode (a lone surrogate)",
    );
    expect(runArgvIssue(["echo", "😀"])).toBeNull();
  });

  it("refuses more than 64 words", () => {
    expect(runArgvIssue(Array.from({ length: 64 }, () => "x"))).toBeNull();
    expect(runArgvIssue(Array.from({ length: 65 }, () => "x"))).toContain("65 words");
  });

  it("refuses a word over 131,071 bytes and a command over 1 MiB", () => {
    expect(runArgvIssue(["echo", "x".repeat(RUN_ARGV_MAX_WORD_BYTES)])).toBeNull();
    expect(runArgvIssue(["echo", "x".repeat(RUN_ARGV_MAX_WORD_BYTES + 1)])).toContain(
      "argument 1 is 131072 bytes",
    );
    const nine = Array.from({ length: 9 }, () => "x".repeat(RUN_ARGV_MAX_WORD_BYTES));
    expect(runArgvIssue(["echo", ...nine])).toContain("the command is");
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

const startId = "5b3f0c1e-8d2a-4f6b-9c7e-1a2b3c4d5e6f";
const correlation = serviceStartCorrelation("service-1", startId);

/** An attempt begun at `began` (ms), running, or ended with `end`'s status and code. */
const attemptOf = (
  id: string,
  options: {
    readonly end?: { readonly status: string; readonly exitCode: number | null };
    readonly began?: number;
    readonly correlation?: string | null;
  } = {},
): Attempt => ({
  id,
  status: options.end?.status ?? "running",
  exitCode: options.end?.exitCode ?? null,
  exitedAt: options.end === undefined ? null : new Date(9000).toISOString(),
  sealantSessionId: `pty-${id}`,
  createdAt: new Date(options.began ?? 1000).toISOString(),
  launchCorrelationId: options.correlation ?? null,
});

/** The Service web, its last attempt current, its port last observed `observed` at `at` (ms). */
const serviceOf = (
  observed: "reachable" | "unreachable",
  attempts: ReadonlyArray<Attempt> = [attemptOf("attempt-a", { correlation })],
  overrides: Partial<ServiceViewSlice["service"]> & { readonly observedAt?: number } = {},
): ServiceViewSlice => {
  const { observedAt, ...service } = overrides;
  return {
    service: {
      id: "service-1",
      sessionId: "session-1",
      name: "web",
      currentAttemptId: attempts.at(-1)?.id ?? null,
      ...service,
    },
    attempts,
    currentForward: { id: "forward-1" },
    latestObservation: {
      forwardId: "forward-1",
      state: observed,
      lastObservedAt: new Date(observedAt ?? 2000).toISOString(),
    },
  };
};

const startRead = (
  service: ServiceViewSlice | null,
  sessionStatus: string | null = "idle",
): ServiceStartRead => ({ services: service === null ? [] : [service], sessionStatus });

const pinned = { attemptId: "attempt-a", sessionId: "session-1", startId };
/** A start an edge cut: the attempt is found by the start's id alone. */
const unpinned = { attemptId: null, sessionId: "session-1", startId };

describe("waitForServiceStart", () => {
  it("keeps waiting while the Service builds past the server's minute, and returns once it answers", async () => {
    const clock = fakeClock();
    // 64 s of a cold build (verify stack, mend#642), then the 20 s probe sees the port.
    const outcome = await waitForServiceStart({
      read: async () => startRead(serviceOf(clock.now() < 84_000 ? "unreachable" : "reachable")),
      target: pinned,
      deadline: 600_000,
      ...clock,
    });
    expect(outcome).toMatchObject({ kind: "answered", processId: "attempt-a" });
    expect(clock.now()).toBe(84_000);
  });

  it("ends with the process's status and code when it exits while starting", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          serviceOf("unreachable", [
            clock.now() < 6000
              ? attemptOf("attempt-a", { correlation })
              : attemptOf("attempt-a", { correlation, end: { status: "exited", exitCode: 1 } }),
          ]),
        ),
      target: pinned,
      deadline: 600_000,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "process-ended",
      processId: "attempt-a",
      status: "exited",
      exitCode: 1,
    });
  });

  it("pins the attempt an edge-cut start began: A failing is the end, not B answering after a restart", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          clock.now() < 2000
            ? serviceOf("unreachable", [attemptOf("attempt-a", { correlation })])
            : // Another client restarted the Service: A stopped, B (no id of ours) answers.
              serviceOf(
                "reachable",
                [
                  attemptOf("attempt-a", {
                    correlation,
                    end: { status: "stopped", exitCode: null },
                  }),
                  attemptOf("attempt-b", { began: 3000 }),
                ],
                { observedAt: 4000 },
              ),
        ),
      target: unpinned,
      deadline: null,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "process-ended",
      processId: "attempt-a",
      status: "stopped",
      exitCode: null,
    });
  });

  it("reads a stop that cleared the current attempt as the pinned attempt's end, never as no attempt", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          clock.now() < 2000
            ? serviceOf("unreachable")
            : serviceOf(
                "unreachable",
                [
                  attemptOf("attempt-a", {
                    correlation,
                    end: { status: "stopped", exitCode: null },
                  }),
                ],
                { currentAttemptId: null },
              ),
        ),
      target: unpinned,
      deadline: null,
      ...clock,
    });
    expect(outcome).toMatchObject({ kind: "process-ended", status: "stopped" });
  });

  it("does not take the predecessor's reachable observation for this attempt's answer", async () => {
    const clock = fakeClock();
    // A restart keeps the forward and its last observation, made before A began at 5 s.
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          serviceOf("reachable", [attemptOf("attempt-a", { correlation, began: 5000 })], {
            observedAt: clock.now() < 6000 ? 1000 : 7000,
          }),
        ),
      target: pinned,
      deadline: null,
      ...clock,
    });
    expect(outcome).toMatchObject({ kind: "answered", processId: "attempt-a" });
    expect(clock.now()).toBe(6000);
  });

  it("an exit that settles the session is the process's end, with its code, not the workspace's", async () => {
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          serviceOf("unreachable", [
            attemptOf("attempt-a", { correlation, end: { status: "exited", exitCode: 7 } }),
          ]),
          "completed",
        ),
      target: pinned,
      deadline: null,
      ...fakeClock(),
    });
    expect(outcome).toEqual({
      kind: "process-ended",
      processId: "attempt-a",
      status: "exited",
      exitCode: 7,
    });
  });

  it("says the workspace ended when the server no longer has the session", async () => {
    const outcome = await waitForServiceStart({
      read: async () => startRead(serviceOf("unreachable"), null),
      target: pinned,
      deadline: null,
      ...fakeClock(),
    });
    expect(outcome).toEqual({ kind: "workspace-ended", sessionStatus: null });
  });

  it("does not take a retained session's settled status for the end while its attempt runs", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () =>
        startRead(
          serviceOf(clock.now() < 4000 ? "unreachable" : "reachable"),
          clock.now() < 2000 ? "completed" : "idle",
        ),
      target: pinned,
      deadline: null,
      ...clock,
    });
    expect(outcome).toMatchObject({ kind: "answered", processId: "attempt-a" });
  });

  it("times out while still starting, never sleeping past the deadline, with the last state", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      read: async () => startRead(serviceOf("unreachable")),
      target: pinned,
      deadline: 5000,
      ...clock,
    });
    expect(outcome).toEqual({
      kind: "timeout",
      last: { kind: "starting", processId: "attempt-a" },
    });
    expect(clock.slept).toEqual([2000, 2000, 1000]);
  });

  it("never takes an attempt without the start's id, however current, and gives up after a minute", async () => {
    const clock = fakeClock();
    const outcome = await waitForServiceStart({
      // Another client's attempt, current and answering.
      read: async () => startRead(serviceOf("reachable", [attemptOf("attempt-b")])),
      target: unpinned,
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
      target: pinned,
      deadline: null,
      ...clock,
    });
    expect(outcome.kind).toBe("answered");
    await expect(
      waitForServiceStart({
        read: async () => {
          throw new MendRequestError("http", "forbidden", 403);
        },
        target: pinned,
        deadline: null,
        ...fakeClock(),
      }),
    ).rejects.toThrow("forbidden");
  });
});

describe("the attempt a start answered with", () => {
  it("is the one carrying the start's id", () => {
    const view = serviceOf("unreachable", [
      attemptOf("attempt-a", { correlation }),
      attemptOf("attempt-b", { correlation: "service-start:other" }),
    ]);
    expect(answeredAttemptId(view, startId)).toBe("attempt-a");
  });

  it("from a server that stamps no start ids, is the current attempt that answer read", () => {
    const view = serviceOf("unreachable", [attemptOf("attempt-z")]);
    expect(answeredAttemptId(view, startId)).toBe("attempt-z");
  });

  it("is unknown when the server stamps ids and none is this start's", () => {
    const view = serviceOf("unreachable", [
      attemptOf("attempt-b", { correlation: "service-start:other" }),
    ]);
    expect(answeredAttemptId(view, startId)).toBe(null);
    expect(findStartAttempt([view], unpinned)).toBe(undefined);
  });

  it("is never one stamped with the same id for another Service, or one in another session", () => {
    // This Service's attempt carries the id keyed by another Service: not this start's.
    const keyedElsewhere = serviceOf("reachable", [
      attemptOf("attempt-x", { correlation: serviceStartCorrelation("service-9", startId) }),
    ]);
    // Another session's Service, stamped with this very id under its own key.
    const otherSession = serviceOf(
      "reachable",
      [attemptOf("attempt-y", { correlation: serviceStartCorrelation("service-2", startId) })],
      { id: "service-2", sessionId: "session-2" },
    );
    expect(answeredAttemptId(keyedElsewhere, startId)).toBe(null);
    expect(findStartAttempt([keyedElsewhere, otherSession], unpinned)).toBe(undefined);
  });
});

describe("pickServiceAttempt", () => {
  it("takes a Service's current attempt by its name or a prefix of its id", () => {
    const web = serviceOf("reachable");
    expect(pickServiceAttempt([web], "web", null)).toEqual({
      service: web,
      processId: "attempt-a",
    });
    expect(pickServiceAttempt([web], "service-", null)).toEqual({
      service: web,
      processId: "attempt-a",
    });
  });

  it("takes a Service by its full id before one named like that id", () => {
    const fullId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const wanted = serviceOf("reachable", [attemptOf("attempt-a")], { id: fullId, name: "wanted" });
    const impostor = serviceOf("reachable", [attemptOf("attempt-b")], {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: fullId,
    });
    for (const session of [null, "session-1"]) {
      expect(pickServiceAttempt([impostor, wanted], fullId, session)).toEqual({
        service: wanted,
        processId: "attempt-a",
      });
    }
  });

  it("reads an ended attempt: the record outlives the process", () => {
    const web = serviceOf("unreachable", [
      attemptOf("attempt-a", { end: { status: "exited", exitCode: 1 } }),
    ]);
    expect(pickServiceAttempt([web], "web", null)).toEqual({
      service: web,
      processId: "attempt-a",
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
      { ...attemptOf("attempt-a"), sealantSessionId: null },
    ]);
    const picked = pickServiceAttempt([opening], "web", null);
    expect("error" in picked && picked.error).toContain("has not opened its terminal yet");
  });

  it("refuses a name two Services carry, listing each by its full id; a session scopes it", () => {
    const live = serviceOf("reachable");
    const other = serviceOf("reachable", [attemptOf("attempt-c")], {
      id: "service-2",
      sessionId: "session-2",
    });
    expect(pickServiceAttempt([live, other], "web", null)).toEqual({
      error:
        '"web" names 2 Services · name one by its id: service-1 (session session-), service-2 (session session-)',
      named: true,
    });
    expect(pickServiceAttempt([live, other], "web", "session-2")).toEqual({
      service: other,
      processId: "attempt-c",
    });
    expect(pickServiceAttempt([live], "api", null)).toMatchObject({ named: false });
  });
});
