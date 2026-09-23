import { Effect, Fiber, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeFakeSlackSocket, makeSlackSocket } from "./socket.ts";

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
