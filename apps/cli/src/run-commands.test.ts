import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { serviceStartCorrelation } from "@mend/domain/workbench";
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

/** A request's body, read to its end. */
const bodyOf = async (request: IncomingMessage): Promise<string> => {
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};

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

/** An answer that starts and never finishes: headers, one byte, then nothing. */
const stall = (response: ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.write("[");
};

const attemptId = "9f8e7d6c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";

/** A Service attempt: running, or ended with `end`'s status and code; a start's id stamped on it. */
const serviceAttempt = (
  id: string,
  end: { readonly status: string; readonly exitCode: number | null } | null = null,
  launchCorrelationId: string | null = null,
) => ({
  id,
  argv: ["pnpm", "dev"],
  status: end?.status ?? "running",
  exitCode: end?.exitCode ?? null,
  exitedAt: end === null ? null : new Date(2000).toISOString(),
  sealantSessionId: `pty-${id}`,
  createdAt: new Date(1000).toISOString(),
  launchCorrelationId,
});

/** A Service's view as the server answers a start or lists it, its port observed `state`. */
const serviceView = (
  state: "reachable" | "unreachable",
  attempts: ReadonlyArray<ReturnType<typeof serviceAttempt>> = [serviceAttempt(attemptId)],
) => ({
  service: {
    id: "service-1",
    sessionId,
    name: "web",
    workspacePort: 3000,
    transport: "tcp",
    browserScheme: null,
    currentAttemptId: attempts.at(-1)?.id ?? null,
  },
  attempts,
  currentForward: { id: "forward-1", hostPort: 41000, state: "bound" },
  latestObservation: {
    forwardId: "forward-1",
    state,
    lastObservedAt: new Date(1500).toISOString(),
  },
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

  it("never prints a token that follows a literal @ in an origin's password", async () => {
    const leaky = {
      ...project,
      originUrl: "https://oauth2:p@s3cret-token@github.com/acme/fixture.git",
    };
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") json(response, [leaky]);
      else if (route === "GET /api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["projects", "--json"]);
      expect(result.stdout + result.stderr).not.toContain("s3cret-token");
      expect(JSON.parse(result.stdout).projects[0].originUrl).toBe(
        "https://github.com/acme/fixture.git",
      );
    } finally {
      await fake.close();
    }
  });

  it("keeps an ssh origin's user and takes out only its password", async () => {
    const origins = [
      "ssh://git:s3cret-token@github.com/acme/fixture.git",
      "ssh://git:p@s3cret-token@[::1]:2222/acme/fixture.git",
    ];
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/projects") {
        json(
          response,
          origins.map((originUrl, index) => ({ ...project, id: `p${index}`, originUrl })),
        );
      } else if (route === "GET /api/sessions") json(response, []);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["projects", "--json"]);
      expect(result.stdout + result.stderr).not.toContain("s3cret-token");
      expect(
        JSON.parse(result.stdout).projects.map((row: { originUrl: string }) => row.originUrl),
      ).toEqual(["ssh://git@github.com/acme/fixture.git", "ssh://git@[::1]:2222/acme/fixture.git"]);
    } finally {
      await fake.close();
    }
  });

  it("mend connect --from-stdin says the account without credentials in what the server returned", async () => {
    const fake = await startFake((route, request, response) => {
      if (route === "POST /api/me/sealant/accounts") {
        void bodyOf(request).then(() =>
          json(response, {
            id: "account-1",
            provider: "github",
            name: "github",
            kind: "token",
            status: "active",
            metadata: { login: "https://oauth2:s3cret-token@github.com/acme" },
            connectedAt: new Date(0).toISOString(),
            lastUsedAt: null,
          }),
        );
      } else response.writeHead(404).end();
    });
    try {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", entrypoint, "connect", "github", "--from-stdin"],
        { env: cliEnv(fake.url), stdio: ["pipe", "pipe", "pipe"], cwd: os.tmpdir() },
      );
      // stdin is the credential, given and closed: nothing else reads it.
      child.stdin.end("ghp_synthetic_token_for_tests\n");
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const [code] = await once(child, "close");
      expect(code, output).toBe(0);
      expect(output).toContain("https://github.com/acme");
      expect(output).not.toContain("s3cret-token");
    } finally {
      await fake.close();
    }
  });

  it("mend service run --wait counts its deadline from the first request, the session lookup", async () => {
    const lookup = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") stall(response);
      else response.writeHead(404).end();
    });
    const recipes = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === `GET /api/sessions/${sessionId}/recipes`) stall(response);
      else response.writeHead(404).end();
    });
    try {
      const env = { MEND_SERVICE_WAIT_MS: "500" };
      const explicit = await runCli(
        lookup.url,
        ["service", "run", sessionId.slice(0, 8), "--port", "3000", "--wait", "--", "pnpm", "dev"],
        env,
      );
      expect(explicit.code, explicit.stderr).toBe(124);
      expect(lookup.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
      const declared = await runCli(
        recipes.url,
        ["service", "run", sessionId.slice(0, 8), "web", "--wait"],
        env,
      );
      expect(declared.code, declared.stderr).toBe(124);
      expect(recipes.routes.filter((route) => route.startsWith("POST "))).toEqual([]);
    } finally {
      await lookup.close();
      await recipes.close();
    }
  });

  it("mend service init shows a proposal without the credentials of URLs in package scripts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-service-init-"));
    try {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "fixture",
          scripts: {
            dev: "vite --port 3000 --proxy https://oauth2:s3cret-token@github.com/acme/repo.git",
          },
        }),
      );
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", entrypoint, "service", "init"],
        { env: cliEnv("http://127.0.0.1:9"), stdio: ["ignore", "pipe", "pipe"], cwd: root },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      await once(child, "close");
      expect(output).toContain("--port 3000");
      expect(output).toContain("https://github.com/acme/repo.git");
      expect(output).not.toContain("s3cret-token");
      expect(fs.existsSync(path.join(root, "mend.toml"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("mend service run --wait against a remote server returns once it answered, with no tunnel", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/sessions?retained=1") json(response, [session]);
      else if (route === "GET /api/services?all=1") json(response, []);
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
      else if (route === "GET /api/services?all=1") json(response, []);
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
      expect(result.stderr).toContain(
        "pnpm · still starting after 1 s · :3000 has not answered · the start request has not returned · the Service keeps starting",
      );
    } finally {
      await fake.close();
    }
  });
});

