import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { BEARER_TTL_MS } from "../src/auth.ts";
import { startFakeMend, type FakeMend } from "./support/fake-mend.ts";
import { bearer, gatewayTestLayer, PERSON, t3Client, tokenRequest } from "./support/gateway.ts";

const withGateway = <A, E, R>(test: (mend: FakeMend) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mend = yield* startFakeMend;
    return yield* test(mend).pipe(Effect.provide(gatewayTestLayer(mend.url)));
  });

describe("POST /oauth/token", () => {
  it.live("claims the Mend pairing code and answers a bearer for the person", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("ABCD-EFGH", PERSON);
        const client = yield* t3Client;

        const access = yield* client.auth.token(
          tokenRequest("ABCD-EFGH", {
            client_label: "Ada's MacBook",
            client_device_type: "desktop",
            client_os: "macOS",
          }),
        );
        assert.strictEqual(access.token_type, "Bearer");
        assert.strictEqual(
          access.issued_token_type,
          "urn:ietf:params:oauth:token-type:access_token",
        );
        assert.strictEqual(access.scope, AuthStandardClientScopes.join(" "));
        assert.strictEqual(access.expires_in, BEARER_TTL_MS / 1000);

        // Mend saw one claim, named for t3code and the client, as a desktop.
        assert.strictEqual(mend.claims.length, 1);
        const claim = mend.claims[0];
        assert.strictEqual(claim?.code, "ABCDEFGH");
        assert.strictEqual(claim?.name, "t3code · Ada's MacBook");
        assert.strictEqual(claim?.platform, "desktop");
        // The bearer is the gateway's own; Mend's device token never reaches the client.
        assert.notStrictEqual(access.access_token, claim?.token);

        // The session is backed by Mend, called with the device token Mend returned.
        const session = yield* client.auth.session({ headers: bearer(access.access_token) });
        assert.isTrue(session.authenticated);
        assert.deepStrictEqual(session.scopes, AuthStandardClientScopes);
        assert.strictEqual(session.sessionMethod, "bearer-access-token");
        assert.isDefined(session.expiresAt);
        assert.deepStrictEqual(mend.deviceChecks, [`Bearer ${claim?.token}`]);

        // The bearer opens the authenticated routes.
        const ticket = yield* client.auth.webSocketTicket({ headers: bearer(access.access_token) });
        assert.isTrue(ticket.ticket.length > 0);
      }),
    ),
  );

  it.live("answers no-store, like t3code's credential responses", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("NOSTORE2", PERSON);
        const http = yield* HttpClient.HttpClient;
        const request = tokenRequest("NOSTORE2").payload;
        const response = yield* http.execute(
          HttpClientRequest.post("/oauth/token").pipe(HttpClientRequest.bodyUrlParams(request)),
        );
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers["cache-control"], "no-store");
        assert.strictEqual(response.headers["pragma"], "no-cache");
      }),
    ),
  );

  it.live("refuses a code Mend does not know, or one already claimed", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("ONCEONLY", PERSON);
        const client = yield* t3Client;

        const unknown = yield* Effect.flip(client.auth.token(tokenRequest("NOPE-NOPE")));
        assert.strictEqual(unknown._tag, "EnvironmentAuthInvalidError");
        assert.strictEqual(
          unknown._tag === "EnvironmentAuthInvalidError" && unknown.reason,
          "invalid_credential",
        );

        yield* client.auth.token(tokenRequest("ONCEONLY"));
        const spent = yield* Effect.flip(client.auth.token(tokenRequest("ONCEONLY")));
        assert.strictEqual(spent._tag, "EnvironmentAuthInvalidError");
        assert.strictEqual(mend.claims.length, 1);
      }),
    ),
  );

  it.live("refuses scopes it does not grant before spending the code", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("KEEPCODE", PERSON);
        const client = yield* t3Client;

        const malformed = yield* Effect.flip(
          client.auth.token(tokenRequest("KEEPCODE", { scope: "orchestration:read nonsense" })),
        );
        assert.strictEqual(malformed._tag, "EnvironmentRequestInvalidError");
        assert.strictEqual(
          malformed._tag === "EnvironmentRequestInvalidError" && malformed.reason,
          "invalid_scope",
        );

        const admin = yield* Effect.flip(
          client.auth.token(tokenRequest("KEEPCODE", { scope: "orchestration:read access:write" })),
        );
        assert.strictEqual(admin._tag, "EnvironmentRequestInvalidError");
        assert.strictEqual(
          admin._tag === "EnvironmentRequestInvalidError" && admin.reason,
          "scope_not_granted",
        );
        assert.strictEqual(mend.claims.length, 0);

        // A narrower request is granted as asked, and the code still works.
        const narrow = yield* client.auth.token(
          tokenRequest("KEEPCODE", { scope: "orchestration:read" }),
        );
        assert.strictEqual(narrow.scope, "orchestration:read");
      }),
    ),
  );

  it.live("answers t3code's internal error when Mend does not answer", () =>
    Effect.gen(function* () {
      // Nothing listens on port 9 of loopback.
      const failure = yield* Effect.gen(function* () {
        const client = yield* t3Client;
        return yield* Effect.flip(client.auth.token(tokenRequest("ABCDEFGH")));
      }).pipe(Effect.provide(gatewayTestLayer(new URL("http://127.0.0.1:9"))));
      assert.strictEqual(failure._tag, "EnvironmentInternalError");
      assert.strictEqual(
        failure._tag === "EnvironmentInternalError" && failure.reason,
        "access_token_issuance_failed",
      );
    }),
  );
});

describe("GET /api/auth/session", () => {
  it.live("ends the bearer once Mend revokes the device", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("REVOKEME", PERSON);
        const client = yield* t3Client;
        const access = yield* client.auth.token(tokenRequest("REVOKEME"));
        const token = mend.claims[0]?.token ?? "";

        mend.revoke(token);
        const session = yield* client.auth.session({ headers: bearer(access.access_token) });
        assert.isFalse(session.authenticated);
        assert.isUndefined(session.scopes);

        const refused = yield* Effect.flip(
          client.auth.webSocketTicket({ headers: bearer(access.access_token) }),
        );
        assert.strictEqual(refused._tag, "EnvironmentAuthInvalidError");
      }),
    ),
  );
});
