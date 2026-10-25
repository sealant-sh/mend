import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Cause, Effect, Exit, Fiber, type ManagedRuntime, type Scope } from "effect";

import { servePreviewRequest } from "../../src/preview-host.ts";
import type { PreviewConfig, PreviewIdentity, PreviewViewer } from "../../src/preview-identity.ts";

export const PREVIEW_REQUEST_SPAN = "preview.request";

const headPairs = (request: IncomingMessage) =>
  request.rawHeaders.flatMap(
    (value, index, all): Array<readonly [string, string]> =>
      index % 2 === 0 ? [[value, all[index + 1] ?? ""]] : [],
  );

const untilClosed = (response: ServerResponse) =>
  Effect.callback<void>((resume) => {
    if (response.destroyed || response.writableFinished) return resume(Effect.void);
    response.once("close", () => resume(Effect.void));
  });

const appFor =
  (path: string, response: ServerResponse) =>
  (admitted: PreviewViewer): Effect.Effect<undefined, never, Scope.Scope> =>
    Effect.gen(function* () {
      if (path === "/whoami") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            userId: admitted.viewer.userId,
            previewId: admitted.preview.id,
            origin: admitted.origin,
          }),
        );
        return undefined;
      }
      yield* Effect.addFinalizer(() =>
        path === "/stall" ? Effect.never : Effect.sync(() => response.end()),
      );
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(`event: open\ndata: ${admitted.viewer.userId}\n\n`);
      yield* untilClosed(response);
      return undefined;
    });

export const startPreviewListener = async <ER>(
  runtime: ManagedRuntime.ManagedRuntime<PreviewIdentity | PreviewConfig, ER>,
) => {
  const server = createServer((request, response) => {
    const target = request.url ?? "/";
    const path = target.split("?")[0] ?? "/";
    const served = servePreviewRequest(
      { method: request.method ?? "GET", target, headers: headPairs(request) },
      appFor(path, response),
    ).pipe(
      Effect.withSpan(PREVIEW_REQUEST_SPAN),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            if (exit.value === null) return;
            response.writeHead(exit.value.status, exit.value.headers);
            response.end(exit.value.body);
            return;
          }
          if (response.writableEnded) return;
          if (!response.headersSent && !Cause.hasInterruptsOnly(exit.cause)) {
            response.writeHead(500);
            response.end();
            return;
          }
          response.destroy();
        }),
      ),
    );
    const fiber = runtime.runFork(served);
    response.once("close", () => {
      if (!response.writableFinished && fiber.pollUnsafe() === undefined) {
        runtime.runFork(Fiber.interrupt(fiber));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the listener has no port");
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};
