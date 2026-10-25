import { createHash } from "node:crypto";
import { once } from "node:events";
import * as http from "node:http";
import * as net from "node:net";

import { SealantWorkspaceId } from "@mend/domain";
import { SealantPlatformError } from "@mend/sealant";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import type { ForwardTarget } from "../src/forward.ts";
import {
  ForwardAgent,
  type ForwardDialRecord,
  type ForwardSocketConnect,
  forwardSockets,
  relayForwardSocket,
} from "../src/index.ts";
import {
  adapterLayer,
  type DialScript,
  type FakeForward,
  type FakeWorkspaceSide,
  echo,
  fakeForward,
  held,
  scriptedSealant,
  takeFirst,
  untilAborted,
} from "./forward-fixture.ts";

const target: ForwardTarget = {
  workspaceId: SealantWorkspaceId.make("ws-1"),
  port: 3000,
  binding: { kind: "port" },
};

const connectWith = (
  script: DialScript,
  lookup?: Parameters<typeof scriptedSealant>[1],
): Promise<ForwardSocketConnect> =>
  Effect.runPromise(
    forwardSockets.pipe(
      Effect.provide(adapterLayer(scriptedSealant(script, lookup).layer, "refuse")),
    ),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const until = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** Reads everything the client sent until its FIN, waits, then answers with it and a digest. */
const answerAfterFin = async (side: FakeWorkspaceSide) => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of side.fromClient) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  await sleep(30);
  for (let offset = 0; offset < body.length; offset += 50_000) {
    await side.send(body.subarray(offset, offset + 50_000));
  }
  await side.send(Buffer.from(`\ndigest ${createHash("sha256").update(body).digest("hex")}`));
  await side.end();
};

/** A keep-alive HTTP/1.1 server: one fixed answer per request head, until the client's FIN. */
const keepAliveHttp = async (side: FakeWorkspaceSide) => {
  let buffered = "";
  for await (const chunk of side.fromClient) {
    buffered += Buffer.from(chunk).toString("latin1");
    for (let end = buffered.indexOf("\r\n\r\n"); end >= 0; end = buffered.indexOf("\r\n\r\n")) {
      buffered = buffered.slice(end + 4);
      await side.send(
        Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok"),
      );
    }
  }
  await side.end();
};

const openEcho: DialScript = async () => fakeForward(echo).forward;

const servers: net.Server[] = [];
const agents: http.Agent[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const agent of agents.splice(0)) agent.destroy();
});

