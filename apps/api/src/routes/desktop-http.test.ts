import { createServer } from "node:http";
import { connect } from "node:net";

import { describe, expect, it } from "vitest";

import { desktopHttp, desktopPathAllowed } from "./desktop-http.ts";

describe("session desktop HTTP boundary", () => {
  it("admits observations and controller commands without exposing workspace files or scripts", () => {
    const run = "12345678-1234-1234-1234-123456789abc";
    expect(desktopPathAllowed("POST", "/pilot")).toBe(true);
    expect(desktopPathAllowed("GET", `/runs/${run}/recording.mp4`)).toBe(true);
    for (const path of [
      "/viewer",
      "/action",
      "/novnc/core/rfb.js",
      `/runs/${run}/mcp.json`,
      `/runs/${run}/../../auth.json`,
      "/runs/not-a-run/final.png",
      "/state?path=/etc/passwd",
    ])
      expect(desktopPathAllowed("GET", path)).toBe(false);
    expect(desktopPathAllowed("POST", "/state")).toBe(false);
    expect(desktopPathAllowed("GET", "/pilot")).toBe(false);
  });

  it("streams a real HTTP range response over a workspace byte pipe", async () => {
    const server = createServer((request, response) => {
      expect(request.headers.range).toBe("bytes=1-3");
      expect(request.headers.cookie).toBeUndefined();
      expect(request.headers.authorization).toBeUndefined();
      response.writeHead(206, { "content-type": "text/html", "content-range": "bytes 1-3/5" });
      response.end("123");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const socket = connect(address.port, "127.0.0.1");
    let closes = 0;
    try {
      const exchange = await desktopHttp(
        {
          output: socket,
          send: (bytes) => {
            socket.write(bytes);
          },
          eof: () => {
            socket.end();
          },
          close: () => {
            closes++;
            socket.destroy();
          },
        },
        {
          method: "GET",
          path: "/runs/example/recording.mp4",
          range: "bytes=1-3",
          body: new Uint8Array(),
        },
      );
      expect(exchange.response.statusCode).toBe(206);
      expect(exchange.response.headers["content-type"]).toBe("video/mp4");
      expect(exchange.response.headers["content-range"]).toBe("bytes 1-3/5");
      const chunks: Buffer[] = [];
      for await (const bytes of exchange.response) chunks.push(bytes);
      expect(Buffer.concat(chunks).toString()).toBe("123");
      exchange.close();
      expect(closes).toBeGreaterThan(0);
    } finally {
      socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
