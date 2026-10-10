import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@mend/t3-contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { BEARER_TTL_MS } from "../src/auth.ts";
import { forwardedChain } from "../src/http.ts";
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
        // t3code's standard scopes as permissions; clients from before permissions read the
        // legacy names among them.
        assert.deepStrictEqual(session.permissions, AuthStandardClientScopes);
        assert.deepStrictEqual(session.scopes, [
          "orchestration:read",
          "orchestration:operate",
          "terminal:operate",
          "relay:read",
        ]);
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

  it.live("grants the overlap of what is asked and what it grants, as t3code does", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("KEEPCODE", PERSON);
        const client = yield* t3Client;

        // Malformed: refused before the code is claimed.
        const malformed = yield* Effect.flip(
          client.auth.token(tokenRequest("KEEPCODE", { scope: 'orchestration:read "quoted"' })),
        );
        assert.strictEqual(
          malformed._tag === "EnvironmentRequestInvalidError" && malformed.reason,
          "invalid_scope",
        );
        // Nothing grantable: refused, and the code is kept.
        const admin = yield* Effect.flip(
          client.auth.token(tokenRequest("KEEPCODE", { scope: "access:write nonsense" })),
        );
        assert.strictEqual(
          admin._tag === "EnvironmentRequestInvalidError" && admin.reason,
          "scope_not_granted",
        );
        assert.strictEqual(mend.claims.length, 0);

        // The old grants' mark alone grants nothing, as t3code answers it.
        const markOnly = yield* Effect.flip(
          client.auth.token(tokenRequest("KEEPCODE", { scope: "review:write" })),
        );
        assert.strictEqual(
          markOnly._tag === "EnvironmentRequestInvalidError" && markOnly.reason,
          "scope_not_granted",
        );

        // Names t3code lacks are dropped and admin scopes are not granted; the rest is.
        const narrow = yield* client.auth.token(
          tokenRequest("KEEPCODE", { scope: "orchestration:read access:write nonsense" }),
        );
        assert.strictEqual(narrow.scope, "orchestration:read");
      }),
    ),
  );

  it.live("pairs a client from before granular permissions with today's standard grant", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("OLDCLIENT", PERSON);
        const client = yield* t3Client;
        // What a client of the previous pin asks for: its standard scopes.
        const access = yield* client.auth.token(
          tokenRequest("OLDCLIENT", {
            scope:
              "orchestration:read orchestration:operate terminal:operate review:write relay:read",
          }),
        );
        assert.strictEqual(
          access.scope,
          "orchestration:read orchestration:operate terminal:operate review:write relay:read",
        );
        const session = yield* client.auth.session({ headers: bearer(access.access_token) });
        for (const scope of AuthStandardClientScopes)
          assert.include(session.permissions ?? [], scope);
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

  it.live("tells Mend which client a claim came from, so each client has its own limit", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("DIRECT01", PERSON);
        mend.addPairingCode("PROXIED1", PERSON);
        const client = yield* t3Client;
        yield* client.auth.token(tokenRequest("DIRECT01"));

        // Behind a proxy of its own, the client's chain goes on and the gateway appends its hop.
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.execute(
          HttpClientRequest.post("/oauth/token").pipe(
            HttpClientRequest.setHeader("x-forwarded-for", "203.0.113.7"),
            HttpClientRequest.bodyUrlParams(tokenRequest("PROXIED1").payload),
          ),
        );
        assert.strictEqual(response.status, 200);

        const [direct, proxied] = mend.pairForwardedFor;
        assert.match(direct ?? "", /^(::ffff:)?127\.0\.0\.1$/);
        assert.match(proxied ?? "", /^203\.0\.113\.7, (::ffff:)?127\.0\.0\.1$/);
      }),
    ),
  );

  it.live("tells a rate-limited client it is rate limited, not that its code is wrong", () =>
    withGateway((mend) =>
      Effect.gen(function* () {
        mend.addPairingCode("GOODCODE", PERSON);
        mend.setPairingRateLimited(true);

        const http = yield* HttpClient.HttpClient;
        const limited = yield* http.execute(
          HttpClientRequest.post("/oauth/token").pipe(
            HttpClientRequest.bodyUrlParams(tokenRequest("GOODCODE").payload),
          ),
        );
        assert.strictEqual(limited.status, 429);
        // Mend's own wait, carried through.
        assert.strictEqual(limited.headers["retry-after"], "42");
        assert.strictEqual(limited.headers["cache-control"], "no-store");
        const body = yield* limited.json;
        assert.deepInclude(body, { error: "rate_limited" });
        assert.match(JSON.stringify(body), /try again in 42 s/);
        assert.strictEqual(mend.claims.length, 0);

        // The code was not spent: once Mend lets the address through, it pairs.
        mend.setPairingRateLimited(false);
        const client = yield* t3Client;
        const access = yield* client.auth.token(tokenRequest("GOODCODE"));
        assert.strictEqual(access.token_type, "Bearer");
      }),
    ),
  );
});

describe("the forwarded chain a claim carries", () => {
  it("appends the address the gateway saw, and never passes a client's chain alone", () => {
    assert.strictEqual(forwardedChain(undefined, "198.51.100.4"), "198.51.100.4");
    assert.strictEqual(forwardedChain(" ", "198.51.100.4"), "198.51.100.4");
    assert.strictEqual(
      forwardedChain("203.0.113.7, 10.0.0.2", "127.0.0.1"),
      "203.0.113.7, 10.0.0.2, 127.0.0.1",
    );
    assert.isUndefined(forwardedChain("203.0.113.7", undefined));
  });
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
