import { createHash } from "node:crypto";
import { once } from "node:events";
import * as net from "node:net";

import { SealantWorkspaceId } from "@mend/domain";
import { ForwardSessionOwner } from "@mend/sealant";
import {
  ForwardAgent,
  ForwardRefusedError,
  type ForwardSocket,
  type ForwardTarget,
  forwardSockets,
  portTarget,
} from "@mend/sessions";
import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { type DigestAnswer, type RunningFixture, serveFixture } from "./fixtures/preview/apps.ts";
import { uploadGenerated, writePattern } from "./support/preview-bytes.ts";
import { type LocalForwardRoute, localForwards } from "./support/preview-forward.ts";

const WORKSPACE = SealantWorkspaceId.make("ws-preview");
const SESSION = ForwardSessionOwner.make("sealant-session-1");

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

const world = async (extra: ReadonlyArray<LocalForwardRoute> = []) => {
  const app: RunningFixture = await serveFixture("all");
  disposers.push(app.stop);
  const forwards = localForwards([
    { workspaceId: WORKSPACE, port: 5173, entry: { kind: "listen", localPort: app.port } },
    ...extra,
  ]);
  const runtime = ManagedRuntime.make(forwards.layer);
  disposers.push(() => runtime.dispose());
  const connect = await runtime.runPromise(forwardSockets);
  return { app, forwards, connect };
};

const exchange = async (socket: ForwardSocket, request: string) => {
  const parts: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => parts.push(chunk));
  socket.end(request);
  await once(socket, "end");
  return Buffer.concat(parts).toString("latin1");
};

