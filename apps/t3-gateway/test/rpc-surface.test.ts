import { assert, describe, it } from "@effect/vitest";
import { AuthSessionId, EnvironmentId, WsRpcGroup } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import * as Socket from "effect/unstable/socket/Socket";

import { BEARER_TTL_MS, GRANTED_SCOPES } from "../src/auth.ts";
import { makeGatewayEnvironment } from "../src/environment.ts";
import { MendUnavailable } from "../src/mend-client.ts";
import { makeGatewayRpcHandlers, SERVED_METHODS, SILENT_STREAMS } from "../src/rpc.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";
import { socketUrl } from "./support/rpc.ts";

/**
 * The whole of t3code's RPC group is registered (ADR 0012, "The surface"): a method the server
 * lacks answers with a defect, and a client's durable subscription dies on a defect.
 */

const groupMethods = () => Array.from(WsRpcGroup.requests.keys()).toSorted();

const isStream = (rpc: Rpc.AnyWithProps) => RpcSchema.isStreamSchema(rpc.successSchema);

describe("the RPC surface", () => {
  it("registers a handler for every method in the vendored group, and nothing else", () => {
    const handlers = makeGatewayRpcHandlers({
      environment: makeGatewayEnvironment({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Mend",
        host: "127.0.0.1",
        statePath: ":memory:",
      }),
      mend: {
        claimPairing: () =>
          Effect.fail(new MendUnavailable({ operation: "test", status: null, cause: null })),
        checkDevice: () => Effect.succeed("accepted"),
        listHarnessModels: () => Effect.succeed([]),
      },
      session: {
        sessionId: AuthSessionId.make("session-1"),
        tokenHash: "hash",
        deviceToken: "mdt_test",
        mendUser: PERSON,
        mendDeviceId: "device-1",
        scopes: GRANTED_SCOPES,
        client: { label: null, deviceType: "desktop", os: null },
        issuedAt: 0,
        expiresAt: BEARER_TTL_MS,
        revokedAt: null,
      },
    });
    assert.deepStrictEqual(Object.keys(handlers).toSorted(), groupMethods());
  });

  it("serves and silences only methods of the group, and silences only streams", () => {
    const methods = new Set(groupMethods());
    for (const method of [...SERVED_METHODS, ...SILENT_STREAMS]) {
      assert.isTrue(methods.has(method), method);
    }
    for (const method of SILENT_STREAMS) {
      const rpc = WsRpcGroup.requests.get(method);
      assert.isTrue(rpc !== undefined && isStream(rpc), method);
      assert.isFalse(SERVED_METHODS.has(method), method);
    }
  });
});

// ─── Over the wire ───────────────────────────────────────────────────────────

/**
 * A bare socket speaking Effect RPC's JSON frames, so every method can be called with a payload
 * generated from its own schema: no typed client is needed per method, and what comes back is
 * exactly what a t3code client would read.
 */
const rawRpcSocket = (url: string) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url, { openTimeout: "5 seconds" }).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const reader = yield* socket.reader;
    const writer = yield* socket.writer;
    const inbox = yield* Queue.unbounded<unknown>();
    const decoder = new TextDecoder();
    yield* Effect.forever(
      reader.pull.pipe(
        Effect.flatMap((frames) =>
          Queue.offerAll(
            inbox,
            frames.map((frame): unknown =>
              JSON.parse(typeof frame === "string" ? frame : decoder.decode(frame)),
            ),
          ),
        ),
      ),
    ).pipe(Effect.ignore, Effect.forkScoped);
    return {
      send: (message: object) => writer.write(JSON.stringify(message)),
      inbox,
    };
  });

const Frame = Schema.Struct({ _tag: Schema.String, requestId: Schema.optional(Schema.String) });
const decodeFrame = Schema.decodeUnknownOption(Frame);

/**
 * A payload generated from the method's own schema that the server will decode: generated values
 * are encoded and decoded back, and one that does not survive (a string the schema trims to
 * nothing) is skipped, as a real client would never send it.
 */
const validPayload = (rpc: Rpc.AnyWithProps) =>
  Effect.gen(function* () {
    const schema = Schema.make<Schema.Codec<unknown, unknown>>(rpc.payloadSchema.ast);
    const codec = Schema.toCodecJson(schema);
    const samples = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      count: 25,
      seed: rpc._tag,
    });
    for (const sample of samples) {
      const encoded = Schema.encodeUnknownExit(codec)(sample);
      if (
        Exit.isSuccess(encoded) &&
        Exit.isSuccess(Schema.decodeUnknownExit(codec)(encoded.value))
      ) {
        return encoded.value;
      }
    }
    return yield* Effect.die(new Error(`No payload for ${rpc._tag} survived its own schema.`));
  });

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

describe("every method not served", () => {
  it.live(
    "answers a typed failure from its own contract, or stays silent if it is a feed",
    () =>
      withGateway((mend) =>
        Effect.gen(function* () {
          mend.addPairingCode("EVERYMETHOD", PERSON);
          const client = yield* t3Client;
          const access = yield* client.auth.token(tokenRequest("EVERYMETHOD"));
          const ticket = yield* client.auth.webSocketTicket({
            headers: bearer(access.access_token),
          });
          const socket = yield* rawRpcSocket(yield* socketUrl(ticket.ticket));

          const pending = new Map<string, Rpc.AnyWithProps>();
          let id = 0;
          for (const rpc of WsRpcGroup.requests.values()) {
            if (SERVED_METHODS.has(rpc._tag)) continue;
            const encoded = yield* validPayload(rpc);
            const requestId = String(++id);
            pending.set(requestId, rpc);
            yield* socket.send({
              _tag: "Request",
              id: requestId,
              tag: rpc._tag,
              payload: encoded,
              headers: [],
            });
          }

          // Every refusal arrives as an exit; silent feeds send nothing at all. Read until the
          // socket has been quiet for a while.
          const answered = new Map<string, unknown>();
          const others: Array<unknown> = [];
          while (true) {
            const next = yield* Queue.take(socket.inbox).pipe(Effect.timeoutOption("500 millis"));
            if (Option.isNone(next)) break;
            const frame = decodeFrame(next.value);
            if (
              Option.isSome(frame) &&
              frame.value._tag === "Exit" &&
              frame.value.requestId !== undefined &&
              !answered.has(frame.value.requestId)
            ) {
              answered.set(frame.value.requestId, next.value);
            } else {
              others.push(next.value);
            }
          }
          assert.deepStrictEqual(others, []);

          const silent: Array<string> = [];
          for (const [requestId, rpc] of pending) {
            const frame = answered.get(requestId);
            if (frame === undefined) {
              silent.push(rpc._tag);
              continue;
            }
            const ExitFrame = Schema.Struct({
              exit: Schema.toCodecJson(
                Schema.make<Schema.Codec<Exit.Exit<unknown, unknown>, unknown>>(
                  Rpc.exitSchema(rpc).ast,
                ),
              ),
            });
            const { exit } = yield* Schema.decodeUnknownEffect(ExitFrame)(frame);
            assert.isTrue(
              exit._tag === "Failure" &&
                exit.cause.reasons.length > 0 &&
                exit.cause.reasons.every((reason) => reason._tag === "Fail"),
              `${rpc._tag} answered ${JSON.stringify(frame)}`,
            );
          }
          assert.deepStrictEqual(silent.toSorted(), Array.from(SILENT_STREAMS).toSorted());
        }),
      ),
    30_000,
  );
});