/** The launch correlation the server stamps on the attempt a start of service-1 began. */
const stamped = (startId: string) => serviceStartCorrelation("service-1", startId);

/**
 * A server for a waited start. The start answers with `started(ours)`, `ours` being the correlation
 * of the start id the CLI sent (the server's minute is over and the port has not answered), or
 * with `startStatus` and that body, or not at all (`startStatus` 0: an edge cut it). Then every
 * read of the Services lists `listed(reads, ours)`, and the session reads `sessionStatus(reads)`
 * (null: the server no longer has it). `stallRecovery` holds the Services reads that follow a
 * refused start open, unanswered.
 */
const waitedStart = (options: {
  readonly started: (ours: string) => unknown;
  readonly startStatus?: number;
  readonly listed: (reads: number, ours: string) => unknown;
  readonly sessionStatus?: (reads: number) => string | null;
  readonly stallRecovery?: boolean;
}) => {
  let reads = 0;
  let ours: string | null = null;
  return startFake((route, request, response) => {
    if (route === "GET /api/sessions?retained=1") json(response, [session]);
    else if (route === "GET /api/services?all=1") {
      if (ours === null) json(response, []);
      else if (options.stallRecovery === true) stall(response);
      else {
        reads += 1;
        json(response, [options.listed(reads, ours)]);
      }
    } else if (route === `POST /api/sessions/${sessionId}/services/run`) {
      void (async () => {
        const body: unknown = JSON.parse(await bodyOf(request));
        const startId =
          typeof body === "object" && body !== null && "startId" in body
            ? String(body.startId)
            : "none";
        ours = stamped(startId);
        if (options.startStatus === undefined) json(response, options.started(ours));
        else if (options.startStatus === 0) response.destroy();
        else {
          response.writeHead(options.startStatus, { "content-type": "application/json" });
          response.end(JSON.stringify(options.started(ours)));
        }
      })();
    } else if (route === `GET /api/sessions/${sessionId}`) {
      const status = options.sessionStatus === undefined ? "idle" : options.sessionStatus(reads);
      if (status === null) response.writeHead(404).end();
      else json(response, { session: { ...session, status }, currentAgent: null, processes: [] });
    } else if (route === "GET /api/services") {
      // Nothing after the wait's own reads: a blip here must not turn an answer into a failure.
      response.writeHead(503).end();
    } else response.writeHead(404).end();
  });
};

const waitedRun = (url: string, ...flags: ReadonlyArray<string>) =>
  runCli(url, [
    "service",
    "run",
    sessionId.slice(0, 8),
    "--port",
    "3000",
    "--name",
    "web",
    "--wait",
    ...flags,
    "--",
    "pnpm",
    "dev",
  ]);

const otherAttempt = "5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

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

