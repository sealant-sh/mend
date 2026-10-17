import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  sessionId,
  runCli,
  attemptId,
  serviceAttempt,
  serviceView,
  waitedStart,
  waitedRun,
  otherAttempt,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("mend service run --wait through a slow start", spawning, () => {
  it("keeps a refusal a refusal when another client's attempt ended meanwhile", async () => {
    const fake = await waitedStart({
      startStatus: 422,
      started: () => ({
        _tag: "StoreFailure",
        message: 'A live Service named "web" already exists.',
      }),
      listed: () =>
        serviceView("unreachable", [
          serviceAttempt(otherAttempt, { status: "exited", exitCode: 1 }),
        ]),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain('A live Service named "web" already exists.');
      expect(result.stderr).not.toContain("before :3000 answered");
    } finally {
      await fake.close();
    }
  });

  it("bounds the read after a refusal by the timeout", async () => {
    // The read that would tell whether this start's process ended never answers: the refusal is
    // said once the timeout passes, not when the read gives up.
    const fake = await waitedStart({
      startStatus: 422,
      started: () => ({ _tag: "StoreFailure", message: "refused" }),
      listed: () => serviceView("unreachable"),
      stallRecovery: true,
    });
    try {
      const result = await waitedRun(fake.url, "--timeout", "2s");
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("refused");
    } finally {
      await fake.close();
    }
  });

  it("exits 1 on a refusal, when no attempt began", async () => {
    const fake = await waitedStart({
      startStatus: 409,
      started: () => ({ _tag: "SessionNotLive", id: sessionId }),
      listed: () => serviceView("unreachable", []),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("pins the attempt an edge-cut start began: a restart's answer is not this start's", async () => {
    // The start's answer never arrives. The first read finds this start's attempt starting; then
    // another client restarts the Service, and its attempt answers.
    const fake = await waitedStart({
      startStatus: 0,
      started: () => null,
      listed: (reads, ours) =>
        reads < 2
          ? serviceView("unreachable", [serviceAttempt(attemptId, null, ours)])
          : serviceView("reachable", [
              serviceAttempt(attemptId, { status: "stopped", exitCode: null }, ours),
              serviceAttempt(otherAttempt),
            ]),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("web · process 9f8e7d6c stopped · no exit code reported");
    } finally {
      await fake.close();
    }
  });

  it("exits 3 when the server no longer has the session", async () => {
    const fake = await waitedStart({
      started: (ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
      listed: (_reads, ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
      sessionStatus: (reads) => (reads < 2 ? "idle" : null),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(3);
      expect(result.stderr).toContain(
        "web · session 0c9f7e1a no longer exists, and its workspace went with it · before :3000 answered",
      );
    } finally {
      await fake.close();
    }
  });

  it("exits 124 when the timeout passes while it is still starting, and leaves it running", async () => {
    const fake = await waitedStart({
      started: (ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
      listed: (_reads, ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
    });
    try {
      const result = await waitedRun(fake.url, "--timeout", "3s");
      expect(result.code, result.stderr).toBe(124);
      expect(result.stderr).toContain(
        "web · still starting after 3 s · process 9f8e7d6c runs · :3000 has not answered · the Service keeps starting · mend logs --service web --follow",
      );
      expect(fake.routes.filter((route) => route.includes("/stop"))).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("refuses a --timeout that is not a duration, and one without --wait, before anything starts", async () => {
    const fake = await waitedStart({
      started: () => serviceView("reachable"),
      listed: () => serviceView("reachable"),
    });
    try {
      const bad = await waitedRun(fake.url, "--timeout", "soon");
      expect(bad.code).toBe(1);
      expect(bad.stderr).toContain("--timeout takes a duration above 0: 90 or 90s, 5m, 1h");
      const unwaited = await runCli(fake.url, [
        "service",
        "run",
        "--port",
        "3000",
        "--timeout",
        "5m",
        "--",
        "pnpm",
        "dev",
      ]);
      expect(unwaited.code).toBe(1);
      expect(unwaited.stderr).toContain("--timeout bounds --wait");
      expect(fake.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
