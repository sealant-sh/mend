import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeErrorReporterFromEnv } from "./node.ts";

/** A secret shaped like a Mend device token, so a leak anywhere in a report is easy to find. */
const CANARY = "mdt_canary7f3a9c0e1b2d4f6a8c";
const PACKAGE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/** A stand-in for Sentry's ingest: every envelope it is sent, as the bytes that arrived. */
const startIngest = async () => {
  const received: string[] = [];
  const read = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(Buffer.concat(chunks).toString("utf8"));
  };
  const server = createServer((request, response) => {
    void read(request).then(() => response.writeHead(200).end("{}"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("ingest has no port");
  return {
    dsn: `http://0123456789abcdef0123456789abcdef@127.0.0.1:${address.port}/5`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

class RefusedCall extends Error {
  override readonly name = "RefusedCall";
  /** What a client's request error keeps for diagnostics: the body it was refused with. */
  readonly body = { prompt: `fix the login, my token is ${CANARY}` };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a Node client's error reporter", () => {
  it("sends a report with app frames, the release and none of the secrets around it", async () => {
    const ingest = await startIngest();
    vi.stubEnv("MEND_CANARY_TOKEN", CANARY);
    const reporter = await nodeErrorReporterFromEnv(
      { MEND_SENTRY_DSN: ingest.dsn, MEND_SENTRY_ENVIRONMENT: "test" },
      { release: "mend-cli@1.2.3", appRoot: PACKAGE_ROOT, tags: { client: "cli" } },
    );
    expect(reporter).not.toBeNull();

    const error = new RefusedCall(
      `GET https://person:${CANARY}@mend.example.com/api/sessions?token=${CANARY} failed: ` +
        `Authorization: Bearer ${CANARY} in ${homedir()}/work/project/.env`,
      { cause: new Error(`retrying with key=${CANARY}`) },
    );
    reporter?.report(error);
    expect(await reporter?.flush(2_000)).toBe(true);
    await ingest.close();

    expect(ingest.received).toHaveLength(1);
    const envelope = ingest.received[0] ?? "";
    expect(envelope).not.toContain(CANARY);
    expect(envelope).not.toContain(homedir());
    expect(envelope).not.toContain("fix the login");

    const event: unknown = JSON.parse(envelope.split("\n")[2] ?? "null");
    expect(event).toMatchObject({
      release: "mend-cli@1.2.3",
      environment: "test",
      tags: { client: "cli" },
      exception: {
        values: [
          { type: "Error", value: expect.stringContaining("retrying with") },
          { type: "RefusedCall", value: expect.stringContaining("mend.example.com/api/sessions") },
        ],
      },
    });
    expect(envelope).toContain('"filename":"app:///src/node.test.ts"');
    expect(event).not.toHaveProperty("server_name");
  });

  it("is off when only the person's own SENTRY_DSN is set", async () => {
    const reporter = await nodeErrorReporterFromEnv(
      { SENTRY_DSN: "https://0123456789abcdef@sentry.example.com/42" },
      { release: "mend-cli@1.2.3", appRoot: PACKAGE_ROOT, tags: { client: "cli" } },
    );
    expect(reporter).toBeNull();
  });
});
