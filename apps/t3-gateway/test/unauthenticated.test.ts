import { assert, describe, it } from "@effect/vitest";
import { EnvironmentAuthInvalidError, EnvironmentScopeRequiredError } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import { startFakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, pairedClient, PERSON, t3Client } from "./support/gateway.ts";

/** What the wire carries for a refusal, decoded with t3code's own error schema. */
const refusal = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(request);
    const body = yield* response.json;
    return { status: response.status, headers: response.headers, body };
  });

const decodeAuthInvalid = Schema.decodeUnknownEffect(EnvironmentAuthInvalidError);

describe("unauthenticated requests", () => {
  it.live("are refused at the ticket route with t3code's 401 body", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const missing = yield* refusal(HttpClientRequest.post("/api/auth/websocket-ticket"));
        assert.strictEqual(missing.status, 401);
        const missingError = yield* decodeAuthInvalid(missing.body);
        assert.strictEqual(missingError.code, "auth_invalid");
        assert.strictEqual(missingError.reason, "missing_credential");
        assert.isTrue(missingError.traceId.length > 0);

        const unknown = yield* refusal(
          HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
            HttpClientRequest.bearerToken("not-a-gateway-bearer"),
          ),
        );
        assert.strictEqual(unknown.status, 401);
        assert.strictEqual((yield* decodeAuthInvalid(unknown.body)).reason, "invalid_credential");

        const dpop = yield* refusal(
          HttpClientRequest.post("/api/auth/websocket-ticket").pipe(
            HttpClientRequest.setHeader("authorization", "DPoP some-token"),
          ),
        );
        assert.strictEqual(dpop.status, 401);
        const dpopError = yield* decodeAuthInvalid(dpop.body);
        assert.strictEqual(dpopError.reason, "invalid_credential");
        assert.strictEqual(dpopError.dpopFailureReason, "invalid_proof");
        assert.strictEqual(dpop.headers["www-authenticate"], "DPoP");

        // The typed client sees the same error t3code's client-runtime matches on.
        const client = yield* t3Client;
        const typed = yield* Effect.flip(client.auth.webSocketTicket({ headers: {} }));
        assert.instanceOf(typed, EnvironmentAuthInvalidError);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("read an unauthenticated session state, as t3code answers", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const client = yield* t3Client;
        const anonymous = yield* client.auth.session({ headers: {} });
        assert.isFalse(anonymous.authenticated);
        assert.deepStrictEqual(anonymous.auth.bootstrapMethods, ["one-time-token"]);
        assert.deepStrictEqual(anonymous.auth.sessionMethods, ["bearer-access-token"]);
        assert.strictEqual(anonymous.auth.policy, "loopback-browser");

        const unknown = yield* client.auth.session({ headers: bearer("not-a-gateway-bearer") });
        assert.isFalse(unknown.authenticated);
        // A bearer the gateway never issued is not worth a call to Mend.
        assert.deepStrictEqual(mend.deviceChecks, []);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );

  it.live("refuse a browser session: the gateway offers bearer tokens only", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      yield* Effect.gen(function* () {
        const client = yield* t3Client;
        const refused = yield* Effect.flip(
          client.auth.browserSession({ payload: { credential: "ABCDEFGH" } }),
        );
        assert.instanceOf(refused, EnvironmentAuthInvalidError);
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});

describe("paired clients", () => {
  it.live("are refused access administration with t3code's scope error", () =>
    Effect.gen(function* () {
      const mend = yield* startFakeMend;
      mend.addPairingCode("ADMINNOT", PERSON);
      yield* Effect.gen(function* () {
        const { client, access } = yield* pairedClient("ADMINNOT");
        const headers = bearer(access.access_token);

        const links = yield* Effect.flip(client.auth.pairingLinks({ headers }));
        assert.instanceOf(links, EnvironmentScopeRequiredError);
        assert.strictEqual(
          links instanceof EnvironmentScopeRequiredError && links.requiredScope,
          "access:read",
        );
        const mint = yield* Effect.flip(client.auth.pairingCredential({ headers, payload: {} }));
        assert.instanceOf(mint, EnvironmentScopeRequiredError);
        assert.strictEqual(
          mint instanceof EnvironmentScopeRequiredError && mint.requiredScope,
          "access:write",
        );

        const raw = yield* refusal(
          HttpClientRequest.get("/api/auth/clients").pipe(
            HttpClientRequest.bearerToken(access.access_token),
          ),
        );
        assert.strictEqual(raw.status, 403);
        const scopeError = yield* Schema.decodeUnknownEffect(EnvironmentScopeRequiredError)(
          raw.body,
        );
        assert.strictEqual(scopeError.code, "insufficient_scope");
      }).pipe(Effect.provide(gatewayTestLayer(mend.url)));
    }),
  );
});
