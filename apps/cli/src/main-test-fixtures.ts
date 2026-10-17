import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, expect } from "vitest";

export type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;

const json = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const websocketTextFrame = (text: string): Buffer => {
  const payload = Buffer.from(text);
  if (payload.length >= 126) throw new Error("test frame must use the short WebSocket encoding");
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
};

const acceptWebSocket = (request: IncomingMessage, socket: Duplex): void => {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") throw new Error("missing WebSocket key");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n",
  );
};

/**
 * What the fake terminal does when a client attaches: `end` sends the end
 * control frame (the session settled); `drop` severs the transport without
 * one (a server restart, a network cut); `hold` keeps the socket open silent
 * (a live session — signals decide the exit).
 */
const startFakeMend = async (
  handleHttp: HttpHandler,
  behavior: "end" | "drop" | "hold" = "end",
  mintTickets = true,
) => {
  let notifyEndFrame: (() => void) | undefined;
  const endFrameSent = new Promise<void>((resolve) => {
    notifyEndFrame = resolve;
  });
  let notifyUpgraded: (() => void) | undefined;
  const upgraded = new Promise<void>((resolve) => {
    notifyUpgraded = resolve;
  });
  const upgradeUrls: Array<string> = [];
  const upgradedSockets = new Set<Duplex>();
  const server = createServer((request, response) => {
    if (mintTickets && request.method === "POST" && request.url === "/api/upgrade-tickets") {
      json(response, { ticket: "fixture-upgrade-ticket" });
    } else handleHttp(request, response);
  });
  server.on("upgrade", (request, socket) => {
    upgradeUrls.push(request.url ?? "");
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    // A CLI killed before it read the 101 answers with a reset, not a FIN (unread bytes at death
    // turn the kernel's close into RST). http detached its error listener on upgrade (mend#1069).
    socket.on("error", () => {});
    acceptWebSocket(request, socket);
    notifyUpgraded?.();
    if (behavior === "end") {
      socket.write(websocketTextFrame(JSON.stringify({ t: "end" })));
      notifyEndFrame?.();
      // Deliberately keep the transport open. Session lifecycle ended already;
      // transport teardown must not remain on the user's exit path.
    } else if (behavior === "drop") {
      setTimeout(() => socket.destroy(), 50);
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");

  return {
    endFrameSent,
    upgraded,
    upgradeCount: () => upgradeUrls.length,
    upgradeUrls: () => [...upgradeUrls],
    /** The session each upgrade asked for, in order. */
    upgradedSessions: () =>
      upgradeUrls.map((url) => new URL(url, "http://fake").searchParams.get("session")),
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of upgradedSockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
};

/** Poll until the fake observed something — CI cold starts must not count against a race. */
const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
};

/**
 * The CLI exits 0 once it has what it waits for. The fake holds the transport open and never
 * answers a close handshake, so a CLI that waits on anything after the end frame (the close, a
 * settle read) never exits; the bound only turns that hang into a failure that says so. It is
 * not a stopwatch: this clock also counts the time a loaded runner leaves the child unscheduled,
 * and 750 ms of that failed CI (actions run 37981053820).
 */
const expectExit = async (
  exited: Promise<{ readonly kind: "exit"; readonly code: number | null }>,
  output: () => string,
) => {
  const outcome = await Promise.race([
    exited,
    new Promise<{ readonly kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), 10_000),
    ),
  ]);
  expect(outcome, output()).toEqual({ kind: "exit", code: 0 });
};

/** Git in a test repository, as a fixed test identity. */
const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Mend Test",
      "-c",
      "user.email=test@mend.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

/** Each test file owns its subprocesses, compile cache, and cleanup hooks. */
export const mainTestFixtures = () => {
  // Every test here spawns the CLI from source; on a loaded CI runner one start has taken 4 s, so
  // vitest's 5 s default left no headroom.
  const spawning = { timeout: 30_000 };

  // Each spawn strips and compiles some 500 modules. One compile cache for the file lets every
  // spawn after the first reuse that work (about half of each start's CPU).
  const compileCache = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-compile-cache-"));
  afterAll(() => fs.rmSync(compileCache, { recursive: true, force: true }));

  const cliChildren = new Set<ChildProcess>();
  afterEach(async () => {
    await Promise.all(
      [...cliChildren].map(async (child) => {
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
      }),
    );
  });

  const project = {
    id: "project-1",
    name: "fixture",
    originUrl: null,
    storePath: "/tmp/mend/fixture/repo.git",
    defaultBranch: "main",
  };

  const session = {
    id: "session-1234",
    projectId: project.id,
    harness: "codex",
    label: null,
    worktree: "session-1234",
    branch: "mend/session/session-1234",
    baseSha: "abc123",
    status: "running",
    summary: null,
    createdAt: new Date(0).toISOString(),
  };

  const startCli = (
    url: string,
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string>> = {},
    cwd?: string,
  ) => {
    const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-cli-process-"));
    // Only process-launch settings cross into the child. Credentials, provider homes,
    // Git environment overrides and Node injection settings come from explicit fixtures.
    const launchEnvironment = Object.fromEntries(
      [
        "PATH",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
        "TMPDIR",
        "TMP",
        "TEMP",
        "LANG",
        "LC_ALL",
      ].flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    );
    const child = spawn(process.execPath, ["--experimental-strip-types", entrypoint, ...args], {
      env: {
        ...launchEnvironment,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        CODEX_HOME: path.join(home, "codex"),
        CLAUDE_CONFIG_DIR: path.join(home, "claude"),
        NODE_COMPILE_CACHE: compileCache,
        MEND_URL: url,
        MEND_DETACH_KEY: "none",
        ...env,
      },
      // stdin is /dev/null on every run, whatever terminal vitest itself has, so the CLI never
      // sees a terminal here and an attach always says so once on stderr.
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd === undefined ? {} : { cwd }),
    });
    cliChildren.add(child);
    child.once("close", () => {
      cliChildren.delete(child);
      fs.rmSync(home, { recursive: true, force: true });
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<{ readonly kind: "exit"; readonly code: number | null }>(
      (resolve) => {
        child.once("exit", (code) => resolve({ kind: "exit", code }));
      },
    );
    return { child, exited, stdout: () => stdout, stderr: () => stderr };
  };

  return { spawning, project, session, json, startFakeMend, startCli, waitFor, expectExit, git };
};
