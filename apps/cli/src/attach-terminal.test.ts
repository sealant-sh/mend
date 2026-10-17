import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `mend attach` under a real terminal: util-linux `script` gives the CLI a pty, so its line
 * discipline echoes a key typed into a cooked terminal, exactly as the owner's multiplexer pane
 * did (`fdfdf^F` under `attached · claude · …`). Linux only; `script` differs elsewhere.
 */
const hasScript =
  process.platform === "linux" &&
  spawnSync("script", ["--version"], { encoding: "utf8" }).status === 0;

const session = {
  id: "session-1234",
  projectId: "project-1",
  harness: "claude",
  label: null,
  worktree: "session-1234",
  branch: "mend/session/session-1234",
  baseSha: "abc123",
  status: "running",
  summary: null,
  createdAt: new Date(0).toISOString(),
};

const json = (response: ServerResponse, value: unknown): void => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

const acceptWebSocket = (request: IncomingMessage, socket: Duplex): void => {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") throw new Error("missing WebSocket key");
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
};

/** The client's masked data frames, decoded; these fixtures use only short frames. */
const clientFrames = (bytes: Buffer) => {
  const frames: Array<{ readonly opcode: number; readonly payload: Buffer }> = [];
  let offset = 0;
  while (offset + 6 <= bytes.length) {
    const opcode = (bytes[offset] ?? 0) & 0x0f;
    const length = (bytes[offset + 1] ?? 0) & 0x7f;
    if (length >= 126 || offset + 6 + length > bytes.length) break;
    const mask = bytes.subarray(offset + 2, offset + 6);
    const payload = Buffer.from(bytes.subarray(offset + 6, offset + 6 + length));
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
    if (opcode === 1 || opcode === 2) frames.push({ opcode, payload });
    offset += 6 + length;
  }
  return frames;
};

/** A server's binary frame (unmasked): PTY bytes as the tty socket carries them. */
const serverBinaryFrame = (payload: Buffer): Buffer => {
  if (payload.length >= 126) throw new Error("test frames stay short");
  return Buffer.concat([Buffer.from([0x82, payload.length]), payload]);
};

/** The session's detail: its agent started 23 s ago and was the first process on its executor. */
const detailOf = (startedAgo: number) => {
  const agent = {
    id: "agent-1",
    kind: "agent-pty",
    status: "running",
    exitCode: null,
    exitedAt: null,
    harness: "claude",
    sealantSessionId: "pty-1",
    sealantWorkspaceId: "ws-1",
    createdAt: new Date(Date.now() - startedAgo).toISOString(),
    firstOutputAt: null,
  };
  return { session, currentAgent: agent, processes: [agent] };
};

const project = {
  id: "project-1",
  name: "demo",
  defaultBranch: "main",
  storePath: "/var/lib/mend/store/project-1/repo.git",
  autoLand: "off",
};

/**
 * The fake Mend server. With `holdStop`, a session stop gets no answer until `releaseStops()`: what
 * the CLI does while a stop is in flight is then observable.
 */
