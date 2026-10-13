import { once } from "node:events";

import { Deferred, Effect, Fiber, Logger, References, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import { makeFakeSlackSocket, makeSlackSocket } from "./socket.ts";

/** A real WebSocket peer; injected HTTP only supplies its owned loopback URL. */
const socketPeer = async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const connected = Promise.withResolvers<WebSocket>();
  const closed = Promise.withResolvers<void>();
  const received: Array<string> = [];
  const pending: Array<{ count: number; resolve: () => void }> = [];
  const requests: Array<{ method: string; bearerMatches: boolean }> = [];
  server.on("connection", (socket) => {
    socket.on("message", (bytes) => {
      received.push(bytes.toString());
      for (const waiter of pending.splice(0)) {
        if (received.length >= waiter.count) waiter.resolve();
        else pending.push(waiter);
      }
    });
    socket.once("close", () => closed.resolve());
    connected.resolve(socket);
  });
  try {
    await once(server, "listening");
    const address = server.address();
    if (typeof address === "string" || address === null)
      throw new Error("Expected owned TCP address");
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const method = new URL(String(input)).pathname;
      requests.push({
        method,
        bearerMatches: new Headers(init?.headers).get("authorization") === "Bearer xapp-fixture",
      });
      if (method !== "/api/apps.connections.open") throw new Error("Unexpected SDK HTTP request");
      return Response.json({ ok: true, url: `ws://127.0.0.1:${address.port}/socket` });
    };
    return {
      fetch,
      connected: connected.promise,
      closed: closed.promise,
      received,
      requests,
      open: () => server.clients.size,
      messages: (count: number) =>
        received.length >= count
          ? Promise.resolve()
          : new Promise<void>((resolve) => pending.push({ count, resolve })),
      close: async () => {
        await Promise.all(
          [...server.clients].map(async (socket) => {
            if (socket.readyState === WebSocket.CLOSED) return;
            const socketClosed = once(socket, "close");
            socket.terminate();
            await socketClosed;
          }),
        );
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          }),
        );
        if (server.address() !== null || server.clients.size !== 0)
          throw new Error("Owned socket peer did not release its listener and clients");
      },
    };
  } catch (error) {
    for (const socket of server.clients) socket.terminate();
    server.close();
    throw error;
  }
};

