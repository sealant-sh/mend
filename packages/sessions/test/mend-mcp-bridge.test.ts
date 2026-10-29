import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MEND_MCP_AGENT_PROCESS_HEADER,
  MEND_MCP_CALL_KEY_HEADER,
  MEND_MCP_PATH,
} from "../src/mend-mcp/caller.ts";
import { SESSION_HELPER_SCRIPT } from "../src/session-socket.ts";
import { startMendMcp } from "./mend-mcp-process.ts";

const TOKEN = "t".repeat(43);
const SESSION = "sess-bridge-1";

let dir: string;
let helper: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-mcp-bridge-"));
  helper = path.join(dir, "mend");
  fs.writeFileSync(helper, SESSION_HELPER_SCRIPT, { mode: 0o755 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly message: { readonly id?: unknown; readonly method?: string } | null;
}

type Reply = (seen: Seen, response: http.ServerResponse) => void;

const json = (response: http.ServerResponse, status: number, body: unknown, headers = {}) => {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
};

const channel = async (reply: Reply, port = 0) => {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        message: text === "" ? null : JSON.parse(text),
      };
      seen.push(entry);
      reply(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const bound = server.address();
  const listening = typeof bound === "object" && bound !== null ? bound.port : 0;
  return {
    seen,
    port: listening,
    url: `http://127.0.0.1:${listening}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
};

const startBridge = (endpoint: string, env: Record<string, string> = {}) =>
  startMendMcp(helper, {
    MEND_SESSION_ENDPOINT: endpoint,
    MEND_SESSION_ID: SESSION,
    MEND_SESSION_TOKEN: TOKEN,
    ...env,
  });

const bridge = async (
  endpoint: string,
  messages: ReadonlyArray<unknown>,
  env: Record<string, string> = {},
) => {
  const running = startBridge(endpoint, env);
  for (const message of messages) running.send(message);
  return running.end();
};

const initialize = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "claude-code", version: "2" },
  },
};
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const render = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "html_render", arguments: { html: "<p>hi</p>", title: "Hi", height: 120 } },
};

const mcpServer = (options: { sessions: Set<string>; eventStream?: "ended" | "held" }): Reply => {
  let issued = 0;
  return (seen, response) => {
    if (seen.method === "DELETE") {
      response.writeHead(204);
      response.end();
      return;
    }
    const message = seen.message;
    if (message?.method === "initialize") {
      const id = `mcp-${++issued}`;
      options.sessions.add(id);
      json(
        response,
        200,
        { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
        { "mcp-session-id": id },
      );
      return;
    }
    const session = seen.headers["mcp-session-id"];
    if (typeof session !== "string" || !options.sessions.has(session)) {
      response.writeHead(404);
      response.end();
      return;
    }
    if (message?.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = { jsonrpc: "2.0", id: message.id, result: { answered: message.method } };
    if (options.eventStream !== undefined) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
      );
      const event = `event: message\ndata: ${JSON.stringify(result)}\n\n`;
      if (options.eventStream === "held") response.write(event);
      else response.end(event);
      return;
    }
    json(response, 200, result);
  };
};

const mcpPosts = (seen: ReadonlyArray<Seen>) => seen.filter((entry) => entry.method === "POST");

const cancelled = (requestId: number) => ({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId, reason: "the user stopped the turn" },
});

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("mend mcp", () => {
  it("relays each message to the session's MCP route as the session, and writes only the answers", async () => {
    const sessions = new Set<string>();
    const fake = await channel(mcpServer({ sessions }));
    try {
      const run = await bridge(fake.url, [initialize, initialized, list, render]);
      expect(run.code).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", id: 1, result: { answered: "tools/list" } },
        { jsonrpc: "2.0", id: 2, result: { answered: "tools/call" } },
      ]);
      const posts = mcpPosts(fake.seen);
      expect(posts.map((entry) => [entry.url, entry.message?.method])).toEqual([
        [MEND_MCP_PATH, "initialize"],
        [MEND_MCP_PATH, "notifications/initialized"],
        [MEND_MCP_PATH, "tools/list"],
        [MEND_MCP_PATH, "tools/call"],
      ]);
      for (const entry of posts) {
        expect(entry.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
        expect(entry.headers["x-mend-session-id"]).toBe(SESSION);
        expect(entry.headers["accept"]).toBe("application/json, text/event-stream");
      }
      const [opening, ...later] = posts;
      expect(opening?.headers["mcp-session-id"]).toBeUndefined();
      for (const entry of later) {
        expect(entry.headers["mcp-session-id"]).toBe("mcp-1");
        expect(entry.headers["mcp-protocol-version"]).toBe("2025-06-18");
      }
      expect(posts.map((entry) => typeof entry.headers[MEND_MCP_CALL_KEY_HEADER])).toEqual([
        "undefined",
        "undefined",
        "undefined",
        "string",
      ]);
      expect(fake.seen.at(-1)).toMatchObject({
        method: "DELETE",
        headers: { "mcp-session-id": "mcp-1" },
      });
    } finally {
      await fake.close();
    }
  });

  it("names its agent process on every request when the harness says which it is, and names none otherwise", async () => {
    const process = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
    const cases = [
      [{ MEND_AGENT_PROCESS_ID: process }, process],
      [{}, undefined],
    ] as const;
    for (const [env, named] of cases) {
      const fake = await channel(mcpServer({ sessions: new Set() }));
      try {
        const run = await bridge(fake.url, [initialize, initialized, list, render], env);
        expect(run.stdout).toHaveLength(3);
        expect(fake.seen.map((entry) => entry.method)).toEqual([
          "POST",
          "POST",
          "POST",
          "POST",
          "DELETE",
        ]);
        expect(fake.seen.map((entry) => entry.headers[MEND_MCP_AGENT_PROCESS_HEADER])).toEqual(
          Array(5).fill(named),
        );
      } finally {
        await fake.close();
      }
    }
  });

  it("writes every message of an event-stream answer", async () => {
    const fake = await channel(mcpServer({ sessions: new Set(), eventStream: "ended" }));
    try {
      const run = await bridge(fake.url, [initialize, initialized, render]);
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        { jsonrpc: "2.0", id: 2, result: { answered: "tools/call" } },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("writes an event-stream answer as it arrives, while the stream stays open", async () => {
    const fake = await channel(mcpServer({ sessions: new Set(), eventStream: "held" }));
    try {
      const running = startBridge(fake.url);
      running.send(initialize);
      running.send(initialized);
      running.send(render);
      await running.read(3);
      const run = await running.end();
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
        { jsonrpc: "2.0", id: 2, result: { answered: "tools/call" } },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("starts the MCP session again once when Mend forgot it, and the harness sees nothing of it", async () => {
    const sessions = new Set<string>();
    const fake = await channel(mcpServer({ sessions }));
    try {
      const running = startBridge(fake.url);
      running.send(initialize);
      running.send(initialized);
      running.send(list);
      await running.read(2);
      sessions.clear();
      running.send(render);
      running.send({ ...list, id: 3 });
      const run = await running.end();
      expect(run.code).toBe(0);
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", id: 1, result: { answered: "tools/list" } },
        expect.anything(),
        expect.anything(),
      ]);
      expect(run.stdout.slice(2)).toEqual(
        expect.arrayContaining([
          { jsonrpc: "2.0", id: 2, result: { answered: "tools/call" } },
          { jsonrpc: "2.0", id: 3, result: { answered: "tools/list" } },
        ]),
      );
      expect(run.stderr).toContain("Mend had forgotten this MCP session");
      const posts = mcpPosts(fake.seen);
      const opens = posts.filter((entry) => entry.message?.method === "initialize");
      expect(opens.map((entry) => entry.message)).toEqual([initialize, initialize]);
      const retried = posts.filter((entry) => entry.message?.method === "tools/call");
      expect(retried.map((entry) => entry.headers["mcp-session-id"])).toEqual(["mcp-1", "mcp-2"]);
      expect(new Set(retried.map((entry) => entry.headers[MEND_MCP_CALL_KEY_HEADER])).size).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("asks again with the same call key when the channel cannot answer now", async () => {
    const sessions = new Set<string>();
    const server = mcpServer({ sessions });
    let busy = 2;
    const fake = await channel((seen, response) => {
      if (seen.message?.method === "tools/call" && busy-- > 0) {
        json(response, 503, { message: "session channel: this request could not be answered now" });
        return;
      }
      server(seen, response);
    });
    try {
      const run = await bridge(fake.url, [initialize, initialized, render]);
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", id: 2, result: { answered: "tools/call" } },
      ]);
      const calls = mcpPosts(fake.seen).filter((entry) => entry.message?.method === "tools/call");
      expect(calls).toHaveLength(3);
      expect(new Set(calls.map((entry) => entry.headers[MEND_MCP_CALL_KEY_HEADER])).size).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("stops a call the harness cancelled while it waited to ask again, and answers nothing for it", async () => {
    const sessions = new Set<string>();
    const server = mcpServer({ sessions });
    const fake = await channel((seen, response) => {
      if (seen.message?.method === "tools/call") {
        json(response, 503, { message: "session channel: this request could not be answered now" });
        return;
      }
      server(seen, response);
    });
    try {
      const running = startBridge(fake.url);
      running.send(initialize);
      running.send(initialized);
      await running.read(1);
      running.send(render);
      await until(() =>
        mcpPosts(fake.seen).some((entry) => entry.message?.method === "tools/call"),
      );
      running.send(cancelled(render.id));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      running.send(list);
      const run = await running.end();
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
        { jsonrpc: "2.0", id: 1, result: { answered: "tools/list" } },
      ]);
      expect(mcpPosts(fake.seen).map((entry) => entry.message?.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/call",
        "notifications/cancelled",
        "tools/list",
      ]);
    } finally {
      await fake.close();
    }
  });

  it("leaves a call the harness cancelled while Mend held it", async () => {
    const sessions = new Set<string>();
    const server = mcpServer({ sessions });
    const left = Promise.withResolvers<void>();
    const fake = await channel((seen, response) => {
      if (seen.message?.method === "tools/call") {
        response.on("close", () => left.resolve());
        return;
      }
      server(seen, response);
    });
    try {
      const running = startBridge(fake.url);
      running.send(initialize);
      running.send(initialized);
      await running.read(1);
      running.send(render);
      await until(() =>
        mcpPosts(fake.seen).some((entry) => entry.message?.method === "tools/call"),
      );
      running.send(cancelled(render.id));
      await left.promise;
      const run = await running.end();
      expect(run.code).toBe(0);
      expect(run.stdout).toEqual([
        { jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } },
      ]);
    } finally {
      await fake.close();
    }
  });

  it("asks again, with the same call key, when a 2xx answer holds no reply to the request", async () => {
    const sessions = new Set<string>();
    const server = mcpServer({ sessions });
    const unanswered: Array<(response: http.ServerResponse) => void> = [
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end();
      },
      (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{not json");
      },
      (response) =>
        json(response, 200, { jsonrpc: "2.0", method: "notifications/progress", params: {} }),
      (response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} })}\n\n`);
      },
    ];
    const fake = await channel((seen, response) => {
      const next = seen.message?.method === "tools/call" ? unanswered.shift() : undefined;
      if (next !== undefined) next(response);
      else server(seen, response);
    });
    try {
      const run = await bridge(fake.url, [initialize, initialized, render]);
      expect(run.stdout.at(-1)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { answered: "tools/call" },
      });
      const calls = mcpPosts(fake.seen).filter((entry) => entry.message?.method === "tools/call");
      expect(calls).toHaveLength(5);
      expect(new Set(calls.map((entry) => entry.headers[MEND_MCP_CALL_KEY_HEADER])).size).toBe(1);
    } finally {
      await fake.close();
    }
  }, 15_000);

  it("keeps asking through a Mend restart of several seconds, with the same call key", async () => {
    const sessions = new Set<string>();
    const first = await channel(mcpServer({ sessions }));
    const running = startBridge(first.url);
    running.send(initialize);
    running.send(initialized);
    await running.read(1);
    await first.close();
    running.send(render);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    sessions.clear();
    const second = await channel(mcpServer({ sessions }), first.port);
    try {
      const run = await running.end();
      expect(run.stdout.at(-1)).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { answered: "tools/call" },
      });
      const calls = mcpPosts(second.seen).filter((entry) => entry.message?.method === "tools/call");
      expect(calls.length).toBeGreaterThan(0);
      expect(new Set(calls.map((entry) => entry.headers[MEND_MCP_CALL_KEY_HEADER])).size).toBe(1);
    } finally {
      await second.close();
    }
  }, 20_000);

  it("answers at once when the workspace has no session channel to ask", async () => {
    const started = performance.now();
    const none = await bridge("", [initialize]);
    expect(none.stdout).toEqual([
      expect.objectContaining({ id: 0, error: expect.objectContaining({ code: -32000 }) }),
    ]);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("answers a request the channel refused with an MCP error saying why", async () => {
    const fake = await channel((_seen, response) =>
      json(response, 422, {
        message: "this workspace runs each person as their own user",
      }),
    );
    try {
      const run = await bridge(fake.url, [initialize, initialized]);
      expect(run.code).toBe(0);
      expect(run.stdout).toEqual([
        {
          jsonrpc: "2.0",
          id: 0,
          error: { code: -32000, message: "this workspace runs each person as their own user" },
        },
      ]);
      expect(run.stderr).toContain("this workspace runs each person as their own user");
    } finally {
      await fake.close();
    }
    const none = await bridge("", [initialize]);
    expect(none.stdout).toEqual([
      {
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32000, message: expect.stringContaining("no session channel") },
      },
    ]);
  });
});
