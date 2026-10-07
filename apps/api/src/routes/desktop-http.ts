import { request as httpRequest, type IncomingMessage } from "node:http";
import { Duplex, Readable, Writable } from "node:stream";

/** The public SDK's workspace byte pipe, kept behind this HTTP adapter. */
export interface DesktopPipe {
  readonly output: AsyncIterable<Uint8Array>;
  readonly send: (bytes: Uint8Array) => void;
  readonly eof: () => void;
  readonly close: () => void;
}

/** Only controller operations and recorded observations cross Mend's authenticated origin. */
export const desktopPathAllowed = (method: string, path: string): boolean =>
  (method === "GET" && path === "/state") ||
  (method === "POST" && /^\/(pilot|cancel|takeover|release)$/.test(path)) ||
  (method === "GET" &&
    /^\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(recording\.mp4|final\.png|actions\.jsonl|transcript\.txt)$/.test(
      path,
    ));

/** Stream an HTTP exchange through workspace.forward, without publishing a workspace port. */
export const desktopHttp = (
  pipe: DesktopPipe,
  input: {
    readonly method: string;
    readonly path: string;
    readonly body: Uint8Array;
    readonly range?: string;
  },
): Promise<{ readonly response: IncomingMessage; readonly close: () => void }> => {
  const writable = new Writable({
    write(bytes: Uint8Array, _encoding, callback) {
      try {
        pipe.send(bytes);
        callback();
      } catch (cause) {
        callback(cause instanceof Error ? cause : new Error("Desktop write failed"));
      }
    },
    final(callback) {
      pipe.eof();
      callback();
    },
  });
  const socket = Duplex.from({
    readable: Readable.from(pipe.output, { objectMode: false }),
    writable,
  });
  const close = () => {
    socket.destroy();
    pipe.close();
  };
  socket.on("close", () => pipe.close());
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: 6090,
      path: input.path,
      method: input.method,
      createConnection: () => socket,
      headers: {
        "content-type": "application/json",
        "content-length": input.body.byteLength,
        connection: "close",
        ...(input.range ? { range: input.range } : {}),
      },
    });
    const timer = setTimeout(
      () => request.destroy(new Error("Desktop did not answer in time")),
      10000,
    );
    request.once("response", (response) => {
      clearTimeout(timer);
      // Workspace code cannot choose an executable content type on Mend's origin.
      response.headers["content-type"] = input.path.endsWith(".mp4")
        ? "video/mp4"
        : input.path.endsWith(".png")
          ? "image/png"
          : input.path.endsWith(".jsonl")
            ? "application/x-ndjson"
            : input.path.endsWith(".txt")
              ? "text/plain; charset=utf-8"
              : "application/json";
      resolve({ response, close });
    });
    request.once("error", (error) => {
      clearTimeout(timer);
      close();
      reject(error);
    });
    request.end(input.body);
  });
};
