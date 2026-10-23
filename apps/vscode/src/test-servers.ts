import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach } from "vitest";

import type { ConnectionStore, MendConnection } from "./config.js";

export interface Heard {
  readonly method: string;
  readonly route: string;
  readonly body: string;
}

const closing: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closing.splice(0)) await close();
});

export const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

export const serve = async (
  heard: Array<Heard>,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<string> => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      heard.push({ method: req.method ?? "", route: req.url ?? "", body });
      void handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closing.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No local listener");
  return `http://127.0.0.1:${address.port}`;
};

export const switchable = (url: string) => {
  let current: MendConnection = { url, token: "dana-token" };
  let generation = 0;
  const connections: Pick<ConnectionStore, "get" | "held" | "refused"> = {
    get: async () => current,
    held: async () => {
      const at = generation;
      return { connection: current, current: () => generation === at };
    },
    refused: async () => undefined,
  };
  return {
    connections,
    switchTo: (next: string) => {
      current = { url: next, token: "dana-token" };
      generation += 1;
    },
  };
};
