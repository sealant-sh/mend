import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as ServerSocket, WebSocketServer } from "ws";

import {
  type AgentShareHandle,
  retryDelayMs,
  type ShareEvent,
  startAgentShare,
} from "./agent-share.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const frame = (type: number, body: ReadonlyArray<number> = []): Buffer => {
  const message = Buffer.alloc(5 + body.length);
  message.writeUInt32BE(1 + body.length, 0);
  message[4] = type;
  Buffer.from(body).copy(message, 5);
  return message;
};

const IDENTITIES = frame(11);
const SIGN = frame(13, [1, 2, 3]);
const IDENTITIES_ANSWER = frame(12, [0, 0, 0, 0]);
const SIGN_ANSWER = frame(14, [9, 9, 9, 9, 9, 9]);

const request = (id: number, message: Buffer, context = "adopt api") =>
  JSON.stringify({ t: "req", id, context, payload: message.toString("base64") });

const fakeAgent = async (answer: (message: Buffer, socket: net.Socket) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-share-"));
  const sock = path.join(dir, "agent.sock");
  const received: Array<Buffer> = [];
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length >= 4 && pending.length >= 4 + pending.readUInt32BE(0)) {
        received.push(pending);
        answer(pending, socket);
      }
    });
    socket.on("error", () => {});
  });
  server.listen(sock);
  await new Promise((resolve) => server.once("listening", resolve));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { sock, received, connections: () => connections };
};

const answering = (byType: Record<number, Buffer>) =>
  fakeAgent((message, socket) => {
    const answer = byType[message[4] ?? -1];
    if (answer !== undefined) socket.write(answer);
  });

const bridgeServer = async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  if (address === null || typeof address === "string") throw new Error("bridge server has no port");
  const sockets: Array<ServerSocket> = [];
  const replies: Array<unknown> = [];
  const waiting = new Set<() => void>();
  const notify = () => {
    for (const wake of waiting) wake();
  };
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      replies.push(JSON.parse(data.toString()));
      notify();
    });
    notify();
  });
  const tickets: Array<string> = [];
  cleanups.push(() => {
    for (const client of wss.clients) client.terminate();
    return new Promise((resolve) => wss.close(() => resolve()));
  });
  return {
    sockets,
    replies,
    tickets,
    url: async () => {
      const ticket = `ticket-${tickets.length + 1}`;
      tickets.push(ticket);
      return new URL(`ws://127.0.0.1:${address.port}/api/keys-bridge?ticket=${ticket}`);
    },
    until: (predicate: () => boolean, withinMs = 5000): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (!predicate()) return;
          clearTimeout(timer);
          waiting.delete(check);
          resolve();
        };
        const timer = setTimeout(() => {
          waiting.delete(check);
          reject(new Error("the bridge server waited in vain"));
        }, withinMs);
        waiting.add(check);
        check();
      }),
  };
};

