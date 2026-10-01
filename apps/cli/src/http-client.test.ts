import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import * as os from "node:os";
import * as path from "node:path";

import { Agent, type Dispatcher, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cliDispatcher } from "./http-client.ts";

/**
 * A server that offers HTTP/2 and HTTP/1.1, as alpha's edge does: the CLI's dispatcher must pick
 * HTTP/1.1, and a dispatcher that allows HTTP/2 must pick HTTP/2 (so the test can tell them apart).
 */

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

describe.skipIf(!hasOpenssl)("the CLI's HTTP client", () => {
  let server: http2.Http2SecureServer;
  let origin = "";
  let cert = "";

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mend-http1-"));
    const keyPath = path.join(dir, "key.pem");
    const certPath = path.join(dir, "cert.pem");
    const made = spawnSync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    expect(made.status).toBe(0);
    cert = fs.readFileSync(certPath, "utf8");
    server = http2.createSecureServer(
      { key: fs.readFileSync(keyPath), cert, allowHTTP1: true },
      (request, response) => {
        response.end(request.httpVersion);
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no TCP address");
    origin = `https://127.0.0.1:${address.port}`;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** The version the global `fetch` speaks with `dispatcher` installed, as `useHttp1` installs it. */
  const versionOver = async (dispatcher: Agent): Promise<string> => {
    const previous: Dispatcher = getGlobalDispatcher();
    setGlobalDispatcher(dispatcher);
    try {
      return await (await fetch(origin)).text();
    } finally {
      setGlobalDispatcher(previous);
      await dispatcher.close();
    }
  };

  it("speaks HTTP/1.1 to a server that offers HTTP/2", async () => {
    expect(await versionOver(cliDispatcher({ ca: cert }))).toBe("1.1");
  });

  it("is the difference: a dispatcher that allows HTTP/2 gets HTTP/2 from the same server", async () => {
    expect(await versionOver(new Agent({ allowH2: true, connect: { ca: cert } }))).toBe("2.0");
  });
});
