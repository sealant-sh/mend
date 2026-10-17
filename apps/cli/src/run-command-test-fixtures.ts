import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { serviceStartCorrelation } from "@mend/domain/workbench";
import { expect } from "vitest";

const json = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

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

/** 16 KiB of one letter per page, so a lost or reordered page shows. */
const chunkOf = (index: number) => Buffer.alloc(16 * 1024, 0x41 + (index % 26));

/** Every mode `MODES` turned on was turned off again after it. */
const expectTerminalPutBack = (terminal: string): void => {
  const enabled = terminal.indexOf("\x1b[?1049h");
  expect(enabled).toBeGreaterThanOrEqual(0);
  expect(terminal.lastIndexOf("\x1b[?1049l")).toBeGreaterThan(enabled);
  expect(terminal.lastIndexOf("\x1b[?25h")).toBeGreaterThan(enabled);
  expect(terminal.lastIndexOf("\x1b[?1000l")).toBeGreaterThan(enabled);
};

/** An answer that starts and never finishes: headers, one byte, then nothing. */
const stall = (response: ServerResponse) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.write("[");
};

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

/** The launch correlation the server stamps on the attempt a start of service-1 began. */
const stamped = (startId: string) => serviceStartCorrelation("service-1", startId);

const makeTestFixtures = () => {
  /**
   * `mend run`, `mend logs`, `mend wait`, `mend projects --json` and `mend service run --wait`,
   * spawned from source against a fake server. stdin is /dev/null on every run, and no assertion
   * times the CLI: a loaded runner may leave it unscheduled for seconds (mend#587).
   */

  const spawning = { timeout: 60_000 };

  const compileCache = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-compile-cache-"));

  const project = {
    id: "project-1",
    name: "fixture",
    originUrl: "https://github.com/acme/fixture.git",
    storePath: "/tmp/mend/fixture/repo.git",
    defaultBranch: "main",
    gitAuthMode: "mend-key",
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

  const attemptId = "9f8e7d6c-1b2a-4c3d-8e9f-0a1b2c3d4e5f";

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

  const shell = { ...command, id: "shell-9", kind: "shell", sealantSessionId: "pty-9" };

  const services = (route: string, response: ServerResponse): boolean => {
    if (route === "GET /api/services" || route === "GET /api/services?all=1") {
      json(response, [serviceView("reachable")]);
      return true;
    }
    return false;
  };
  return {
    spawning,
    compileCache,
    project,
    sessionId,
    session,
    command,
    ended,
    json,
    logPage,
    bodyOf,
    startFake,
    entrypoint,
    cliEnv,
    spawnCli,
    runCli,
    launchRoutes,
    chunkOf,
    MODES,
    python,
    onPty,
    expectTerminalPutBack,
    stuckReaderRun,
    stall,
    attemptId,
    serviceAttempt,
    serviceView,
    waitedStart,
    waitedRun,
    otherAttempt,
    shell,
    services,
  };
};

/** Create the original process fixture helpers and isolated state for one test file. */
export const runCommandTestFixtures = (): ReturnType<typeof makeTestFixtures> => makeTestFixtures();