const misbehavingServer = async (behaviour: "never-upgrades" | "ignores-frames") => {
  const sockets = new Set<Duplex>();
  let upgrades = 0;
  const server: Server = createServer();
  server.on("upgrade", (incoming, socket) => {
    upgrades += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    if (behaviour === "never-upgrades") return;
    const accept = createHash("sha1")
      .update(`${incoming.headers["sec-websocket-key"] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise((resolve) => server.close(() => resolve()));
  });
  return {
    upgrades: () => upgrades,
    url: async () => new URL(`ws://127.0.0.1:${address.port}/api/keys-bridge`),
  };
};

const share = (options: { url: () => Promise<URL>; agentSock: string }) => {
  const handle = startAgentShare(options);
  const events: Array<ShareEvent> = [];
  handle.subscribe((event) => {
    if (event !== null) events.push(event);
  });
  cleanups.push(() => handle.close());
  return { handle, events };
};

const connected = async (handle: AgentShareHandle) => {
  expect(await handle.ready(5000)).toBe("connected");
};

const eventually = async (predicate: () => boolean, withinMs = 2000): Promise<void> => {
  const deadline = performance.now() + withinMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const timed = async (work: Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work;
  return performance.now() - started;
};

describe("retryDelayMs", () => {
  it("doubles from a second and caps at thirty", () => {
    expect([1, 2, 3, 6, 7, 20].map(retryDelayMs)).toEqual(
      [1000, 2000, 4000, 32_000, 32_000, 32_000].map((ms) => Math.min(ms, 30_000)),
    );
  });
});

describe("the agent share relays", () => {
  it("a request verbatim to the agent and its answer back under the same id, even split", async () => {
    const agent = await fakeAgent((_message, socket) => {
      socket.write(IDENTITIES_ANSWER.subarray(0, 3));
      setTimeout(() => socket.write(IDENTITIES_ANSWER.subarray(3)), 20);
    });
    const server = await bridgeServer();
    const { handle, events } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(7, IDENTITIES));
    await server.until(() => server.replies.length === 1);

    expect(agent.received).toEqual([IDENTITIES]);
    expect(server.replies).toEqual([
      { t: "res", id: 7, payload: IDENTITIES_ANSWER.toString("base64") },
    ]);
    expect(events).toEqual([
      { kind: "connected" },
      { kind: "identities-requested", context: "adopt api" },
    ]);
  });

  it("says a signature was requested, then that it was signed", async () => {
    const agent = await answering({ 13: SIGN_ANSWER });
    const server = await bridgeServer();
    const { handle, events } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(1, SIGN, "fetch acme/api"));
    await server.until(() => server.replies.length === 1);

    expect(server.replies).toEqual([{ t: "res", id: 1, payload: SIGN_ANSWER.toString("base64") }]);
    expect(events.map((event) => event.kind)).toEqual(["connected", "sign-requested", "signed"]);
    expect(events[1]).toEqual({ kind: "sign-requested", context: "fetch acme/api" });
  });

  it("answers requests one at a time, in the order they came", async () => {
    const agent = await fakeAgent((message, socket) => {
      const answer = message[4] === 13 ? SIGN_ANSWER : IDENTITIES_ANSWER;
      setTimeout(() => socket.write(answer), message[4] === 13 ? 60 : 0);
    });
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(1, SIGN));
    server.sockets[0]?.send(request(2, IDENTITIES));
    await server.until(() => server.replies.length === 2);

    expect(server.replies).toEqual([
      { t: "res", id: 1, payload: SIGN_ANSWER.toString("base64") },
      { t: "res", id: 2, payload: IDENTITIES_ANSWER.toString("base64") },
    ]);
  });
});

describe("the agent share drops", () => {
  it("every frame that is not a well-formed request, with no reply and no agent call", async () => {
    const agent = await answering({ 11: IDENTITIES_ANSWER });
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);
    const socket = server.sockets[0];
    const prefixSaysMore = Buffer.from(IDENTITIES);
    prefixSaysMore.writeUInt32BE(9, 0);

    for (const malformed of [
      "{not json",
      JSON.stringify({ t: "res", id: 1, payload: IDENTITIES.toString("base64") }),
      JSON.stringify({ t: "req", id: 1.5, payload: IDENTITIES.toString("base64") }),
      JSON.stringify({ t: "req", id: -1, payload: IDENTITIES.toString("base64") }),
      JSON.stringify({ t: "req", id: "1", payload: IDENTITIES.toString("base64") }),
      JSON.stringify({ t: "req", id: 1, payload: "AAAA!AQs=" }),
      JSON.stringify({ t: "req", id: 1, payload: "AAAAAQs" }),
      JSON.stringify({ t: "req", id: 1, payload: Buffer.from([0, 0, 0, 0]).toString("base64") }),
      request(1, prefixSaysMore),
      request(1, Buffer.concat([IDENTITIES, Buffer.from([0])])),
    ]) {
      socket?.send(malformed);
    }
    socket?.send(IDENTITIES);
    socket?.send(request(9, IDENTITIES));
    await server.until(() => server.replies.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.replies).toEqual([
      { t: "res", id: 9, payload: IDENTITIES_ANSWER.toString("base64") },
    ]);
    expect(agent.connections()).toBe(1);
  });

  it("a frame larger than any agent message, and still relays the next request", async () => {
    const agent = await answering({ 11: IDENTITIES_ANSWER });
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);
    const tooLong = frame(
      11,
      Array.from({ length: 300 * 1024 }, () => 0),
    );
    const huge = frame(
      11,
      Array.from({ length: 4 * 1024 * 1024 }, () => 0),
    );

    server.sockets[0]?.send(request(1, tooLong));
    server.sockets[0]?.send(request(2, huge));
    server.sockets[0]?.send(request(9, IDENTITIES));
    await server.until(() => server.replies.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.replies).toEqual([
      { t: "res", id: 9, payload: IDENTITIES_ANSWER.toString("base64") },
    ]);
    expect(agent.received).toEqual([IDENTITIES]);
  });
});