const refusalOf = async (socket: ForwardSocket) => {
  const [error] = await once(socket, "error");
  return error instanceof ForwardRefusedError ? error.record.issue.reason : String(error);
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("local forwards under the real forward adapter", () => {
  it("dials the table's local port and records the dial", async () => {
    const { forwards, connect } = await world();
    const socket = connect(portTarget(WORKSPACE, 5173), { purpose: "preview" });
    const answer = await exchange(
      socket,
      "GET /bytes?n=502 HTTP/1.1\r\nHost: localhost:5173\r\nConnection: close\r\n\r\n",
    );
    const body = Buffer.from(answer.split("\r\n\r\n")[1] ?? "", "latin1");
    expect(answer.startsWith("HTTP/1.1 200"), "the fixture answered through the forward").toBe(
      true,
    );
    expect(sha256(body), "the body, whole").toBe(
      sha256(Buffer.from(Array.from({ length: 502 }, (_, i) => i % 251))),
    );
    expect(forwards.dials, "one dial, its purpose and arrival").toMatchObject([
      {
        kind: "ready",
        purpose: "preview",
        workspaceId: WORKSPACE,
        port: 5173,
        requested: { kind: "port" },
        arrival: { route: "loopback", proof: { kind: "port" } },
      },
    ]);
  });

  it("answers a session-bound dial with that session's binding", async () => {
    const { forwards, connect } = await world();
    const target: ForwardTarget = {
      workspaceId: WORKSPACE,
      port: 5173,
      binding: { kind: "session", session: SESSION },
    };
    const socket = connect(target, { purpose: "preview" });
    await once(socket, "connect");
    socket.destroy();
    expect(forwards.opens, "the SDK was asked for the session").toEqual([
      {
        workspaceId: WORKSPACE,
        port: 5173,
        destination: { route: "loopback", binding: { kind: "session", session: SESSION } },
      },
    ]);
    expect(forwards.dials[0], "the arrival proves the session").toMatchObject({
      kind: "ready",
      arrival: { route: "loopback", proof: { kind: "session", session: SESSION } },
    });
  });

  it("refuses with the table's typed reason", async () => {
    const { forwards, connect } = await world([
      {
        workspaceId: WORKSPACE,
        port: 3000,
        entry: { kind: "refused", reason: "connection-refused" },
      },
      {
        workspaceId: WORKSPACE,
        port: 3001,
        entry: { kind: "refused", reason: "binding-unsupported" },
      },
    ]);
    const bound = (port: number): ForwardTarget => ({
      workspaceId: WORKSPACE,
      port,
      binding: { kind: "session", session: SESSION },
    });
    expect(await refusalOf(connect(bound(3000), { purpose: "preview" })), "refused").toBe(
      "connection-refused",
    );
    expect(await refusalOf(connect(bound(3001), { purpose: "preview" })), "unsupported").toBe(
      "binding-unsupported",
    );
    expect(
      await refusalOf(connect(portTarget(WORKSPACE, 4999), { purpose: "preview" })),
      "a port nobody routed is refused",
    ).toBe("connection-refused");
    expect(
      forwards.opens.filter((open) => open.destination.route === "docker").map((open) => open.port),
      "the sidecar is tried only for the unbound dial (policy refuse)",
    ).toEqual([4999]);
  });

  it("carries uploads and keep-alive requests through a ForwardAgent", async () => {
    const { forwards, connect } = await world();
    const agent = new ForwardAgent(
      () => connect(portTarget(WORKSPACE, 5173), { purpose: "preview" }),
      {
        maxSockets: 1,
      },
    );
    disposers.push(async () => agent.destroy());
    const first = await uploadGenerated("http://localhost:5173/up", {
      bytes: 3 * 1024 * 1024 + 7,
      chunked: true,
      agent,
    });
    const second = await uploadGenerated("http://localhost:5173/up", { bytes: 1024, agent });
    const answer: DigestAnswer = JSON.parse(first.body);
    expect(answer.sha256, "the upload arrived whole").toBe(first.sentSha256);
    expect(JSON.parse(second.body).sha256, "the second upload too").toBe(second.sentSha256);
    expect(answer.headers.host, "Host as the client sent it").toBe("localhost:5173");
    expect(forwards.opens.length, "the second request reused the forward").toBe(1);
  });
});

describe("a target that answers before it read the body", () => {
  it("still delivers its answer, as the SDK's early answer does", async () => {
    const accepted: net.Socket[] = [];
    const early = net.createServer({ pauseOnConnect: true }, (socket) => {
      accepted.push(socket);
      setTimeout(
        () =>
          socket.end(
            "HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
          ),
        300,
      );
    });
    early.listen(0, "127.0.0.1");
    await once(early, "listening");
    disposers.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of accepted) socket.destroy();
          early.close(() => resolve());
        }),
    );
    const address = early.address();
    const localPort = typeof address === "object" && address !== null ? address.port : 0;
    const { forwards, connect } = await world([
      { workspaceId: WORKSPACE, port: 9000, entry: { kind: "listen", localPort } },
    ]);
    const socket = connect(portTarget(WORKSPACE, 9000), { purpose: "preview" });
    const parts: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => parts.push(chunk));
    socket.on("error", () => undefined);
    socket.write(
      `POST /up HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${256 * 1024 * 1024}\r\n\r\n`,
    );
    void writePattern(socket, 256 * 1024 * 1024);
    await once(socket, "end");
    socket.destroy();
    expect(Buffer.concat(parts).toString("latin1"), "the early answer arrived").toMatch(
      /^HTTP\/1\.1 413 /,
    );
    expect(forwards.dials[0]?.kind, "the dial itself succeeded").toBe("ready");
  });
});

describe("the unbounded variant", () => {
  it("is the same forward with eager reads", async () => {
    const app = await serveFixture("all");
    disposers.push(app.stop);
    const forwards = localForwards(
      [{ workspaceId: WORKSPACE, port: 80, entry: { kind: "listen", localPort: app.port } }],
      { unbounded: true },
    );
    const runtime = ManagedRuntime.make(forwards.layer);
    disposers.push(() => runtime.dispose());
    const connect = await runtime.runPromise(forwardSockets);
    const answer = await exchange(
      connect(portTarget(WORKSPACE, 80), { purpose: "benchmark" }),
      "GET /bytes?n=100000 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    );
    expect(answer.split("\r\n\r\n")[1]?.length, "the whole body").toBe(100_000);
  });
});
