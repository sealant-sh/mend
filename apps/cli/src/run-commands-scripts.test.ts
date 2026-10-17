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
  logPage,
  bodyOf,
  startFake,
  runCli,
  launchRoutes,
} = runCommandTestFixtures();

afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

describe("mend run for scripts", spawning, () => {
  it("refuses a program with leading whitespace before anything is created, and says so", async () => {
    const fake = await startFake((_route, _request, response) => response.writeHead(404).end());
    try {
      const result = await runCli(fake.url, [
        "run",
        "--project",
        project.name,
        "--",
        " make",
        "TOKEN=hunter2",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("the program starts with a space");
      expect(result.stderr).toContain("nothing was created");
      expect(result.stderr).not.toContain("hunter2");
      // Nothing created: no project read, no session, no launch.
      expect(fake.routes.filter((route) => !route.startsWith("GET /api/me/"))).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("refuses a bare interactive shell before anything is created, and points to a real shell (fresh install 2026-10-10)", async () => {
    const fake = await startFake((_route, _request, response) => response.writeHead(404).end());
    try {
      const result = await runCli(fake.url, ["run", "--project", project.name, "--", "bash"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("bash with no script or -c waits for input");
      expect(result.stderr).toContain("mend shell");
      expect(result.stderr).toContain("nothing was created");
      expect(fake.routes.filter((route) => !route.startsWith("GET /api/me/"))).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("launches a script that starts with a newline, as it was typed (Core 0.39.0-next.712)", async () => {
    const script = "\nset -e\necho hi\n";
    let launched: unknown = null;
    const routes = launchRoutes(
      () => ({ session, currentAgent: ended(0), processes: [ended(0)] }),
      () => logPage("1", "exited", "hi\r\n"),
    );
    const fake = await startFake((route, request, response) => {
      if (route !== `POST /api/sessions/${sessionId}/launch`)
        return routes(route, request, response);
      void (async () => {
        launched = JSON.parse(await bodyOf(request));
        routes(route, request, response);
      })();
    });
    try {
      const result = await runCli(fake.url, [
        "run",
        "--project",
        project.name,
        "--",
        "bash",
        "-lc",
        script,
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(launched).toEqual({ argv: ["bash", "-lc", script] });
    } finally {
      await fake.close();
    }
  });

  it("prints the command's output on stdout, its own lines on stderr, and exits with its code", async () => {
    let logsDone = false;
    const fake = await startFake(
      launchRoutes(
        () => ({ session, currentAgent: logsDone ? ended(3) : command, processes: [command] }),
        (from) => {
          if (from === "0") return logPage("2", "running", "hello\r\n", "world\r\n");
          logsDone = true;
          return logPage("2", "exited");
        },
      ),
    );
    try {
      const result = await runCli(fake.url, ["run", "--project", project.name, "--", "make"]);
      expect(result.stdout, result.stderr).toBe("hello\r\nworld\r\n");
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("exited · code 3 · recorded");
      expect(result.stderr).not.toContain("pty-out");
      // The command went to the server as it was typed.
      expect(fake.routes).toContain(`POST /api/sessions/${sessionId}/launch`);
    } finally {
      await fake.close();
    }
  });

  it("prints the output of a command that ended before the session was read running", async () => {
    const fake = await startFake(
      launchRoutes(
        () => ({
          session: { ...session, status: "completed" },
          currentAgent: ended(0),
          processes: [ended(0)],
        }),
        (from) => (from === "0" ? logPage("1", "exited", "done\n") : logPage("1", "exited")),
      ),
    );
    try {
      const result = await runCli(fake.url, ["run", "--project", project.name, "--", "true"]);
      expect(result.stdout, result.stderr).toBe("done\n");
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("before its agent ran");
    } finally {
      await fake.close();
    }
  });

  it("--detach --json returns once the command runs, the ids alone on stdout", async () => {
    const fake = await startFake(
      launchRoutes(
        () => ({ session, currentAgent: command, processes: [command] }),
        () => logPage("0", "running"),
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
        "make",
        "build",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        version: 1,
        sessionId,
        processId: command.id,
        worktree: session.worktree,
        branch: session.branch,
        url: `${fake.url}/sessions/${sessionId}`,
        status: "running",
        exitCode: null,
      });
      expect(result.stderr).toContain(`mend wait ${sessionId.slice(0, 8)}`);
      expect(fake.routes.some((route) => route.includes("/logs"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("still refuses --foreground, and --json on a harness", async () => {
    const fake = await startFake((_route, _request, response) => response.writeHead(404).end());
    try {
      const run = await runCli(fake.url, ["run", "--foreground", "--", "make"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("mend run takes no --foreground");
      const codex = await runCli(fake.url, ["codex", "--json"]);
      expect(codex.code).toBe(1);
      expect(codex.stderr).toContain("mend codex takes no --json");
      expect(fake.routes.filter((route) => !route.startsWith("GET /api/me/"))).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
