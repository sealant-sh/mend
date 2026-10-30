import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import type { ForwardBytes, ForwardRead } from "@mend/sealant";
import { answersHttp } from "@mend/sessions";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** One TCP connection as forward bytes: what the adapter hands a readiness check. */
const connectionBytes = (port: number): Promise<ForwardBytes> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Array<Uint8Array> = [];
    const readers: Array<(read: ForwardRead) => void> = [];
    let ended = false;
    const deliver = () => {
      for (;;) {
        const reader = readers[0];
        if (reader === undefined || (chunks.length === 0 && !ended)) return;
        readers.shift();
        const next = chunks.shift();
        reader(next === undefined ? { kind: "eof" } : { kind: "bytes", bytes: next });
      }
    };
    socket.on("data", (chunk) => {
      chunks.push(new Uint8Array(chunk));
      deliver();
    });
    socket.on("end", () => {
      ended = true;
      deliver();
    });
    socket.on("close", () => {
      ended = true;
      deliver();
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      resolve({
        read: () =>
          Effect.callback<ForwardRead>((resume) => {
            readers.push((read) => resume(Effect.succeed(read)));
            deliver();
          }),
        write: (bytes) =>
          Effect.callback<void>((resume) => {
            socket.write(bytes, () => resume(Effect.void));
          }),
        finish: () => Effect.sync(() => void socket.end()),
        close: () => Effect.sync(() => void socket.destroy()),
      }),
    );
  });

const listen = (answer: (socket: net.Socket) => void) =>
  new Promise<net.Server>((resolve) => {
    const server = net.createServer((socket) => socket.once("data", () => answer(socket)));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const portOf = (server: net.Server) => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
};
describe("an HTTP ready check of an http Service", () => {
  const check = async (answer: (socket: net.Socket) => void) => {
    const server = await listen(answer);
    try {
      return await Effect.runPromise(
        answersHttp(await connectionBytes(portOf(server)), {
          path: "/",
          host: "localhost",
          tls: false,
        }),
      );
    } finally {
      server.close();
    }
  };

  it("keeps the status the dev server answered, whatever it is", async () => {
    expect(await check((socket) => socket.end("HTTP/1.1 200 OK\r\n\r\n"))).toBe(200);
    expect(await check((socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"))).toBe(403);
  });

  it("reads no status from a first line that is not one, or a connection closed first", async () => {
    expect(await check((socket) => socket.end("SSH-2.0-OpenSSH_9.6\r\n"))).toBeNull();
    expect(await check((socket) => socket.end())).toBeNull();
  });
});

describe("an HTTP ready check of an https Service", () => {
  let directory = "";
  let server: https.Server | null = null;
  let port = 0;

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "mend-ready-tls-"));
    const key = path.join(directory, "key.pem");
    const cert = path.join(directory, "cert.pem");
    // The dev server's own certificate, as Vite's basic-ssl or `next dev --experimental-https` make.
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
      ].concat(["-keyout", key, "-out", cert, "-subj", "/CN=localhost", "-days", "1"]),
      { stdio: "ignore" },
    );
    server = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (request, response) => {
        response.statusCode = request.url === "/health" ? 204 : 404;
        response.end();
      },
    );
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) =>
      server === null ? resolve() : server.close(() => resolve()),
    );
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("speaks TLS, taking the dev server's own certificate, and reads its status", async () => {
    const answered = await Effect.runPromise(
      answersHttp(await connectionBytes(port), {
        path: "/health",
        host: `localhost:${port}`,
        tls: true,
      }),
    );
    expect(answered).toBe(204);
  });

  it("gets no status line in plain HTTP from a TLS listener", async () => {
    const answered = await Effect.runPromise(
      answersHttp(await connectionBytes(port), {
        path: "/health",
        host: `localhost:${port}`,
        tls: false,
      }),
    );
    expect(answered).toBeNull();
  });
});
