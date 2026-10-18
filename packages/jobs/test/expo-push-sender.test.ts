import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { promisify } from "node:util";

import { ProjectId, SessionId } from "@mend/domain";
import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import { ExpoPushSenderLive } from "../src/expo-push-sender.ts";
import { PushSender, type PushMessage } from "../src/push-sender.ts";

const message = (token: string): PushMessage => ({
  token: Redacted.make(token),
  title: "Billing",
  body: "billing-fix completed: Login fixed",
  data: {
    sessionId: SessionId.make("session-fixture"),
    projectId: ProjectId.make("project-fixture"),
  },
});
const withServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (endpoint: string) => Promise<void>,
) => {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("missing owned server address");
    await run(`http://127.0.0.1:${address.port}/push`);
  } finally {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
  }
};
const senderLayer = (endpoint: string, requested: Array<string>) =>
  ExpoPushSenderLive.pipe(
    Layer.provide(
      Layer.effect(
        HttpClient.HttpClient,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // Real FetchHttpClient executes the request; this configured client routes only to our owned socket.
          return HttpClient.mapRequest(client, (request) => {
            requested.push(request.url);
            if (request.url !== "https://exp.host/--/api/v2/push/send")
              throw new Error("unexpected push destination");
            return HttpClientRequest.setUrl(request, endpoint);
          });
        }),
      ).pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  );
const send = (endpoint: string, requested: Array<string>, messages: ReadonlyArray<PushMessage>) =>
  Effect.gen(function* () {
    const sender = yield* PushSender;
    return yield* sender.send(messages);
  }).pipe(Effect.provide(senderLayer(endpoint, requested)));

const bodyOf = (request: IncomingMessage, done: (text: string) => void) => {
  const chunks: Array<Buffer> = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.once("end", () => done(Buffer.concat(chunks).toString("utf8")));
};