describe("a request the agent cannot answer", () => {
  it("gets an err reply with its id, and a signature says not signed", async () => {
    const server = await bridgeServer();
    const { handle, events } = share({
      url: server.url,
      agentSock: path.join(os.tmpdir(), "agent-share-no-such-agent.sock"),
    });
    await connected(handle);

    server.sockets[0]?.send(request(3, SIGN));
    await server.until(() => server.replies.length === 1);

    expect(server.replies).toEqual([{ t: "err", id: 3, message: expect.any(String) }]);
    expect(events.map((event) => event.kind)).toEqual([
      "connected",
      "sign-requested",
      "not-signed",
    ]);
  });

  it("is refused, not buffered, when the agent declares an answer too large", async () => {
    const agent = await fakeAgent((_message, socket) => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(1024 * 1024, 0);
      socket.write(header);
    });
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(4, IDENTITIES));
    await server.until(() => server.replies.length === 1, 2000);

    expect(server.replies).toEqual([{ t: "err", id: 4, message: expect.any(String) }]);
  });

  it("gets an err reply when the agent hangs up before answering", async () => {
    const agent = await fakeAgent((_message, socket) => socket.end());
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(5, IDENTITIES));
    await server.until(() => server.replies.length === 1, 2000);

    expect(server.replies).toEqual([{ t: "err", id: 5, message: expect.any(String) }]);
  });
});

describe("the agent share keeps relaying", () => {
  it("after a subscriber throws", async () => {
    const agent = await answering({ 11: IDENTITIES_ANSWER, 13: SIGN_ANSWER });
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    handle.subscribe((event) => {
      if (event?.kind === "sign-requested") throw new Error("a subscriber's own bug");
    });
    await connected(handle);

    server.sockets[0]?.send(request(1, SIGN));
    server.sockets[0]?.send(request(2, IDENTITIES));
    await server.until(() => server.replies.length > 0);

    expect(server.replies).toContainEqual({
      t: "res",
      id: 2,
      payload: IDENTITIES_ANSWER.toString("base64"),
    });
  });
});

describe("the agent share reconnects", () => {
  it("with a fresh url after the server drops it, and relays on the new socket", async () => {
    const agent = await answering({ 11: IDENTITIES_ANSWER });
    const server = await bridgeServer();
    const { handle, events } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.terminate();
    await server.until(() => server.sockets.length === 2);
    await connected(handle);
    server.sockets[1]?.send(request(2, IDENTITIES));
    await server.until(() => server.replies.length === 1);

    expect(server.tickets).toEqual(["ticket-1", "ticket-2"]);
    expect(events.slice(0, 3)).toEqual([
      { kind: "connected" },
      { kind: "disconnected", retryMs: 1000 },
      { kind: "connected" },
    ]);
    expect(server.replies).toEqual([
      { t: "res", id: 2, payload: IDENTITIES_ANSWER.toString("base64") },
    ]);
  });

  it("after the url provider throws instead of rejecting", async () => {
    const server = await bridgeServer();
    let asked = 0;
    const url = (): Promise<URL> => {
      asked += 1;
      if (asked === 1) throw new Error("no ticket yet");
      return server.url();
    };
    const { handle } = share({ url, agentSock: "/nowhere" });

    expect(await handle.ready(retryDelayMs(1) + 2000)).toBe("connected");
    expect(asked).toBe(2);
  });
});

