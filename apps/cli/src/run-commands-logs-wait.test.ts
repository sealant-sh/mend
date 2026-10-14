import * as fs from "node:fs";

import { afterAll, describe, expect, it } from "vitest";

import { runCommandTestFixtures } from "./run-command-test-fixtures.ts";

const {
  spawning,
  compileCache,
  project,
  sessionId,
  session,
  command,
  ended,
  json,
  logPage,
  startFake,
  runCli,
  launchRoutes,
  shell,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("mend logs and mend wait", spawning, () => {
  it("mend logs prints a settled session's record, and --process reads another process", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === `GET /api/sessions/${sessionId}`) {
        json(response, {
          session: { ...session, status: "completed" },
          currentAgent: ended(0),
          processes: [ended(0), shell],
        });
      } else if (route.startsWith(`GET /api/processes/${command.id}/logs?from=0&`)) {
        json(response, logPage("1", "exited", "from the command\n"));
      } else if (route.startsWith("GET /api/processes/shell-9/logs?from=0&")) {
        json(response, { ...logPage("1", "running", "from the shell\n"), processId: "shell-9" });
      } else if (route.includes("/logs?from=1&")) {
        json(response, logPage("1", "exited"));
      } else response.writeHead(404).end();
    });
    try {
      const own = await runCli(fake.url, ["logs", sessionId]);
      expect(own.code, own.stderr).toBe(0);
      expect(own.stdout).toBe("from the command\n");
      const other = await runCli(fake.url, ["logs", sessionId, "--process", "shell"]);
      expect(other.code, other.stderr).toBe(0);
      expect(other.stdout).toBe("from the shell\n");
    } finally {
      await fake.close();
    }
  });

  it("mend wait exits with the command's code, and --json says how it ended", async () => {
    let reads = 0;
    const fake = await startFake((route, _request, response) => {
      if (route === `GET /api/sessions/${sessionId}`) {
        reads += 1;
        json(response, {
          session: { ...session, status: reads < 2 ? "running" : "idle" },
          currentAgent: reads < 2 ? command : ended(7),
        });
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["wait", sessionId, "--json"]);
      expect(result.code, result.stderr).toBe(7);
      expect(JSON.parse(result.stdout)).toMatchObject({
        sessionId,
        processId: command.id,
        status: "exited",
        exitCode: 7,
      });
      expect(result.stderr).toContain("exited · code 7");
    } finally {
      await fake.close();
    }
  });

  it("mend wait --timeout exits 124 and leaves the command running", async () => {
    const fake = await startFake((route, request, response) => {
      if (route === `GET /api/sessions/${sessionId}`) {
        json(response, { session, currentAgent: command });
      } else if (request.method !== "GET") {
        response.writeHead(500).end();
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["wait", sessionId, "--timeout", "1"]);
      expect(result.code, result.stderr).toBe(124);
      expect(result.stderr).toContain("the command keeps running");
      expect(fake.routes.every((route) => route.startsWith("GET "))).toBe(true);
    } finally {
      await fake.close();
    }
  });
});

describe("review of mend#610", spawning, () => {
  it("--detach --json reports a command already observed ended as ended, with its code", async () => {
    const fake = await startFake(
      launchRoutes(
        () => ({
          session: { ...session, status: "completed" },
          currentAgent: ended(3),
          processes: [ended(3)],
        }),
        () => logPage("0", "exited"),
      ),
    );
    try {
      const result = await runCli(fake.url, [
        "run",
        "--project",
        project.name,
        "--detach",
        "--json",
        "--",
        "false",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        processId: command.id,
        status: "exited",
        exitCode: 3,
      });
      expect(result.stderr).toContain("ended before detaching · exited · code 3");
    } finally {
      await fake.close();
    }
  });

  it("mend wait --timeout bounds retries through gateway failures, and --json reads nothing more", async () => {
    let reads = 0;
    const fake = await startFake((route, _request, response) => {
      if (route === `GET /api/sessions/${sessionId}`) {
        reads += 1;
        // The session is found and read running once; every read after fails at the gateway.
        if (reads <= 2) json(response, { session, currentAgent: command });
        else response.writeHead(502).end();
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["wait", sessionId, "--timeout", "2", "--json"]);
      expect(result.code, result.stderr).toBe(124);
      expect(JSON.parse(result.stdout)).toMatchObject({
        sessionId,
        processId: command.id,
        status: "running",
        exitCode: null,
      });
      const atExit = reads;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(atExit);
    } finally {
      await fake.close();
    }
  });

  it("mend wait does not take the previous process's end while a resume is starting", async () => {
    let reads = 0;
    const previous = ended(0);
    const next = { ...command, id: "process-2", sealantSessionId: "pty-2" };
    const fake = await startFake((route, _request, response) => {
      if (route === `GET /api/sessions/${sessionId}`) {
        reads += 1;
        json(
          response,
          reads <= 2
            ? { session: { ...session, status: "starting" }, currentAgent: previous }
            : {
                session: { ...session, status: "idle" },
                currentAgent: { ...next, status: "exited", exitCode: 5, exitedAt: "now" },
              },
        );
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["wait", sessionId]);
      expect(result.code, result.stderr).toBe(5);
      expect(reads).toBeGreaterThanOrEqual(3);
    } finally {
      await fake.close();
    }
  });
});
