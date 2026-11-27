import { ORCHESTRATION_V2_WS_METHODS } from "@mend/t3-contracts";
import { telemetryLayer } from "@mend/telemetry";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type * as Tracer from "effect/Tracer";

import { assert, describe, it } from "./support/effect-vitest.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";
import { connectWsRpc, socketUrl } from "./support/rpc.ts";

/**
 * The shape of the gateway's traces (SLNT-1404). On alpha the gateway ran with telemetry off and
 * still sent Mend the `traceparent` of in-memory spans; a person's hub, built inside the first
 * socket's request, sent every poll it made for a day under that request's trace.
 */

const pairAndConnect = (mend: FakeMend, code: string) =>
  Effect.gen(function* () {
    mend.addPairingCode(code, PERSON);
    const client = yield* t3Client;
    const access = yield* client.auth.token(
      tokenRequest(code, { client_label: "Ada's MacBook", client_device_type: "desktop" }),
    );
    const ticket = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
    const rpc = yield* connectWsRpc(yield* socketUrl(ticket.ticket));
    // The hub is built for the socket's first subscription and reads everything once.
    yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
      Stream.runHead,
      Effect.map(Option.getOrThrow),
      Effect.timeout("5 seconds"),
    );
    return rpc;
  });

/** Waits until Mend has seen the hub follow its event stream. */
const hubFollowsEvents = (mend: FakeMend) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (mend.requests.some((request) => request.path === "/api/events")) return;
      yield* Effect.sleep("25 millis");
    }
    assert.fail("the hub never asked for Mend's events");
  });

/** The gateway's telemetry as `bin.ts` builds it, in a process given no `SENTRY_DSN`. */
const withoutDsn = telemetryLayer({ name: "mend-t3-gateway" }).pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  Layer.orDie,
);

const traceIdOf = (traceparent: string | undefined) => traceparent?.split("-")[1];

describe("the gateway's traces", () => {
  it.live("with telemetry off, no request to Mend carries a trace header", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        yield* pairAndConnect(mend, "UNTRACED");
        yield* hubFollowsEvents(mend);
      }).pipe(
        Effect.scoped,
        Effect.provide(gatewayTestLayer(mend.url, ":memory:", { tracing: withoutDsn })),
      );
      assert.isAbove(mend.requests.length, 3);
      assert.deepStrictEqual(
        mend.requests.filter((request) => Object.keys(request.trace).length > 0),
        [],
      );
    }),
  );

  it.live("a socket's span ends once it is open, and its hub's reads are traces of their own", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      const spans: Array<Tracer.Span> = [];
      const seen = yield* Effect.gen(function* () {
        yield* pairAndConnect(mend, "TRACED");
        yield* hubFollowsEvents(mend);
        const socket = spans.find(
          (span) => span.kind === "server" && span.attributes.get("http.route") === "/ws",
        );
        return { socket, open: socket?.status._tag === "Started" };
      }).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url, ":memory:", { spans })));
      assert.isDefined(seen.socket);
      // Ended while the socket was still open: it covers the upgrade, never the connection.
      assert.isFalse(seen.open);
      const events = mend.requests.find((request) => request.path === "/api/events");
      const eventsTrace = traceIdOf(events?.trace["traceparent"]);
      assert.isDefined(eventsTrace);
      assert.notStrictEqual(eventsTrace, seen.socket?.traceId);
      // Nothing joins the socket's trace once it is open: every span in it began before it ended.
      const socket = seen.socket;
      if (socket === undefined || socket.status._tag !== "Ended") return assert.fail("no socket");
      const endedAt = socket.status.endTime;
      const late = spans.filter(
        (span) => span.traceId === socket.traceId && span.status.startTime > endedAt,
      );
      assert.deepStrictEqual(
        late.map((span) => span.name),
        [],
      );
    }),
  );
});
