import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentAuthInvalidError,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@mend/t3-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { EMPTY_SHELL_SNAPSHOT } from "../src/shell.ts";
import { orchestrationProtocolCompatibilityError } from "./support/compatibility.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";
import { connectWsRpc, socketUrl } from "./support/rpc.ts";

/**
 * The done-when test for `/ws` (ADR 0012, phase 0): a client pairs and connects exactly as
 * t3code's does, over the vendored contracts, and reaches the state t3code calls ready.
 *
 * t3code's own `@t3tools/client-runtime` does not drive it. It is a private package that exists
 * only in t3code's repository (not on npm), and its RPC session (`rpc/session.ts`) imports its
 * connection, error and state modules, which pull in `@t3tools/shared` and its markdown and
 * three.js dependencies. Running it here would mean vendoring a second, much larger t3code package
 * or reading it from a checkout outside the repository that CI does not have. So this test builds
 * the RPC client the way `rpc/session.ts` and `rpc/protocol.ts` build theirs at the pin (socket
 * protocol, JSON serialization, no retries) and applies the same readiness rule: the connection
 * is ready once `subscribeServerConfig` emits a snapshot whose `environmentId` is the
 * descriptor's.
 */

/**
 * The test's sockets live in a scope inside the gateway's, so they close before the gateway
 * does: a server holding an open socket waits on it while shutting down.
 */
const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.scoped, Effect.provide(gatewayTestLayer(mend.url)));
  });

/** Pairs with a fresh code and returns a ticket's `/ws` URL, as a client does per connect. */
const pairAndTicket = (mend: FakeMend, code: string) =>
  Effect.gen(function* () {
    mend.addPairingCode(code, PERSON);
    const client = yield* t3Client;
    const access = yield* client.auth.token(
      tokenRequest(code, { client_label: "Ada's MacBook", client_device_type: "desktop" }),
    );
    const ticket = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
    return { client, access, ticket: ticket.ticket, url: yield* socketUrl(ticket.ticket) };
  });

const first = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  stream.pipe(Stream.runHead, Effect.map(Option.getOrThrow), Effect.timeout("5 seconds"));