const startFake = async (
  mode: "stall-ticket" | "open",
  options: { readonly holdStop?: boolean } = {},
) => {
  const heldStops: Array<ServerResponse> = [];
  let clientBytes = Buffer.alloc(0);
  const requests: Array<string> = [];
  const images: Array<unknown> = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    // `mend attach` lists live sessions; `mend shell` asks for the retained ones too.
    if (request.url === "/api/sessions" || request.url === "/api/sessions?retained=1") {
      json(response, [session]);
    } else if (request.url === "/api/projects") json(response, [project]);
    else if (request.url === `/api/projects/${project.id}`) {
      json(response, { project, worktrees: [], sessions: [] });
    } else if (
      request.method === "POST" &&
      request.url === `/api/projects/${project.id}/sessions`
    ) {
      json(response, session);
    } else if (request.method === "POST" && request.url === `/api/sessions/${session.id}/launch`) {
      json(response, session);
    } else if (request.method === "POST" && request.url === `/api/sessions/${session.id}/stop`) {
      if (options.holdStop === true) heldStops.push(response);
      else json(response, { ...session, status: "stopped" });
    } else if (request.method === "POST" && request.url === `/api/sessions/${session.id}/shell`) {
      json(response, { id: "shell-1" });
    } else if (request.method === "POST" && request.url === `/api/sessions/${session.id}/images`) {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        images.push(JSON.parse(body));
        json(response, { path: "/workspace/paste/image.png" });
      });
    } else if (request.url === `/api/sessions/${session.id}`) json(response, detailOf(23_000));
    else if (request.url === "/api/upgrade-tickets" && mode === "open") {
      json(response, { ticket: "ticket-1" });
    } else if (request.url === "/api/upgrade-tickets") {
      // A server busy elsewhere: the ticket never comes.
    } else response.writeHead(404).end();
  });
  const sockets = new Set<Duplex>();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    acceptWebSocket(request, socket);
    socket.on("data", (chunk: Buffer) => {
      clientBytes = Buffer.concat([clientBytes, chunk]);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    frames: () =>
      clientFrames(clientBytes)
        .filter((frame) => frame.opcode === 1)
        .map((frame) => frame.payload.toString()),
    bytes: () =>
      Buffer.concat(
        clientFrames(clientBytes)
          .filter((frame) => frame.opcode === 2)
          .map((frame) => frame.payload),
      ),
    images: () => images,
    requests: () => requests,
    /** Answer every stop held so far: the session reads as stopped. */
    releaseStops: () => {
      for (const held of heldStops.splice(0)) json(held, { ...session, status: "stopped" });
    },
    /** Send PTY bytes to every attached terminal. */
    output: (text: string) => {
      for (const socket of sockets) socket.write(serverBinaryFrame(Buffer.from(text)));
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
};

/** `mend <args>` inside a 100×30 pty (`mend attach session-` by default); `write` types into it. */
const attachInTerminal = (
  url: string,
  args = "attach session-",
  env: NodeJS.ProcessEnv = {},
  options: { readonly stderr?: "closed-pipe" } = {},
) => {
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const mend = `${process.execPath} --experimental-strip-types ${entrypoint} ${args}`;
  // A stderr whose reader is gone while the terminal itself lives: bash's `>(true)` is a pipe whose
  // reader exits at once, so the CLI's first line on stderr fails with EPIPE.
  const command =
    options.stderr === "closed-pipe"
      ? `stty rows 30 cols 100; exec bash -c 'exec ${mend} 2> >(true)'`
      : `stty rows 30 cols 100; exec ${mend}`;
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    env: { ...process.env, ...env, MEND_URL: url, MEND_TOKEN: "token", TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
  });
  return {
    child,
    exited,
    output: () => output,
    write: (text: string) => child.stdin.write(text),
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition never became true");
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
};

const FOREGROUND = "claude --name wt --project demo --foreground --no-tunnel";
const STOP = `POST /api/sessions/${session.id}/stop`;
const REFUSAL_LINE = "could not leave raw mode (setRawMode EPERM)";
/** The CLI's native `setRawMode(false)` answers `errno`; entering raw mode is left alone. */
const rawModeRefusing = (errno: string): NodeJS.ProcessEnv => ({
  NODE_OPTIONS: `--import ${fileURLToPath(new URL("./attach-terminal.inject-errno.mjs", import.meta.url))}`,
  MEND_TEST_RAW_ERRNO: errno,
});
/** SIGHUP to the attached CLI while its terminal stays live: only the raw-mode refusal decides. */
const hangUp = async (
  fake: Awaited<ReturnType<typeof startFake>>,
  cli: ReturnType<typeof attachInTerminal>,
) => {
  await waitFor(() => fake.frames().length >= 2);
  const mend = spawnSync("pgrep", ["-P", String(cli.child.pid)], { encoding: "utf8" });
  expect(mend.stdout.trim()).toMatch(/^\d+$/);
  process.kill(Number(mend.stdout.trim()), "SIGHUP");
};

describe.skipIf(!hasScript)("mend attach in a terminal", () => {
  it.each([
    ["coalesced text", "\x1b[118;5uhello", false],
    ["coalesced arrow", "\x1b[118;5u\x1b[A", false],
    ["standalone Ctrl+V", "\x1b[118;5u", true],
  ])(
    "preserves %s while an image clipboard is available",
    async (_, input, paste) => {
      const root = await mkdtemp(join(tmpdir(), "mend-coalesced-paste-"));
      const image =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
      try {
        // A real executable replaces only the platform clipboard tool, never a production module.
        await writeFile(
          join(root, "wl-paste"),
          `#!/usr/bin/env node\nif (process.argv.includes('--list-types')) process.stdout.write('image/png\\n');\nelse process.stdout.write(Buffer.from('${image}', 'base64'));\n`,
          { mode: 0o755 },
        );
        const fake = await startFake("open");
        const cli = attachInTerminal(fake.url, "attach session-", {
          PATH: `${root}:${process.env["PATH"] ?? ""}`,
          HOME: root,
          XDG_CONFIG_HOME: root,
          WAYLAND_DISPLAY: "synthetic-clipboard",
          DISPLAY: "",
        });
        try {
          await waitFor(() => fake.frames().length >= 2);
          cli.write(input);
          await waitFor(() => fake.bytes().length > 0);
          expect(fake.bytes()).toEqual(Buffer.from(paste ? "/workspace/paste/image.png" : input));
          expect(fake.images()).toEqual(paste ? [{ contentsBase64: image }] : []);
          cli.write("\x1d");
          expect(await cli.exited).toBe(0);
        } finally {
          cli.child.kill("SIGKILL");
          await fake.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("goes raw before waiting on the server: keys never echo, it says it is connecting, Ctrl+] gives the terminal back", async () => {
    const fake = await startFake("stall-ticket");
    const cli = attachInTerminal(fake.url);
    try {
      await waitFor(() => cli.output().includes("attaching to"));
      await waitFor(() => cli.output().includes("connecting to session-"));
      cli.write("fdfdf");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      // A cooked terminal echoes the keys back through the pty; a raw one does not.
      expect(cli.output()).not.toContain("fdfdf");
      cli.write("\x1d");
      expect(await cli.exited).toBe(0);
      expect(cli.output()).toContain("detached");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("sends the size twice on connect, one row short first, so a full-screen agent repaints at once", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(fake.url);
    try {
      await waitFor(() => fake.frames().length >= 2);
      expect(fake.frames().map((frame) => JSON.parse(frame))).toEqual([
        { t: "resize", cols: 100, rows: 29 },
        { t: "resize", cols: 100, rows: 30 },
      ]);
      cli.write("\x1d");
      expect(await cli.exited).toBe(0);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("says the agent is starting until its first bytes, then erases the line before them (alpha 2026-09-30)", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(fake.url);
    try {
      // Attached (the size went up) and the agent has drawn nothing: the line says so.
      await waitFor(() => fake.frames().length >= 2);
      await waitFor(() => cli.output().includes("claude is starting on the new machine · 2"));
      expect(cli.output()).toContain("Ctrl+] detaches");
      fake.output("AGENT-FIRST-SCREEN");
      await waitFor(() => cli.output().includes("AGENT-FIRST-SCREEN"));
      const output = cli.output();
      // Erased, then the agent's bytes, untouched; the line is never drawn again.
      expect(output).toContain("\r\x1b[2KAGENT-FIRST-SCREEN");
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      expect(cli.output().slice(cli.output().indexOf("AGENT-FIRST-SCREEN"))).not.toContain(
        "is starting",
      );
      cli.write("\x1d");
      expect(await cli.exited).toBe(0);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("a foreground session stops when its terminal closes, the write to the dead terminal included (verify 2026-10-10)", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(
      fake.url,
      "claude --name wt --project demo --foreground --no-tunnel",
    );
    try {
      await waitFor(() => fake.frames().length >= 2);
      // The terminal itself goes away (a closed window, `tmux kill-session`): the CLI gets SIGHUP
      // and every write to the terminal fails with EIO.
      cli.child.kill("SIGKILL");
      await waitFor(() => fake.requests().includes(`POST /api/sessions/${session.id}/stop`));
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("a foreground session stops when SIGHUP is handled before the terminal's EOF, as tmux kill-session sends them (mend#1048)", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(
      fake.url,
      "claude --name wt --project demo --foreground --no-tunnel",
    );
    try {
      await waitFor(() => fake.frames().length >= 2);
      // tmux signals the pane's process first and closes its pty after: the CLI handles SIGHUP on
      // a terminal that is already gone, before the terminal's EOF reaches stdin. Leaving raw mode
      // then fails with EIO, which must not cost the session its stop.
      const mend = spawnSync("pgrep", ["-P", String(cli.child.pid)], { encoding: "utf8" });
      expect(mend.stdout.trim()).toMatch(/^\d+$/);
      process.kill(Number(mend.stdout.trim()), "SIGHUP");
      cli.child.kill("SIGKILL");
      await waitFor(() => fake.requests().includes(`POST /api/sessions/${session.id}/stop`));
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("a foreground session stops when the gone terminal refuses with ENOTTY, as macOS does after revoke() (review of mend#1061)", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(fake.url, FOREGROUND, rawModeRefusing("ENOTTY"));
    try {
      await hangUp(fake, cli);
      await waitFor(() => fake.requests().includes(STOP));
      expect(await cli.exited).toBe(0);
      expect(cli.output()).not.toContain("could not leave raw mode");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("a refusal to leave raw mode that no gone terminal explains (EPERM) is said once the stop has its answer, never before", async () => {
    const fake = await startFake("open", { holdStop: true });
    const cli = attachInTerminal(fake.url, FOREGROUND, rawModeRefusing("EPERM"));
    try {
      await hangUp(fake, cli);
      await waitFor(() => fake.requests().includes(STOP));
      // The server holds the stop's answer, so the CLI is waiting on it: whatever it has said by now
      // it said before the stop. A line written before the stop reaches this reader within the grace.
      await new Promise<void>((resolve) => setTimeout(resolve, 300));
      expect(cli.output()).not.toContain("could not leave raw mode");
      fake.releaseStops();
      await waitFor(() => cli.output().includes(REFUSAL_LINE));
      expect(await cli.exited).toBe(0);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("a stderr whose reader is gone never costs the foreground session its stop (review 2 of mend#1061)", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(fake.url, FOREGROUND, rawModeRefusing("EPERM"), {
      stderr: "closed-pipe",
    });
    try {
      await hangUp(fake, cli);
      // The refusal's line meets EPIPE on stderr; the stop went out first, and once.
      expect(await cli.exited).toBe(0);
      expect(fake.requests().filter((request) => request === STOP)).toHaveLength(1);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("mend shell says a refusal to leave raw mode too, on its way out (review 2 of mend#1061)", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(fake.url, "shell session-", rawModeRefusing("EPERM"));
    try {
      await waitFor(() => fake.frames().length >= 2);
      cli.write("\x1d");
      expect(await cli.exited).toBe(0);
      expect(cli.output()).toContain(REFUSAL_LINE);
      expect(cli.output()).toContain("detached");
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);

  it("a reattach to an agent that already drew gets its screen and never the starting line", async () => {
    const fake = await startFake("open");
    const cli = attachInTerminal(fake.url);
    try {
      await waitFor(() => fake.frames().length >= 1);
      fake.output("REPLAYED-SCREEN");
      await waitFor(() => cli.output().includes("REPLAYED-SCREEN"));
      await new Promise<void>((resolve) => setTimeout(resolve, 1_500));
      expect(cli.output()).not.toContain("is starting");
      cli.write("\x1d");
      expect(await cli.exited).toBe(0);
    } finally {
      cli.child.kill("SIGKILL");
      await fake.close();
    }
  }, 30_000);
});
