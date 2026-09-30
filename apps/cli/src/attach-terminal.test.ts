import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

/** The client's masked text frames, decoded (short frames only — control JSON). */
const clientTextFrames = (bytes: Buffer): ReadonlyArray<string> => {
  const texts: Array<string> = [];
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
    if (opcode === 1) texts.push(payload.toString());
    offset += 6 + length;
  }
  return texts;
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

const startFake = async (mode: "stall-ticket" | "open") => {
  let clientBytes = Buffer.alloc(0);
  const server = createServer((request, response) => {
    if (request.url === "/api/sessions") json(response, [session]);
    else if (request.url === `/api/sessions/${session.id}`) json(response, detailOf(23_000));
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
    frames: () => clientTextFrames(clientBytes),
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

/** `mend attach session-` inside a 100×30 pty; `write` types into it. */
const attachInTerminal = (url: string) => {
  const entrypoint = fileURLToPath(new URL("./main.ts", import.meta.url));
  const command = `stty rows 30 cols 100; exec ${process.execPath} --experimental-strip-types ${entrypoint} attach session-`;
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    env: { ...process.env, MEND_URL: url, MEND_TOKEN: "token", TERM: "xterm-256color" },
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

describe.skipIf(!hasScript)("mend attach in a terminal", () => {
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