describe("GET /ws", () => {
  it.live("connects a paired client to a healthy, empty environment", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        // 1. The descriptor, checked as the client checks it.
        const client = yield* t3Client;
        const descriptor = yield* client.metadata.descriptor();
        assert.isNull(orchestrationProtocolCompatibilityError(descriptor));

        // 2-3. Pairing, a ticket, and the socket.
        const paired = yield* pairAndTicket(mend, "HANDSHAKE");
        const rpc = yield* connectWsRpc(paired.url);

        // 4. Ready: the config snapshot names the descriptor's environment.
        const config = yield* first(rpc[WS_METHODS.subscribeServerConfig]({}));
        assert.strictEqual(config.type, "snapshot");
        if (config.type !== "snapshot") return;
        assert.strictEqual(config.config.environment.environmentId, descriptor.environmentId);
        assert.deepStrictEqual(config.config.environment, descriptor);

        // Built from Mend's catalog, read as the person who paired.
        const token = mend.claims[0]?.token;
        assert.deepStrictEqual(mend.modelReads, [`Bearer ${token}`]);
        const providers = config.config.providers;
        assert.deepStrictEqual(
          providers.map((provider) => [provider.instanceId, provider.driver]),
          [
            ["claudeAgent", "claudeAgent"],
            ["codex", "codex"],
          ],
        );
        for (const provider of providers) {
          assert.isTrue(provider.requiresNewThreadForModelChange);
          assert.isFalse(provider.supportsConversationRollback);
          assert.isFalse(provider.showInteractionModeToggle);
          assert.deepStrictEqual(provider.supportedRuntimeModes, [
            "full-access",
            "approval-required",
          ]);
          assert.deepStrictEqual(provider.setup, { canAuthenticate: false, canInstall: false });
        }
        const codex = providers.find((provider) => provider.driver === "codex");
        assert.deepStrictEqual(
          codex?.models.map((model) => [model.slug, model.isDefault === true]),
          [
            ["gpt-6.1-sol", true],
            ["gpt-5.5", false],
          ],
        );
        const gpt55 = codex?.models.find((model) => model.slug === "gpt-5.5");
        const efforts = gpt55?.capabilities?.optionDescriptors?.find(
          (option) => option.id === "reasoningEffort",
        );
        assert.deepStrictEqual(
          efforts?.type === "select" ? efforts.options.map((option) => option.id) : [],
          ["low", "medium", "high", "xhigh"],
        );
        const claude = providers.find((provider) => provider.driver === "claudeAgent");
        assert.isUndefined(
          claude?.models[0]?.capabilities?.optionDescriptors?.find(
            (option) => option.id === "serviceTier",
          ),
        );

        // The probe a client falls back to without the probe capability.
        const again = yield* rpc[WS_METHODS.serverGetConfig]({});
        assert.strictEqual(again.environment.environmentId, descriptor.environmentId);
        assert.deepStrictEqual(yield* rpc[WS_METHODS.serverProbe]({}), {});

        // The lifecycle welcome: nothing to bootstrap.
        const lifecycle = yield* first(rpc[WS_METHODS.subscribeServerLifecycle]({}));
        assert.strictEqual(lifecycle.type, "welcome");
        if (lifecycle.type !== "welcome") return;
        assert.strictEqual(lifecycle.payload.bootstrapStatus, "complete");
        assert.strictEqual(lifecycle.payload.environment.environmentId, descriptor.environmentId);

        // The shell: empty, then the catch-up marker the client asked for.
        const shell = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({
          requestCompletionMarker: true,
        }).pipe(Stream.take(2), Stream.runCollect, Effect.timeout("5 seconds"));
        // Its sequence is where the hub's reservation starts, which the clock seeds.
        const opened = Array.from(shell);
        const sequenceOf = opened[0]?.kind === "snapshot" ? opened[0].snapshot.snapshotSequence : 0;
        assert.deepStrictEqual(opened, [
          { kind: "snapshot", snapshot: { ...EMPTY_SHELL_SNAPSHOT, snapshotSequence: sequenceOf } },
          { kind: "synchronized" },
        ]);

        // And the shell stays open: nothing more arrives, and the subscription has not ended.
        const quiet = yield* rpc[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}).pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.timeoutOption("300 millis"),
        );
        assert.isTrue(Option.isNone(quiet));

        // The same shell over HTTP, as a client loads it before subscribing.
        const viaHttp = yield* client.orchestration.shellSnapshot({
          headers: {
            authorization: `Bearer ${paired.access.access_token}`,
            [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
          },
        });
        assert.deepStrictEqual(viaHttp, { ...EMPTY_SHELL_SNAPSHOT, snapshotSequence: sequenceOf });
      }),
    ),
  );

  it.live("answers 426 without the orchestration protocol, as t3code does", () =>
    withGateway(() =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        for (const protocol of [null, "1"]) {
          const url = new URL(yield* socketUrl(null, protocol));
          const response = yield* http.get(`${url.pathname}${url.search}`);
          assert.strictEqual(response.status, 426);
          assert.deepStrictEqual(yield* response.json, {
            code: "orchestration_protocol_incompatible",
            message: "Update this client to one that supports orchestration protocol 2.",
            orchestrationProtocolVersion: 2,
          });
        }
      }),
    ),
  );

  it.live("spends a ticket once, and refuses a socket without one", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const paired = yield* pairAndTicket(mend, "ONETICKET");
        const rpc = yield* connectWsRpc(paired.url);
        assert.deepStrictEqual(yield* rpc[WS_METHODS.serverProbe]({}), {});

        const http = yield* HttpClient.HttpClient;
        const decode = Schema.decodeUnknownEffect(EnvironmentAuthInvalidError);
        const spentUrl = new URL(paired.url);
        const spent = yield* http.get(`${spentUrl.pathname}${spentUrl.search}`);
        assert.strictEqual(spent.status, 401);
        assert.strictEqual((yield* decode(yield* spent.json)).reason, "invalid_credential");

        const noneUrl = new URL(yield* socketUrl(null));
        const none = yield* http.get(`${noneUrl.pathname}${noneUrl.search}`);
        assert.strictEqual(none.status, 401);
        assert.strictEqual((yield* decode(yield* none.json)).reason, "missing_credential");
      }),
    ),
  );

  it.live("refuses the config with t3code's typed errors when Mend cannot answer", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        const paired = yield* pairAndTicket(mend, "MENDDOWN");
        const rpc = yield* connectWsRpc(paired.url);

        // Mend unreachable: a settings error, which the client treats as transient.
        mend.setModelsDown(true);
        const down = yield* Effect.exit(rpc[WS_METHODS.serverGetConfig]({}));
        assert.isTrue(Exit.isFailure(down));
        if (Exit.isFailure(down)) {
          const error = Cause.findErrorOption(down.cause);
          assert.strictEqual(Option.getOrUndefined(error)?._tag, "ServerSettingsError");
          assert.isFalse(Cause.hasDies(down.cause));
        }

        // The device revoked in Mend: t3code's authorization error, which blocks the connection;
        // the 401 refuses the token, so the socket closes and the bearer gets no new ticket.
        mend.setModelsDown(false);
        mend.revoke(mend.claims[0]?.token ?? "");
        const revoked = yield* Effect.exit(
          first(rpc[WS_METHODS.subscribeServerConfig]({})).pipe(Effect.asVoid),
        );
        assert.isTrue(Exit.isFailure(revoked));
        if (Exit.isFailure(revoked)) {
          const error = Cause.findErrorOption(revoked.cause);
          assert.strictEqual(Option.getOrUndefined(error)?._tag, "EnvironmentAuthorizationError");
          assert.isFalse(Cause.hasDies(revoked.cause));
        }
        const again = yield* Effect.exit(
          paired.client.auth.webSocketTicket({ headers: bearer(paired.access.access_token) }),
        );
        assert.isTrue(Exit.isFailure(again));
      }),
    ),
  );
});
