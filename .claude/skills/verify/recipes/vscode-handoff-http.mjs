import { createHash } from "node:crypto";
import { createServer, request } from "node:http";

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
const settled = () => {};

// The gesture still reaches Mend. Only the named fault lanes alter an answer or delay delivery.
export const handoffProxy = async (origin, token) => {
  const requests = [];
  const sockets = new Set();
  const controls = {
    mode: "normal",
    delay: false,
    drop: 0,
    refuseLaunch: false,
    adoptedDefault: null,
  };
  let release = settled;
  let delayed = Promise.resolve();
  const server = createServer((incoming, response) => {
    const route = incoming.url ?? "";
    const receive = incoming.method === "POST" && /\/handoffs\?/.test(route);
    const terms = incoming.method === "GET" && route.endsWith("/handoffs");
    const adoption = incoming.method === "POST" && route === "/api/projects";
    const row = { method: incoming.method, route, status: null, digest: null, bytes: 0 };
    requests.push(row);
    if (controls.mode === "offline") {
      incoming.socket.destroy();
      return;
    }
    if (controls.mode === "unauthorized") {
      json(response, 401, { _tag: "Unauthorized" });
      return;
    }
    if (terms && controls.mode === "old") {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }
    if (route === "/api/handoffs" && controls.mode === "no-instance") {
      response.writeHead(404);
      response.end("Not Found");
      return;
    }
    if (terms && controls.mode === "terms-refused" && !route.includes("handoff-probe")) {
      json(response, 422, {
        _tag: "HandoffRefused",
        reason: "store-co-located",
        message: "This fixture declares a co-located store.",
      });
      return;
    }
    if (controls.refuseLaunch && incoming.method === "POST" && route.endsWith("/launch")) {
      json(response, 429, {
        _tag: "BudgetExceeded",
        budget: "liveSessions",
        limit: 1,
        message: "The live-session budget refused this launch.",
      });
      return;
    }
    const chunks = [];
    const digest = createHash("sha256");
    incoming.on("data", (chunk) => {
      chunks.push(chunk);
      digest.update(chunk);
      row.bytes += chunk.length;
    });
    incoming.on("end", async () => {
      if (receive) row.digest = digest.digest("hex");
      if (receive && controls.delay) {
        delayed = new Promise((resolve) => {
          release = resolve;
        });
        await delayed;
      }
      const outgoing = request(
        new URL(route, origin),
        {
          method: incoming.method,
          headers: {
            ...incoming.headers,
            host: new URL(origin).host,
            authorization: `Bearer ${token}`,
          },
        },
        (answer) => {
          row.status = answer.statusCode;
          if (receive && controls.drop > 0) {
            controls.drop--;
            answer.resume();
            answer.on("end", () => response.destroy());
            return;
          }
          if (adoption && controls.adoptedDefault !== null) {
            let text = "";
            answer.setEncoding("utf8");
            answer.on("data", (chunk) => {
              text += chunk;
            });
            answer.on("end", () => {
              const body = JSON.parse(text);
              json(response, answer.statusCode, {
                ...body,
                defaultBranch: controls.adoptedDefault,
              });
            });
            return;
          }
          response.writeHead(answer.statusCode, answer.headers);
          answer.pipe(response);
          response.on("close", () => answer.destroy());
        },
      );
      outgoing.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      outgoing.end(Buffer.concat(chunks));
      response.on("close", () => outgoing.destroy());
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No proxy listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    controls,
    requests,
    release: () => {
      controls.delay = false;
      release();
    },
    reconnect: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      release();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};