describe("a Service's process id", spawning, () => {
  const services = (route: string, response: ServerResponse): boolean => {
    if (route === "GET /api/services" || route === "GET /api/services?all=1") {
      json(response, [serviceView("reachable")]);
      return true;
    }
    return false;
  };

  it("mend service list prints the current attempt's process id, in JSON too", async () => {
    const fake = await startFake((route, _request, response) => {
      if (!services(route, response)) response.writeHead(404).end();
    });
    try {
      const table = await runCli(fake.url, ["service", "list"]);
      expect(table.code, table.stderr).toBe(0);
      expect(table.stdout).toContain("service service- · process 9f8e7d6c");
      const listed = await runCli(fake.url, ["service", "list", "--json"]);
      expect(listed.code, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual({
        version: 1,
        services: [
          {
            id: "service-1",
            name: "web",
            sessionId,
            processId: attemptId,
            status: "reachable",
            workspacePort: 3000,
            protocol: "tcp",
            hostPort: null,
            authority: null,
            browserUrl: null,
          },
        ],
      });
    } finally {
      await fake.close();
    }
  });

  it("mend logs --service and --process <service> read the current attempt's record", async () => {
    const fake = await startFake((route, _request, response) => {
      if (services(route, response)) return;
      if (route === `GET /api/sessions/${sessionId}`) {
        json(response, { session, currentAgent: command, processes: [command] });
      } else if (route.startsWith(`GET /api/processes/${attemptId}/logs?from=0&`)) {
        json(response, {
          ...logPage("1", "running", "listening on :3000\n"),
          processId: attemptId,
        });
      } else if (route.startsWith(`GET /api/processes/${attemptId}/logs?from=1&`)) {
        json(response, { ...logPage("1", "running"), processId: attemptId });
      } else response.writeHead(404).end();
    });
    try {
      const byName = await runCli(fake.url, ["logs", "--service", "web"]);
      expect(byName.code, byName.stderr).toBe(0);
      expect(byName.stdout).toBe("listening on :3000\n");
      const byServiceId = await runCli(fake.url, ["logs", sessionId, "--process", "service-1"]);
      expect(byServiceId.code, byServiceId.stderr).toBe(0);
      expect(byServiceId.stdout).toBe("listening on :3000\n");
    } finally {
      await fake.close();
    }
  });

  it("mend logs takes a Service by its full id before one named like that id, and refuses a name two carry", async () => {
    const fullId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const wanted = {
      ...serviceView("reachable"),
      service: { ...serviceView("reachable").service, id: fullId, name: "wanted" },
    };
    const impostorView = serviceView("reachable", [serviceAttempt(otherAttempt)]);
    const impostor = {
      ...impostorView,
      service: {
        ...impostorView.service,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name: fullId,
      },
    };
    const twinView = serviceView("reachable", [serviceAttempt(otherAttempt)]);
    const twin = { ...twinView, service: { ...twinView.service, id: "service-2" } };
    let listed: ReadonlyArray<unknown> = [impostor, wanted];
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/services?all=1") json(response, listed);
      else if (route === `GET /api/sessions/${sessionId}`) {
        json(response, { session, currentAgent: command, processes: [command] });
      } else if (route.startsWith("GET /api/processes/")) {
        const processId = route.includes(attemptId) ? attemptId : otherAttempt;
        const text = processId === attemptId ? "wanted\n" : "wrong-process\n";
        const first = route.includes("logs?from=0&");
        json(response, { ...logPage("1", "exited", ...(first ? [text] : [])), processId });
      } else response.writeHead(404).end();
    });
    try {
      const byService = await runCli(fake.url, ["logs", "--service", fullId]);
      expect(byService.code, byService.stderr).toBe(0);
      expect(byService.stdout).toBe("wanted\n");
      const byProcess = await runCli(fake.url, ["logs", sessionId, "--process", fullId]);
      expect(byProcess.code, byProcess.stderr).toBe(0);
      expect(byProcess.stdout).toBe("wanted\n");

      listed = [serviceView("reachable"), twin];
      const ambiguous = await runCli(fake.url, ["logs", "--service", "web"]);
      expect(ambiguous.code).toBe(1);
      expect(ambiguous.stderr).toContain(
        '"web" names 2 Services · name one by its id: service-1 (session 0c9f7e1a), service-2 (session 0c9f7e1a)',
      );
      expect(fake.routes.some((route) => route.includes(`/processes/${otherAttempt}/`))).toBe(
        false,
      );
    } finally {
      await fake.close();
    }
  });

  it("a reader that closes the pipe early (| head -1) ends mend quietly, exit 0, for any command", async () => {
    // Far more than a pipe holds: head takes one line and closes, and mend's next write meets
    // EPIPE.
    const many = Array.from({ length: 3000 }, (_, index) => {
      const view = serviceView("reachable");
      return {
        ...view,
        service: { ...view.service, id: `service-${index}`, name: `web-${index}` },
      };
    });
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/services") json(response, many);
      else response.writeHead(404).end();
    });
    try {
      for (const args of [
        ["service", "list"],
        ["service", "list", "--json"],
      ]) {
        const child = spawn(
          "bash",
          [
            "-c",
            'set -o pipefail; "$0" --experimental-strip-types "$1" "${@:2}" | head -1 >/dev/null',
            process.execPath,
            entrypoint,
            ...args,
          ],
          { env: cliEnv(fake.url), stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir() },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const [code] = await once(child, "close");
        expect({ args, code, stderr }).toEqual({ args, code: 0, stderr: "" });
      }
    } finally {
      await fake.close();
    }
  });

  it("mend logs --service refuses a Service with no attempt yet", async () => {
    const fake = await startFake((route, _request, response) => {
      if (route === "GET /api/services?all=1") json(response, [serviceView("reachable", [])]);
      else response.writeHead(404).end();
    });
    try {
      const result = await runCli(fake.url, ["logs", "--service", "web"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Service web has no attempt yet");
      expect(fake.routes.some((route) => route.includes("/processes/"))).toBe(false);
    } finally {
      await fake.close();
    }
  });
});
