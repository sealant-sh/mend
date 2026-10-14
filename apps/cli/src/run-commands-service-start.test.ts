import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  attemptId,
  serviceAttempt,
  serviceView,
  waitedStart,
  waitedRun,
  otherAttempt,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("mend service run --wait through a slow start", spawning, () => {
  it("keeps waiting while the Service builds past the server's minute, and exits 0 once it answers", async () => {
    // The start returns unreachable (before, --wait exited 1 here), then three reads see it still
    // building and the fourth sees the probe answer.
    const fake = await waitedStart({
      started: (ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
      listed: (reads, ours) =>
        serviceView(reads < 4 ? "unreachable" : "reachable", [
          serviceAttempt(attemptId, null, ours),
        ]),
    });
    try {
      const result = await waitedRun(fake.url, "--timeout", "2m");
      expect(result.code, result.stderr).toBe(0);
      const said = result.stdout + result.stderr;
      expect(said).toContain("web · process 9f8e7d6c runs · :3000 has not answered yet");
      expect(said).toContain("✓ Service web · reachable");
      expect(fake.routes).not.toContain("POST /api/services/service-1/stop");
      // The answer is printed from the read that saw it: no further read could undo it.
      expect(fake.routes).not.toContain("GET /api/services");
    } finally {
      await fake.close();
    }
  });

  it("from a server that stamps no start ids, waits on the attempt its start answered with", async () => {
    const fake = await waitedStart({
      started: () => serviceView("unreachable"),
      listed: (reads) => serviceView(reads < 2 ? "unreachable" : "reachable"),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("exits 2 when the process exits while starting, saying its status and code", async () => {
    const fake = await waitedStart({
      started: (ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
      listed: (reads, ours) =>
        serviceView("unreachable", [
          serviceAttempt(attemptId, reads < 2 ? null : { status: "exited", exitCode: 1 }, ours),
        ]),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain(
        "web · process 9f8e7d6c exited · code 1 · before :3000 answered · mend logs --service web",
      );
    } finally {
      await fake.close();
    }
  });

  it("an exit that settles the session exits 2 with the process's code, not 3", async () => {
    const fake = await waitedStart({
      started: (ours) => serviceView("unreachable", [serviceAttempt(attemptId, null, ours)]),
      listed: (reads, ours) =>
        serviceView("unreachable", [
          serviceAttempt(attemptId, reads < 2 ? null : { status: "exited", exitCode: 7 }, ours),
        ]),
      sessionStatus: (reads) => (reads < 2 ? "idle" : "completed"),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain("web · process 9f8e7d6c exited · code 7");
    } finally {
      await fake.close();
    }
  });

  it("exits 2 when the server saw this start's command exit, though another client started one since", async () => {
    const fake = await waitedStart({
      startStatus: 422,
      started: () => ({
        _tag: "StoreFailure",
        message:
          "The command exited (code 127) before :3000 answered.\n--- output ---\npnpm: not found",
      }),
      listed: (_reads, ours) =>
        serviceView("unreachable", [
          serviceAttempt(attemptId, { status: "exited", exitCode: 127 }, ours),
          serviceAttempt(otherAttempt),
        ]),
    });
    try {
      const result = await waitedRun(fake.url);
      expect(result.code, result.stderr).toBe(2);
      expect(result.stderr).toContain(
        "web · process 9f8e7d6c exited · code 127 · before :3000 answered",
      );
      expect(result.stderr).toContain("pnpm: not found");
    } finally {
      await fake.close();
    }
  });
});
