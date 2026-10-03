import { assert, describe, it } from "@effect/vitest";
import { AuthSessionId } from "@mend/t3-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { WEBSOCKET_TICKET_TTL_MS, WebSocketTickets, WebSocketTicketsLive } from "../src/tickets.ts";
import { startFakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, pairedClient, PERSON } from "./support/gateway.ts";

const SESSION = AuthSessionId.make("session-1");

describe("WebSocket tickets", () => {
  it.effect("are single use", () =>
    Effect.gen(function* () {
      const tickets = yield* WebSocketTickets;
      const issued = yield* tickets.issue(SESSION);
      assert.deepStrictEqual(yield* tickets.consume(issued.ticket), Option.some(SESSION));
      assert.deepStrictEqual(yield* tickets.consume(issued.ticket), Option.none());
    }).pipe(Effect.provide(WebSocketTicketsLive)),
  );

  it.effect("last thirty seconds", () =>
    Effect.gen(function* () {
      assert.strictEqual(WEBSOCKET_TICKET_TTL_MS, 30_000);
      const tickets = yield* WebSocketTickets;

      const issued = yield* tickets.issue(SESSION);
      assert.strictEqual(DateTime.toEpochMillis(issued.expiresAt), WEBSOCKET_TICKET_TTL_MS);
      yield* TestClock.adjust("29999 millis");
      assert.deepStrictEqual(yield* tickets.consume(issued.ticket), Option.some(SESSION));

      const late = yield* tickets.issue(SESSION);
      yield* TestClock.adjust("30 seconds");
      assert.deepStrictEqual(yield* tickets.consume(late.ticket), Option.none());
    }).pipe(Effect.provide(WebSocketTicketsLive)),
  );

  it.effect("never answer a ticket they did not issue", () =>
    Effect.gen(function* () {
      const tickets = yield* WebSocketTickets;
      assert.deepStrictEqual(yield* tickets.consume("wst_made-up"), Option.none());
    }).pipe(Effect.provide(WebSocketTicketsLive)),
  );

  it.live("are issued over HTTP for the bearer's session, once per request", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.addPairingCode("TICKETS2", PERSON);
      yield* Effect.gen(function* () {
        const { client, access } = yield* pairedClient("TICKETS2");
        const before = Date.now();
        const first = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
        const second = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
        assert.notStrictEqual(first.ticket, second.ticket);
        const expiresAt = DateTime.toEpochMillis(first.expiresAt);
        assert.isAtLeast(expiresAt, before + WEBSOCKET_TICKET_TTL_MS);
        assert.isAtMost(expiresAt, Date.now() + WEBSOCKET_TICKET_TTL_MS);

        // What `/ws?wsTicket=` will spend: the bearer's session, once.
        const tickets = yield* WebSocketTickets;
        const sessionId = yield* tickets.consume(first.ticket);
        assert.isTrue(Option.isSome(sessionId));
        assert.deepStrictEqual(yield* tickets.consume(first.ticket), Option.none());
        assert.deepStrictEqual(yield* tickets.consume(second.ticket), sessionId);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
