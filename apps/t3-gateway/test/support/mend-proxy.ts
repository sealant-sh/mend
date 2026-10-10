import { createServer, request as httpRequest, type ServerResponse } from "node:http";

import * as Effect from "effect/Effect";

/**
 * A proxy in front of the fake Mend that can go down (502 for everything, open streams dropped),
 * or answer `GET /api/me/devices` with a chosen status, and counts the device checks it saw.
 */
export interface MendProxy {
  readonly url: URL;
  readonly setDown: (down: boolean) => void;
  readonly setDeviceCheckStatus: (status: number | null) => void;
  readonly deviceChecks: () => number;
}

export const startMendProxy = (target: URL) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly proxy: MendProxy; readonly close: () => void }>((resume) => {
      let down = false;
      let deviceCheckStatus: number | null = null;
      let deviceChecks = 0;
      const open = new Set<ServerResponse>();
      const server = createServer((request, response) => {
        if (request.method === "GET" && request.url === "/api/me/devices") deviceChecks += 1;
        if (down) {
          response.writeHead(502);
          response.end();
          return;
        }
        if (
          deviceCheckStatus !== null &&
          request.method === "GET" &&
          request.url === "/api/me/devices"
        ) {
          response.writeHead(deviceCheckStatus, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        const upstream = httpRequest(
          {
            host: target.hostname,
            port: target.port,
            path: request.url,
            method: request.method,
            headers: request.headers,
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            open.add(response);
            response.on("close", () => open.delete(response));
            answer.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(upstream);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        resume(
          Effect.succeed({
            proxy: {
              url: new URL(`http://127.0.0.1:${port}`),
              setDown: (next) => {
                down = next;
                if (next) for (const response of open) response.destroy();
              },
              setDeviceCheckStatus: (status) => {
                deviceCheckStatus = status;
              },
              deviceChecks: () => deviceChecks,
            },
            close: () => {
              server.closeAllConnections();
              server.close();
            },
          }),
        );
      });
    }),
    ({ close }) => Effect.sync(close),
  ).pipe(Effect.map(({ proxy }) => proxy));