describe("ExpoPushSenderLive owned HTTP boundary", () => {
  it("posts exact wire messages and pairs mixed receipts with the request order", async () => {
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      contentType: string | undefined;
      body: unknown;
    }> = [];
    const requested: Array<string> = [];
    await withServer(
      (request, response) =>
        bodyOf(request, (text) => {
          requests.push({
            method: request.method,
            path: request.url,
            contentType: request.headers["content-type"],
            body: JSON.parse(text),
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              data: [
                { status: "ok", id: "receipt-first" },
                { status: "error", details: { error: "DeviceNotRegistered" } },
                { status: "error", details: { error: "MessageTooBig" } },
                { status: "error", details: { error: "DeviceNotRegistered" } },
              ],
            }),
          );
        }),
      async (endpoint) => {
        const unavailable = await Effect.runPromise(
          send(endpoint, requested, [message("first"), message("middle"), message("last")]),
        );
        expect(unavailable.map(Redacted.value)).toEqual(["middle"]);
      },
    );
    expect(requested).toEqual(["https://exp.host/--/api/v2/push/send"]);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/push",
        contentType: "application/json",
        body: ["first", "middle", "last"].map((to) => ({
          to,
          title: "Billing",
          body: "billing-fix completed: Login fixed",
          data: { sessionId: "session-fixture", projectId: "project-fixture" },
          sound: "default",
        })),
      },
    ]);
  });
  it("preserves missing data and shorter receipts as no invented unavailable tokens", async () => {
    for (const payload of [{}, { data: [] }, { data: [{ status: "ok" }] }]) {
      const requested: Array<string> = [];
      await withServer(
        (_request, response) => response.end(JSON.stringify(payload)),
        async (endpoint) => {
          expect(
            await Effect.runPromise(send(endpoint, requested, [message("one"), message("two")])),
          ).toEqual([]);
        },
      );
      expect(requested).toHaveLength(1);
    }
  });
  it.each([
    {
      status: 503,
      body: '{"data":[{"status":"error","details":{"error":"DeviceNotRegistered"}}]}',
      reason: "rejected",
    },
    { status: 200, body: "not json secret-provider-body", reason: "response" },
    { status: 200, body: '{"data":null}', reason: "response" },
    { status: 200, body: '{"data":[{"status":3}]}', reason: "response" },
    {
      status: 200,
      body: '{"data":[{"status":"error","details":{"error":42}}]}',
      reason: "response",
    },
  ])(
    "returns a safe typed $reason error for status $status and malformed/refused replies",
    async ({ status, body, reason }) => {
      const requested: Array<string> = [];
      await withServer(
        (_request, response) => {
          response.writeHead(status);
          response.end(body);
        },
        async (endpoint) => {
          const result = await Effect.runPromise(
            send(endpoint, requested, [message("private-device-token")]).pipe(Effect.result),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag !== "Failure") throw new Error("expected push refusal");
          expect(result.failure._tag).toBe("PushSendError");
          expect(result.failure.reason).toBe(reason);
          expect(result.failure.status).toBe(status);
          const diagnostic = String(result.failure) + JSON.stringify(result.failure);
          expect(diagnostic).not.toContain("private-device-token");
          expect(diagnostic).not.toContain(body);
        },
      );
      expect(requested).toHaveLength(1);
    },
  );
  it("reports a transport failure without exposing the request or retrying", async () => {
    let arrivals = 0;
    const requested: Array<string> = [];
    await withServer(
      (request) => {
        arrivals++;
        request.socket.destroy();
      },
      async (endpoint) => {
        const result = await Effect.runPromise(
          send(endpoint, requested, [message("private-transport-token")]).pipe(Effect.result),
        );
        expect(result._tag).toBe("Failure");
        if (result._tag !== "Failure") throw new Error("expected transport failure");
        expect(result.failure.reason).toBe("request");
        expect(result.failure.status).toBeUndefined();
        expect(String(result.failure) + JSON.stringify(result.failure)).not.toContain(
          "private-transport-token",
        );
      },
    );
    expect(arrivals).toBe(1);
    expect(requested).toHaveLength(1);
  });
  it("preserves ordered unavailable identities across generated mixed receipt positions", async () => {
    let flags: ReadonlyArray<boolean> = [];
    await withServer(
      (_request, response) =>
        response.end(
          JSON.stringify({
            data: flags.map((dead) =>
              dead
                ? { status: "error", details: { error: "DeviceNotRegistered" } }
                : { status: "ok" },
            ),
          }),
        ),
      async (endpoint) => {
        await FastCheck.assert(
          FastCheck.asyncProperty(
            FastCheck.array(FastCheck.boolean(), { minLength: 1, maxLength: 12 }),
            async (next) => {
              flags = next;
              const requested: Array<string> = [];
              const tokens = next.map((_dead, index) => `owned-${index}`);
              const unavailable = await Effect.runPromise(
                send(endpoint, requested, tokens.map(message)),
              );
              expect(unavailable.map(Redacted.value)).toEqual(
                tokens.filter((_token, index) => next[index]),
              );
              expect(requested).toHaveLength(1);
            },
          ),
          { seed: 816006, numRuns: 20 },
        );
      },
    );
  });
  it("aborts an in-flight response body when its caller is interrupted", async () => {
    const started = Effect.runSync(Deferred.make<void>());
    const closed = Effect.runSync(Deferred.make<void>());
    const requested: Array<string> = [];
    await withServer(
      (request, response) => {
        request.socket.once("close", () => Effect.runSync(Deferred.succeed(closed, undefined)));
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"data":[');
        Effect.runSync(Deferred.succeed(started, undefined));
      },
      async (endpoint) => {
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const fiber = yield* send(endpoint, requested, [message("owned-token")]).pipe(
                Effect.forkScoped,
              );
              yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));
              expect(fiber.pollUnsafe()).toBeUndefined();
              yield* Fiber.interrupt(fiber);
              yield* Deferred.await(closed).pipe(Effect.timeout("2 seconds"));
            }),
          ),
        );
      },
    );
    expect(requested).toHaveLength(1);
  });
});