/** A listener whose every connection is relayed, as ServiceHost's are. */
const relayListener = async (connect: ForwardSocketConnect, observed: ForwardDialRecord[] = []) => {
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    relayForwardSocket(client, connect, target, {
      purpose: "service",
      observe: (record) => observed.push(record),
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
};

const exchange = (port: number, payload: Buffer, chunkBytes = payload.length || 1) =>
  new Promise<{ readonly received: Buffer; readonly error: string | null }>((resolve) => {
    const client = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    let error: string | null = null;
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    client.on("error", (cause: NodeJS.ErrnoException) => {
      error = cause.code ?? cause.message;
    });
    client.on("close", () => resolve({ received: Buffer.concat(chunks), error }));
    for (let offset = 0; offset < payload.length; offset += chunkBytes) {
      client.write(payload.subarray(offset, offset + chunkBytes));
    }
    client.end();
  });

const EARLY_BODY = Buffer.alloc(1 << 20, "x");
const PAYLOAD_TOO_LARGE = Buffer.concat([
  Buffer.from(`HTTP/1.1 413 Payload Too Large\r\nContent-Length: ${EARLY_BODY.length}\r\n\r\n`),
  EARLY_BODY,
]);

const refuseUploadWith413 = async (side: FakeWorkspaceSide) => {
  await takeFirst(side);
  await sleep(20);
  for (let offset = 0; offset < PAYLOAD_TOO_LARGE.length; offset += 16 * 1024) {
    void side.send(PAYLOAD_TOO_LARGE.subarray(offset, offset + 16 * 1024));
  }
  await side.end();
};

const answerUnread = async (side: FakeWorkspaceSide) => {
  void side.send(Buffer.from("answer"));
  await sleep(30);
  await side.end();
};

describe("relayForwardSocket", () => {
  it("carries 1 MiB both ways and a response that starts after the client's FIN", async () => {
    const dial = held<void>();
    const connect = await connectWith(async () => {
      await dial.promise;
      return fakeForward(answerAfterFin).forward;
    });
    const observed: ForwardDialRecord[] = [];
    const port = await relayListener(connect, observed);
    const payload = Buffer.alloc(1 << 20);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;
    const result = exchange(port, payload);
    // The client writes and half-closes before the forward is open.
    await sleep(20);
    dial.resolve();
    const { received, error } = await result;
    const digest = createHash("sha256").update(payload).digest("hex");
    expect(error).toBeNull();
    expect(received.subarray(0, payload.length).equals(payload)).toBe(true);
    expect(received.subarray(payload.length).toString()).toBe(`\ndigest ${digest}`);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.kind).toBe("ready");
  });

  it("resets the client when the workspace resets mid-response, never a clean end", async () => {
    const connect = await connectWith(
      async () =>
        fakeForward(async (side) => {
          await side.send(Buffer.from("partial"));
          await sleep(20);
          side.reset("target-error");
        }).forward,
    );
    const port = await relayListener(connect);
    const { received, error } = await exchange(port, Buffer.from("hello"));
    expect(received.toString()).toBe("partial");
    expect(error).toBe("ECONNRESET");
  });

  it("delivers the answer of a workspace that ends during the client's upload, then a clean end", async () => {
    const connect = await connectWith(async () => fakeForward(refuseUploadWith413).forward);
    const port = await relayListener(connect);
    const { received, error } = await exchange(port, Buffer.alloc(4 << 20, 7), 64 * 1024);
    expect(received.equals(PAYLOAD_TOO_LARGE)).toBe(true);
    expect(error).toBeNull();
  });

  it("resets the client after the answer when the workspace ends without taking what came before the client's FIN", async () => {
    const connect = await connectWith(async () => fakeForward(answerUnread).forward);
    const port = await relayListener(connect);
    const { received, error } = await exchange(port, Buffer.from("hello"));
    expect(received.toString()).toBe("answer");
    expect(error).toBe("ECONNRESET");
  });

  it("gives the forward up when the client resets while its upload waits for the workspace", async () => {
    let forward: FakeForward | null = null;
    const connect = await connectWith(async () => {
      forward = fakeForward(() => new Promise(() => undefined));
      return forward.forward;
    });
    const port = await relayListener(connect);
    const client = net.connect(port, "127.0.0.1");
    client.on("error", () => undefined);
    await once(client, "connect");
    await until(() => forward !== null, "the forward");
    for (let i = 0; i < 3; i++) {
      client.write(Buffer.alloc(4096, i));
      await sleep(10);
    }
    client.resetAndDestroy();
    await until(() => forward?.closedByClient() === true, "the forward to be reset");
  });

  it("reports a refusal Mend makes before any await, once", async () => {
    const connect = await connectWith(openEcho, () =>
      Effect.fail(
        new SealantPlatformError({
          code: "NO_PRINCIPAL",
          status: null,
          message: "no principal",
          cause: null,
        }),
      ),
    );
    const observed: ForwardDialRecord[] = [];
    const port = await relayListener(connect, observed);
    const { error } = await exchange(port, Buffer.from("hello"));
    expect(error).toBe("ECONNRESET");
    expect(observed).toEqual([
      expect.objectContaining({
        kind: "failed",
        issue: expect.objectContaining({ reason: "NO_PRINCIPAL" }),
      }),
    ]);
  });

  it("destroys a socket whose dial dies, so it never stays connecting", async () => {
    const connect = await connectWith(openEcho, () => Effect.die(new Error("boom")));
    const socket = connect(target, { purpose: "service" });
    const errors: Error[] = [];
    socket.on("error", (error) => errors.push(error));
    await until(() => socket.destroyed, "the socket to be destroyed");
    expect(socket.connecting).toBe(true);
    await until(() => errors.length === 1, "its error");
    expect(errors[0]?.message).toContain("dial failed");
  });

  it("gives up the dial when the client leaves during it, and resets a forward that opens late", async () => {
    const opening = held<FakeForward>();
    let aborted = false;
    const connect = await connectWith(async (_destination, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return (await opening.promise).forward;
    });
    const port = await relayListener(connect);
    const client = net.connect(port, "127.0.0.1");
    await once(client, "connect");
    // A reset, not a FIN: a FIN alone is a half-close, which waits for the answer.
    client.resetAndDestroy();
    await until(() => aborted, "the dial to be given up");
    const late = fakeForward(answerAfterFin);
    opening.resolve(late);
    await until(() => late.closedByClient(), "the late forward to be reset");
  });

  it("refuses a connection whose dial is refused, and reports the refusal once", async () => {
    const connect = await connectWith(async () => {
      throw new (await import("@sealant/sdk")).ForwardDialError({
        reason: "not-found",
        status: 404,
        message: "gone",
      });
    });
    const observed: ForwardDialRecord[] = [];
    const port = await relayListener(connect, observed);
    const { received, error } = await exchange(port, Buffer.from("hello"));
    expect(received.length).toBe(0);
    expect(error).toBe("ECONNRESET");
    expect(observed).toEqual([
      expect.objectContaining({
        kind: "failed",
        issue: expect.objectContaining({ reason: "not-found" }),
      }),
    ]);
  });
});

/** Dials scripted per call: each waits on its own gate, and records whether it was given up. */
const gatedDials = (behaviour: (side: FakeWorkspaceSide) => Promise<void>) => {
  const dials: {
    gate: ReturnType<typeof held<void>>;
    aborted: boolean;
    forward: FakeForward | null;
  }[] = [];
  const script: DialScript = async (_destination, signal) => {
    const dial = { gate: held<void>(), aborted: false, forward: null as FakeForward | null };
    dials.push(dial);
    signal.addEventListener("abort", () => {
      dial.aborted = true;
    });
    await Promise.race([dial.gate.promise, untilAborted(signal)]);
    dial.forward = fakeForward(behaviour);
    return dial.forward.forward;
  };
  return { dials, script };
};

const agentWith = async (script: DialScript, options: http.AgentOptions) => {
  const connect = await connectWith(script);
  const agent = new ForwardAgent(() => connect(target, { purpose: "preview" }), options);
  agents.push(agent);
  return agent;
};

const get = (agent: http.Agent) => {
  const request = http.request({ host: "preview.invalid", port: 80, path: "/", agent });
  const response = new Promise<string>((resolve, reject) => {
    request.on("response", (incoming) => {
      let body = "";
      incoming.on("data", (chunk: Buffer) => (body += chunk.toString()));
      incoming.on("end", () => resolve(body));
    });
    request.on("error", reject);
  });
  request.end();
  return { request, response };
};

const pooled = (agent: http.Agent) =>
  Object.values(agent.sockets).flat().length + Object.values(agent.freeSockets).flat().length;

describe("ForwardAgent", () => {
  it("reuses one forward across keep-alive requests", async () => {
    let dials = 0;
    const agent = await agentWith(
      async () => {
        dials += 1;
        return fakeForward(keepAliveHttp).forward;
      },
      { maxSockets: 2 },
    );
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) bodies.push(await get(agent).response);
    expect(bodies).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(dials).toBe(1);
  });

  it("gives up the dial of a request destroyed before Node assigned it a socket", async () => {
    const { dials, script } = gatedDials(keepAliveHttp);
    const agent = await agentWith(script, { maxSockets: 1 });
    const { request, response } = get(agent);
    response.catch(() => undefined);
    request.destroy();
    await until(() => dials[0]?.aborted === true, "the dial to be given up");
    expect(pooled(agent)).toBe(0);
  });

  it("hands an unassigned dialling socket to the request queued behind it", async () => {
    const { dials, script } = gatedDials(keepAliveHttp);
    const agent = await agentWith(script, { maxSockets: 1 });
    const first = get(agent);
    first.response.catch(() => undefined);
    const second = get(agent);
    first.request.destroy();
    await until(() => dials.length === 1, "one dial");
    dials[0]?.gate.resolve();
    expect(await second.response).toBe("ok");
    expect(dials).toHaveLength(1);
    expect(dials[0]?.aborted).toBe(false);
  });

  it("dials no more at once than maxSockets", async () => {
    let inFlight = 0;
    let most = 0;
    const agent = await agentWith(
      async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await sleep(15);
        inFlight -= 1;
        return fakeForward(keepAliveHttp).forward;
      },
      { maxSockets: 2 },
    );
    const bodies = await Promise.all(Array.from({ length: 10 }, () => get(agent).response));
    expect(bodies).toEqual(Array.from({ length: 10 }, () => "ok"));
    expect(most).toBe(2);
  });

  it("gives up a dial when its assigned request is destroyed during it, and dials again for the next", async () => {
    const { dials, script } = gatedDials(keepAliveHttp);
    const agent = await agentWith(script, { maxSockets: 1 });
    const first = get(agent);
    first.response.catch(() => undefined);
    const second = get(agent);
    await until(() => first.request.socket !== null, "the first request's socket");
    first.request.destroy();
    await until(() => dials[0]?.aborted === true, "the first dial to be given up");
    await until(() => dials.length === 2, "a replacement dial");
    dials[1]?.gate.resolve();
    expect(await second.response).toBe("ok");
  });

  it("gives up every dial in flight when the Agent is destroyed", async () => {
    const { dials, script } = gatedDials(keepAliveHttp);
    const agent = await agentWith(script, { maxSockets: 3 });
    for (let i = 0; i < 3; i++) get(agent).response.catch(() => undefined);
    await until(() => dials.length === 3, "three dials");
    agent.destroy();
    await until(() => dials.every((dial) => dial.aborted), "every dial to be given up");
  });
});
