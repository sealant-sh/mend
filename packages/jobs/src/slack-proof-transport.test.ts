import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeSlackApi } from "@mend/slack/client";
import { makeFsBlobStore } from "@mend/store";
import { Effect } from "effect";
import { expect, it } from "vitest";

it("sends a 1 MB fs blob as exact raw bytes with Content-Length, without chunked encoding", async () => {
  const root = await mkdtemp(join(tmpdir(), "mend-proof-slack-transport-"));
  const received: Array<{
    headers: IncomingHttpHeaders;
    method: string | undefined;
    body: Buffer;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Array<Buffer> = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    received.push({ headers: request.headers, method: request.method, body });
    response.end(`OK - ${body.byteLength}`);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No recording port");
    const bytes = Buffer.from(Uint8Array.from({ length: 1_072_344 }, (_, index) => index % 251));
    const blobs = makeFsBlobStore(root);
    await Effect.runPromise(blobs.put("proof.mp4", bytes));
    const body = await Effect.runPromise(blobs.getStream("proof.mp4"));
    const api = makeSlackApi({
      fetch: (_url, init) => globalThis.fetch(`http://127.0.0.1:${address.port}/upload`, init),
    });
    await Effect.runPromise(
      api.filesUpload("https://files.slack.com/upload/ticket", {
        body,
        length: bytes.byteLength,
      }),
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.headers["content-type"]).toBe("application/octet-stream");
    expect(received[0]?.headers["content-length"]).toBe(String(bytes.byteLength));
    expect(received[0]?.headers["transfer-encoding"]).toBeUndefined();
    expect(received[0]?.headers.authorization).toBeUndefined();
    expect(received[0]?.body.byteLength).toBe(bytes.byteLength);
    expect(received[0]?.body.equals(bytes)).toBe(true);
    expect(body.destroyed).toBe(true);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      }),
    );
    console.info("Removing test blob directory", root, await readdir(root));
    await rm(root, { recursive: true, force: true });
  }
});
