import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * `mend run`, `mend logs` and `mend wait`, spawned from source against a fake server. stdin is
 * /dev/null on every run, and no assertion times the CLI: a loaded runner may leave it unscheduled
 * for seconds (mend#587).
 */

const spawning = { timeout: 60_000 };

const compileCache = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-compile-cache-"));
afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

const project = {
  id: "project-1",
  name: "fixture",
  originUrl: "https://github.com/acme/fixture.git",
  storePath: "/tmp/mend/fixture/repo.git",
  defaultBranch: "main",
  gitAuthMode: "ambient",
};

const sessionId = "0c9f7e1a-6b2d-4c6e-9a51-3f2a7d1b8c40";

const session = {
  id: sessionId,
  projectId: project.id,
  harness: "run",
  label: null,
  worktree: "session-0c9f7e1a",
  branch: "mend/session/0c9f7e1a",
  baseSha: "abc123abc123abc1",
  baseRef: "main",
  status: "running",
  summary: null,
  createdAt: new Date(0).toISOString(),
};

const command = {
  id: "process-1",
  kind: "agent-pty",
  harness: "run",
  label: null,
  status: "running",
  exitCode: null,
  exitedAt: null,
  sealantSessionId: "pty-1",
};

const ended = (exitCode: number | null) => ({
  ...command,
  status: "exited",
  exitCode,
  exitedAt: new Date(1000).toISOString(),
});

const json = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const logPage = (nextFrom: string, status: string, ...texts: ReadonlyArray<string>) => ({
  processId: command.id,
  sealantSessionId: command.sealantSessionId,
  sealantRunId: null,
  requestedFrom: "0",
  firstSequence: null,
  lastSequence: null,
  nextFrom,
  status,
  chunks: texts.map((text, index) => ({
    sequence: String(index),
    dataBase64: Buffer.from(text).toString("base64"),
  })),
  telemetryLoss: "unknown",
  telemetryNote: "",
});

type Handler = (route: string, request: IncomingMessage, response: ServerResponse) => void;

const startFake = async (handle: Handler) => {
  const routes: Array<string> = [];
  const server = createServer((request, response) => {
    const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
    routes.push(route);
    handle(route, request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    routes,
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

const runCli = async (url: string, args: ReadonlyArray<string>) => {
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env: {
      ...process.env,
      NODE_COMPILE_CACHE: compileCache,
      MEND_URL: url,
      MEND_TOKEN: "",
      MEND_DETACH_KEY: "none",
    },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: os.tmpdir(),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, "exit");
  return { code: typeof code === "number" ? code : null, stdout, stderr };
};

/** A launch the fake follows: create, launch, then the session reads from `detail()`. */
const launchRoutes =
  (detail: () => unknown, logs: (from: string) => unknown): Handler =>
  (route, _request, response) => {
    if (route === "GET /api/projects") json(response, [project]);
    else if (route === `GET /api/projects/${project.id}`) {
      json(response, { project, sessions: [], annotations: [], worktrees: [] });
    } else if (route === `POST /api/projects/${project.id}/sessions`) json(response, session);
    else if (route === `POST /api/sessions/${sessionId}/launch`) json(response, session);
    else if (route === `GET /api/sessions/${sessionId}`) json(response, detail());
    else if (route.startsWith(`GET /api/processes/${command.id}/logs?from=`)) {
      const from = new URL(route.slice(4), "http://fake").searchParams.get("from") ?? "";
      json(response, logs(from));
    } else response.writeHead(404).end();
  };

describe("mend run for scripts", spawning, () => {
  it("refuses a script that starts with a newline before anything is created, and says so", async () => {
    const fake = await startFake((_route, _request, response) => response.writeHead(404).end());
    try {
      const result = await runCli(fake.url, [
        "run",
        "--project",
        project.name,
        "--",
        "bash",
        "-lc",
        "\nexport TOKEN=hunter2\necho hi",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("argument 2 starts with a newline");
      expect(result.stderr).toContain("nothing was created");
      expect(result.stderr).not.toContain("hunter2");
      // Nothing created: no project read, no session, no launch.
      expect(fake.routes.filter((route) => !route.startsWith("GET /api/me/"))).toEqual([]);
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

describe("mend logs and mend wait", spawning, () => {
  const shell = { ...command, id: "shell-9", kind: "shell", sealantSessionId: "pty-9" };

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