describe("ready", () => {
  it("is connected against a live server", async () => {
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: "/nowhere" });
    expect(await handle.ready(5000)).toBe("connected");
    expect(handle.snapshot()).toBe("connected");
  });

  it("times out against a server that never upgrades", async () => {
    const server = await misbehavingServer("never-upgrades");
    const { handle } = share({ url: server.url, agentSock: "/nowhere" });
    expect(await handle.ready(200)).toBe("timeout");
    expect(handle.snapshot()).toBe("connecting");
  });

  it("is closed when the share closes first, and after", async () => {
    const server = await misbehavingServer("never-upgrades");
    const { handle } = share({ url: server.url, agentSock: "/nowhere" });
    const waiting = handle.ready(5000);
    await handle.close();
    expect(await waiting).toBe("closed");
    expect(await handle.ready(5000)).toBe("closed");
  });
});

describe("close", () => {
  it("resolves within its bound against a server that never answers the close handshake", async () => {
    const server = await misbehavingServer("ignores-frames");
    const { handle } = share({ url: server.url, agentSock: "/nowhere" });
    await connected(handle);

    expect(await timed(handle.close(300))).toBeLessThan(1000);
    expect(handle.snapshot()).toBe("closed");
    expect(await timed(handle.close(300))).toBeLessThan(1000);

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(1) + 300));
    expect(server.upgrades()).toBe(1);
  });

  it("resolves once the socket closed, and never reconnects", async () => {
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: "/nowhere" });
    await connected(handle);

    expect(await timed(handle.close(5000))).toBeLessThan(1000);

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(1) + 300));
    expect(server.tickets).toEqual(["ticket-1"]);
  });

  it("opens no socket when it lands while the share is still asking for a url", async () => {
    const server = await bridgeServer();
    const slowUrl = () =>
      new Promise<URL>((resolve) => setTimeout(() => resolve(server.url()), 100));
    const { handle } = share({ url: slowUrl, agentSock: "/nowhere" });

    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.tickets).toEqual(["ticket-1"]);
    expect(server.sockets).toEqual([]);
  });

  it("tells each subscriber once", async () => {
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: "/nowhere" });
    await connected(handle);
    const told: Array<ShareEvent | null> = [];
    handle.subscribe((event) => told.push(event));

    await handle.close();
    await handle.close();

    expect(told).toEqual([null]);
    expect(handle.snapshot()).toBe("closed");
  });

  it("ends the agent exchange in flight, without saying it was not signed", async () => {
    let agentSawClose = false;
    const agent = await fakeAgent((_message, socket) => {
      socket.once("close", () => {
        agentSawClose = true;
      });
    });
    const server = await bridgeServer();
    const { handle, events } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(1, SIGN));
    await eventually(() => agent.received.length === 1);
    await handle.close();

    await eventually(() => agentSawClose);
    expect(events.map((event) => event.kind)).toEqual(["connected", "sign-requested"]);
  });

  it("never sends a request queued behind a slow answer to the agent", async () => {
    const agent = await fakeAgent((message, socket) => {
      const answer = message[4] === 13 ? SIGN_ANSWER : IDENTITIES_ANSWER;
      setTimeout(() => socket.write(answer), message[4] === 13 ? 300 : 0);
    });
    const server = await bridgeServer();
    const { handle } = share({ url: server.url, agentSock: agent.sock });
    await connected(handle);

    server.sockets[0]?.send(request(1, SIGN));
    server.sockets[0]?.send(request(2, IDENTITIES));
    await eventually(() => agent.received.length === 1);
    await handle.close();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(agent.connections()).toBe(1);
  });
});
