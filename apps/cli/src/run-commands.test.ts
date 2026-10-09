import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

/**
 * `mend run`, `mend logs`, `mend wait`, `mend projects --json` and `mend service run --wait`,
 * spawned from source against a fake server. stdin is /dev/null on every run, and no assertion
 * times the CLI: a loaded runner may leave it unscheduled for seconds (mend#587).
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

/** `host` 127.0.0.2 reads as a remote server to the CLI (`serverIsLocal`), still on loopback. */
const startFake = async (handle: Handler, host = "127.0.0.1") => {
  const routes: Array<string> = [];
  const server = createServer((request, response) => {
    const route = `${request.method ?? "GET"} ${request.url ?? ""}`;
    routes.push(route);
    handle(route, request, response);
  });
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    routes,
    url: `http://${host}:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));

const cliEnv = (url: string) => ({
  ...process.env,
  NODE_COMPILE_CACHE: compileCache,
  MEND_URL: url,
  MEND_TOKEN: "",
  MEND_DETACH_KEY: "none",
});

const spawnCli = (
  url: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) =>
  spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
    env: { ...cliEnv(url), ...env },
    stdio: ["ignore", "pipe", "pipe"],
    cwd: os.tmpdir(),
  });

const runCli = async (
  url: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {},
) => {
  const child = spawnCli(url, args, env);
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

/** 16 KiB of one letter per page, so a lost or reordered page shows. */
const chunkOf = (index: number) => Buffer.alloc(16 * 1024, 0x41 + (index % 26));

/** Terminal modes a full-screen program turns on: alternate screen, hidden cursor, mouse. */
const MODES = "\x1b[?1049h\x1b[?25l\x1b[?1000h";

const python = spawnSync("python3", ["-c", "import pty"]).status === 0;

/**
 * Run the CLI on a real terminal (a pty for stdout and stderr, stdin /dev/null), send SIGINT once
 * `MODES` reached it, and return the exit code and everything the terminal received.
 */
const onPty = async (
  url: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: string; readonly terminal: string }> => {
  const driver = [
    "import base64, os, pty, signal, subprocess, sys",
    "master, slave = pty.openpty()",
    "child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, stdout=slave, stderr=slave)",
    "os.close(slave)",
    "out = b''",
    "sent = False",
    "while True:",
    "    try:",
    "        data = os.read(master, 65536)",
    "    except OSError:",
    "        break",
    "    if not data:",
    "        break",
    "    out += data",
    "    if not sent and b'\\x1b[?1049h' in out:",
    "        child.send_signal(signal.SIGINT)",
    "        sent = True",
    "code = child.wait()",
    "print(code)",
    "print(base64.b64encode(out).decode())",
  ].join("\n");
  const child = spawn(
    "python3",
    ["-c", driver, process.execPath, "--experimental-strip-types", entrypoint, ...args],
    { env: cliEnv(url), stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir() },
  );
  let printed = "";
  child.stdout.on("data", (chunk: Buffer) => {
    printed += chunk.toString();
  });
  try {
    await once(child, "close");
  } finally {
    child.kill("SIGKILL");
  }
  const [code, encoded] = printed.trim().split("\n");
  return { code: code ?? "", terminal: Buffer.from(encoded ?? "", "base64").toString() };
};

/** Every mode `MODES` turned on was turned off again after it. */
const expectTerminalPutBack = (terminal: string): void => {
  const enabled = terminal.indexOf("\x1b[?1049h");
  expect(enabled).toBeGreaterThanOrEqual(0);
  expect(terminal.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(enabled);
  expect(terminal.lastIndexOf("\x1b[?25h")).toBeGreaterThan(enabled);
  expect(terminal.lastIndexOf("\x1b[?1000l")).toBeGreaterThan(enabled);
};

/**
 * `mend run` of a command whose first page is one 4 MiB chunk, to a reader that never reads: the
 * write that carries it can never finish. `stuck` resolves once bytes of it reached the pipe, so
 * the write was issued and waits for good.
 */
const stuckReaderRun = async () => {
  const fake = await startFake(
    launchRoutes(
      () => ({ session, currentAgent: command, processes: [command] }),
      (from) =>
        from === "0"
          ? {
              ...logPage("1", "running"),
              chunks: [
                {
                  sequence: "0",
                  dataBase64: Buffer.alloc(4 * 1024 * 1024, 0x41).toString("base64"),
                },
              ],
            }
          : logPage("1", "running"),
    ),
  );
  const child = spawnCli(fake.url, ["run", "--project", project.name, "--", "generate"]);
  child.stdout.pause();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const stuck = (async () => {
    while (child.stdout.readableLength === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  return { fake, child, stuck, stderr: () => stderr };
};

describe("review of mend#610", spawning, () => {
  it("delivers every byte of 4 MiB of output to a slow reader, then exits with the code", async () => {
    const pages = 256;
    let logsDone = false;
    const secondPage = Promise.withResolvers<void>();
    const fake = await startFake(
      launchRoutes(
        () => ({ session, currentAgent: logsDone ? ended(0) : command, processes: [command] }),
        (from) => {
          const index = Number(from);
          if (index === 1) secondPage.resolve();
          if (index >= pages) {
            logsDone = true;
            return logPage(String(pages), "exited");
          }
          return {
            ...logPage(String(index + 1), index + 1 < pages ? "running" : "exited"),
            chunks: [{ sequence: from, dataBase64: chunkOf(index).toString("base64") }],
          };
        },
      ),
    );
    const child = spawnCli(fake.url, ["run", "--project", project.name, "--", "generate"]);
    // Nothing is read until the CLI has asked for its second page: the pipe is full meanwhile.
    child.stdout.pause();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const closed = once(child, "close");
    try {
      await secondPage.promise;
      // Then a slow reader, 20 ms a read: the CLI must wait for it, however long it takes. (It
      // paces the reader; nothing here measures the CLI.)
      const received: Array<Buffer> = [];
      child.stdout.on("data", (chunk: Buffer) => {
        received.push(chunk);
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 20);
      });
      child.stdout.resume();
      const [code] = await closed;
      const output = Buffer.concat(received);
      expect(output.length, stderr).toBe(pages * 16 * 1024);
      expect(
        output.equals(Buffer.concat(Array.from({ length: pages }, (_, i) => chunkOf(i)))),
      ).toBe(true);
      expect(code, stderr).toBe(0);
    } finally {
      child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("fails the run when output could not be delivered, and says the command's own code", async () => {
    let failed = false;
    const fake = await startFake((route, request, response) => {
      if (route.startsWith(`GET /api/processes/${command.id}/logs?from=1&`)) {
        failed = true;
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "record store unavailable" }));
        return;
      }
      launchRoutes(
        () => ({ session, currentAgent: failed ? ended(0) : command, processes: [command] }),
        () => logPage("1", "running", "first page\n"),
      )(route, request, response);
    });
    try {
      const result = await runCli(fake.url, ["run", "--project", project.name, "--", "make"]);
      expect(result.stdout).toBe("first page\n");
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("exited · code 0 · recorded");
      expect(result.stderr).toContain("output not delivered · record store unavailable");
    } finally {
      await fake.close();
    }
  });

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

  it("a stuck reader cannot hold a signal off: SIGINT exits 130 within the flush grace", async () => {
    const { fake, child, stuck, stderr } = await stuckReaderRun();
    try {
      await stuck;
      child.kill("SIGINT");
      const [code] = await once(child, "close");
      expect(code, stderr()).toBe(130);
      expect(stderr()).toContain("stopped watching · the command keeps running");
      expect(stderr()).toContain("output may be incomplete");
    } finally {
      child.kill("SIGKILL");
      await fake.close();
    }
  });

  it("a second signal exits at once, whatever the reader does", async () => {
    const { fake, child, stuck, stderr } = await stuckReaderRun();
    try {
      await stuck;
      child.kill("SIGINT");
      while (!stderr().includes("stopped watching")) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      child.kill("SIGTERM");
      const [code] = await once(child, "close");
      expect(code, stderr()).toBe(143);
      expect(stderr()).not.toContain("output may be incomplete");
    } finally {
      child.kill("SIGKILL");
      await fake.close();
    }
  });

  it.skipIf(!python)(
    "puts a terminal back when Ctrl+C stops watching output that set its modes",
    async () => {
      const fake = await startFake(
        launchRoutes(
          () => ({ session, currentAgent: command, processes: [command] }),
          (from) => (from === "0" ? logPage("1", "running", MODES) : logPage("1", "running")),
        ),
      );
      try {
        const { code, terminal } = await onPty(fake.url, [
          "run",
          "--project",
          project.name,
          "--",
          "top",
        ]);
        expect(code, terminal).toBe("130");
        expectTerminalPutBack(terminal);
        expect(terminal).toContain("stopped watching · the command keeps running");
      } finally {
        await fake.close();
      }
    },
  );

  it.skipIf(!python)(
    "puts a terminal back when Ctrl+C stops a plain mend logs mid-read",
    async () => {
      const fake = await startFake((route, _request, response) => {
        if (route === `GET /api/sessions/${sessionId}`) {
          json(response, { session, currentAgent: command, processes: [command] });
        } else if (route.startsWith(`GET /api/processes/${command.id}/logs?from=0&`)) {
          json(response, logPage("1", "running", MODES));
        } else if (route.startsWith(`GET /api/processes/${command.id}/logs?from=1&`)) {
          // The next page never comes: the read is in flight when Ctrl+C arrives.
          response.writeHead(200, { "content-type": "application/json" });
        } else response.writeHead(404).end();
      });
      try {
        const { code, terminal } = await onPty(fake.url, ["logs", sessionId]);
        expect(code, terminal).toBe("130");
        expectTerminalPutBack(terminal);
      } finally {
        await fake.close();
      }
    },
  );
});

/** A Service's view as the server answers a start, its port observed `state`. */
const serviceView = (state: "reachable" | "unreachable") => ({
  service: {
    id: "service-1",
    sessionId,
    name: "web",
    workspacePort: 3000,
    transport: "tcp",
    browserScheme: null,
    currentAttemptId: "attempt-1",
  },
  attempts: [
    {
      id: "attempt-1",
      argv: ["pnpm", "dev"],
      status: "running",
      exitedAt: null,
      sealantSessionId: "pty-2",
    },
  ],
  currentForward: { id: "forward-1", hostPort: 41000, state: "bound" },
  latestObservation: { forwardId: "forward-1", state },
  workspaceExpiresAt: null,
  workspaceTtlRenewedAt: null,
  workspaceTtlRenewalFailedAt: null,
  workspaceTtlRenewalError: null,
  endpoints: [],
});

describe("--json and --wait", spawning, () => {
  it("mend projects --json prints JSON, not the table", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") json(response, [project]);
      else if (route === "GET /api/sessions") json(response, [session]);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["projects", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        version: 1,
        projects: [
          {
            id: project.id,
            name: project.name,
            originUrl: project.originUrl,
            defaultBranch: "main",
            storePath: project.storePath,
            liveSessions: 1,
            current: false,
          },
        ],
      });
    } finally {
      await fake.close();
    }
  });

  it("never prints the credentials of a project's origin, in JSON or in the table", async () => {
    const leaky = {
      ...project,
      originUrl: "https://oauth2:s3cret-token@github.com/acme/fixture.git",
    };
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") json(response, [leaky]);
      else if (route === "GET /api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    try {
      const asJson = await runCli(fake.url, ["projects", "--json"]);
      expect(asJson.code, asJson.stderr).toBe(0);
      expect(asJson.stdout).not.toContain("s3cret-token");
      expect(JSON.parse(asJson.stdout).projects[0].originUrl).toBe(
        "https://github.com/acme/fixture.git",
      );
      const table = await runCli(fake.url, ["projects"]);
      expect(table.stdout + table.stderr).not.toContain("s3cret-token");
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait exits 1 when the port did not answer, and the Service stays", async () => {
    const view = serviceView("unreachable");
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `POST /api/sessions/${sessionId}/services/run`) json(response, view);
      else response.writeHead(404).end();
    });
    try {
      const args = ["service", "run", sessionId.slice(0, 8), "--port", "3000"];
      const waited = await runCli(fake.url, [...args, "--wait", "--", "pnpm", "dev"]);
      expect(waited.code).toBe(1);
      expect(waited.stderr).toContain("nothing answered on :3000 · unreachable");
      expect(fake.routes).not.toContain("POST /api/services/service-1/stop");
      const unwaited = await runCli(fake.url, [...args, "--", "pnpm", "dev"]);
      expect(unwaited.code, unwaited.stderr).toBe(0);
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait against a remote server returns once it answered, with no tunnel", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `POST /api/sessions/${sessionId}/services/run`) {
        json(response, serviceView("reachable"));
      } else response.writeHead(404).end();
    }, "127.0.0.2");
    try {
      const result = await runCli(fake.url, [
        "service",
        "run",
        sessionId.slice(0, 8),
        "--port",
        "3000",
        "--wait",
        "--",
        "pnpm",
        "dev",
      ]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain("connect: mend service connect web");
      expect(fake.routes.some((route) => route.includes("upgrade"))).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait refuses a recipe with no command, before anything starts", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `GET /api/sessions/${sessionId}/recipes`) {
        json(response, [
          {
            name: "web",
            command: null,
            port: 3000,
            protocol: "tcp",
            browserScheme: "http",
            shadowedBy: null,
          },
        ]);
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, [
        "service",
        "run",
        sessionId.slice(0, 8),
        "web",
        "--wait",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "--wait needs a command Mend starts: web declares only a port",
      );
      expect(fake.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait gives up on a start the server never answers, with 124", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `POST /api/sessions/${sessionId}/services/run`) {
        // An answer that starts and never finishes: headers, then nothing.
        response.writeHead(200, { "content-type": "application/json" });
        response.write("{");
      } else response.writeHead(404).end();
    });
    try {
      const result = await runCli(
        fake.url,
        ["service", "run", sessionId.slice(0, 8), "--port", "3000", "--wait", "--", "pnpm", "dev"],
        { MEND_SERVICE_WAIT_MS: "1000" },
      );
      expect(result.code, result.stderr).toBe(124);
      expect(result.stderr).toContain("no answer within 1 s · the Service may still be starting");
    } finally {
      await fake.close();
    }
  });
});