describe("the live Socket Mode connection (over @slack/socket-mode)", () => {
  it("fails with Slack's own code when the app-level token is refused, and sends it as a bearer", async () => {
    const sent: Array<string | null> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      sent.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await Effect.runPromise(
      makeSlackSocket({ fetch }).connect("xapp-refused").pipe(Stream.runDrain, Effect.result),
    );

    expect(result._tag === "Failure" ? result.failure : null).toMatchObject({
      _tag: "SlackApiError",
      method: "apps.connections.open",
      code: "invalid_auth",
    });
    expect(sent[0]).toBe("Bearer xapp-refused");
  });

  it("maps actual SDK envelopes and acknowledges each consumed envelope once over the wire", async () => {
    const peer = await socketPeer();
    const eventBody = { event_id: "event-1", event: { type: "app_mention", text: "hello" } };
    const interactiveBody = { type: "block_actions", actions: [{ action_id: "follow-up" }] };
    const otherBody = { value: "unknown-envelope" };
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* makeSlackSocket({ fetch: peer.fetch })
            .connect("xapp-fixture")
            .pipe(
              Stream.tap((envelope) => envelope.ack),
              Stream.map(({ type, envelopeId, body, retryAttempt }) => ({
                type,
                envelopeId,
                body,
                retryAttempt,
              })),
              Stream.runCollect,
              Effect.forkChild,
            );
          const socket = yield* Effect.promise(() => peer.connected);
          socket.send(JSON.stringify({ type: "hello" }));
          for (const envelope of [
            { type: "events_api", envelope_id: "e1", payload: eventBody, retry_attempt: 2 },
            { type: "interactive", envelope_id: "e2", payload: interactiveBody },
            { type: "unread_kind", envelope_id: "e3", payload: otherBody },
          ])
            socket.send(JSON.stringify(envelope));
          yield* Effect.promise(() => peer.messages(3));
          socket.send(JSON.stringify({ type: "disconnect", reason: "refresh_requested" }));
          return yield* Fiber.join(fiber);
        }).pipe(Effect.timeout("3 seconds")),
      );
      expect(result).toEqual([
        { type: "events_api", envelopeId: "e1", body: eventBody, retryAttempt: 2 },
        { type: "interactive", envelopeId: "e2", body: interactiveBody, retryAttempt: null },
        { type: "unread_kind", envelopeId: "e3", body: otherBody, retryAttempt: null },
      ]);
      expect(peer.received.map((text) => JSON.parse(text))).toEqual([
        { envelope_id: "e1", payload: {} },
        { envelope_id: "e2", payload: {} },
        { envelope_id: "e3", payload: {} },
      ]);
      expect(peer.requests).toEqual([
        { method: "/api/apps.connections.open", bearerMatches: true },
      ]);
      await peer.closed;
      expect(peer.open()).toBe(0);
    } finally {
      await peer.close();
    }
  });

  it("logs a rejected SDK acknowledgment after disconnect and still succeeds", async () => {
    const peer = await socketPeer();
    const warnings: Array<{ message: unknown; envelopeId: unknown }> = [];
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* makeSlackSocket({ fetch: peer.fetch })
            .connect("xapp-fixture")
            .pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);
          const socket = yield* Effect.promise(() => peer.connected);
          socket.send(JSON.stringify({ type: "hello" }));
          socket.send(
            JSON.stringify({
              type: "interactive",
              envelope_id: "rejected-ack",
              payload: { type: "block_actions" },
            }),
          );
          const envelopes = yield* Fiber.join(fiber);
          yield* Effect.promise(() => peer.closed);
          const envelope = envelopes[0];
          if (envelope === undefined)
            throw new Error("Expected delivered envelope before disconnection");
          yield* envelope.ack.pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((options) => {
                  warnings.push({
                    message: options.message,
                    envelopeId: options.fiber.getRef(References.CurrentLogAnnotations).envelopeId,
                  });
                }),
              ]),
            ),
          );
        }).pipe(Effect.timeout("3 seconds")),
      );
      expect(warnings).toEqual([
        { message: ["slack socket: ack not sent"], envelopeId: "rejected-ack" },
      ]);
      expect(peer.received).toEqual([]);
      expect(peer.open()).toBe(0);
    } finally {
      await peer.close();
    }
  });

  it("interrupts an active connection with a completed close handshake", async () => {
    const peer = await socketPeer();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const delivered = yield* Deferred.make<void>();
          const fiber = yield* makeSlackSocket({ fetch: peer.fetch })
            .connect("xapp-fixture")
            .pipe(
              Stream.tap(() => Deferred.succeed(delivered, undefined)),
              Stream.runDrain,
              Effect.forkChild,
            );
          const socket = yield* Effect.promise(() => peer.connected);
          socket.send(JSON.stringify({ type: "hello" }));
          socket.send(JSON.stringify({ type: "interactive", envelope_id: "ready", payload: {} }));
          yield* Deferred.await(delivered);
          expect(peer.open()).toBe(1);
          yield* Fiber.interrupt(fiber);
          yield* Effect.promise(() => peer.closed);
          expect(peer.open()).toBe(0);
        }).pipe(Effect.timeout("3 seconds")),
      );
      expect(peer.requests).toHaveLength(1);
    } finally {
      await peer.close();
    }
  });

  it("interrupts startup while awaiting hello and releases the owned connection", async () => {
    const peer = await socketPeer();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* makeSlackSocket({ fetch: peer.fetch })
            .connect("xapp-fixture")
            .pipe(Stream.runDrain, Effect.forkChild);
          yield* Effect.promise(() => peer.connected);
          expect(peer.open()).toBe(1);
          yield* Fiber.interrupt(fiber);
          yield* Effect.promise(() => peer.closed);
          expect(peer.open()).toBe(0);
        }).pipe(Effect.timeout("3 seconds")),
      );
      expect(peer.received).toEqual([]);
      expect(peer.requests).toHaveLength(1);
    } finally {
      await peer.close();
    }
  });

  it("completes when hello is immediately followed by the peer's close frame", async () => {
    const peer = await socketPeer();
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* makeSlackSocket({ fetch: peer.fetch })
            .connect("xapp-fixture")
            .pipe(Stream.runCollect, Effect.result, Effect.forkChild);
          const socket = yield* Effect.promise(() => peer.connected);
          socket.send(JSON.stringify({ type: "hello" }));
          socket.close(1000, "after hello");
          const completed = yield* Fiber.join(fiber);
          yield* Effect.promise(() => peer.closed);
          return completed;
        }).pipe(Effect.timeout("3 seconds")),
      );
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") throw new Error("Expected completed established connection");
      expect(result.success).toEqual([]);
      expect(peer.open()).toBe(0);
    } finally {
      await peer.close();
    }
  });

  it("fails and closes when the real peer disconnects before the hello handshake", async () => {
    const peer = await socketPeer();
    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const fiber = yield* makeSlackSocket({ fetch: peer.fetch })
            .connect("xapp-fixture")
            .pipe(Stream.runDrain, Effect.result, Effect.forkChild);
          const socket = yield* Effect.promise(() => peer.connected);
          socket.close(1000, "no hello");
          const completed = yield* Fiber.join(fiber);
          yield* Effect.promise(() => peer.closed);
          return completed;
        }).pipe(Effect.timeout("3 seconds")),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "SlackApiError", method: "apps.connections.open", code: "request_failed" },
      });
      expect(peer.open()).toBe(0);
      expect(peer.requests).toHaveLength(1);
    } finally {
      await peer.close();
    }
  });
});

describe("the fake Socket Mode", () => {
  it("delivers to open sockets, records acks, and closes with the stream", async () => {
    const fake = makeFakeSlackSocket();
    const seen = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* fake.service.connect("xapp-1").pipe(
          Stream.tap((envelope) => envelope.ack),
          Stream.map((envelope) => envelope.envelopeId),
          Stream.runCollect,
          Effect.forkChild,
        );
        while (fake.open().length === 0) yield* Effect.yieldNow;
        fake.deliver("xapp-1", { type: "events_api", envelopeId: "e1", body: {} });
        fake.drop("xapp-1");
        return yield* Fiber.await(fiber);
      }),
    );

    expect(seen._tag === "Success" ? seen.value : null).toEqual(["e1"]);
    expect(fake.acks).toEqual(["e1"]);
    expect(fake.open()).toEqual([]);

    fake.refuse("xapp-2");
    const refused = await Effect.runPromise(
      fake.service.connect("xapp-2").pipe(Stream.runDrain, Effect.result),
    );
    expect(refused._tag === "Failure" ? refused.failure.code : null).toBe("invalid_auth");
  });
});
