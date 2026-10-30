import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { MendApi } from "./index.ts";

const SECRET_PARAM = /^:\w*(token|ticket|password|code)$/i;

const CLI_AUTH_USER_CODE =
  "the short code a person reads off `mend login` and types into the approve page: it names a " +
  "request only a signed-in account can approve, and the CLI's secret device code rides a body";
const RELEASED_APPS_UNREGISTER =
  "apps released before 0.37 still unpair here; the handler ignores the token, and the API keeps " +
  "every /api/devices/ URL out of its request log and traces, 404s included";
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["/api/me/cli-auth/:code", CLI_AUTH_USER_CODE],
  ["/api/me/cli-auth/:code/approve", CLI_AUTH_USER_CODE],
  ["/api/me/cli-auth/:code/deny", CLI_AUTH_USER_CODE],
  ["/api/devices/:token", RELEASED_APPS_UNREGISTER],
]);

const secretsIn = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ReadonlyArray<string> => {
  const secretPaths: Array<string> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const named = endpoint.path.split("/").some((segment) => SECRET_PARAM.test(segment));
      if (named && !ALLOWED.has(endpoint.path)) {
        secretPaths.push(`${endpoint.method} ${endpoint.path}`);
      }
    },
  });
  return secretPaths;
};

describe("endpoint URLs", () => {
  it("carry no secret in a path parameter or a query field", () => {
    expect(
      secretsIn(MendApi),
      "a URL reaches request logs, spans and edge access logs: send the secret in a body",
    ).toEqual([]);
  });

  it("count a secret however the router spells its parameter, and in a query field", () => {
    const spellings = HttpApi.make("spellings").add(
      HttpApiGroup.make("spellings")
        .add(HttpApiEndpoint.get("optional", "/optional/:token?"))
        .add(HttpApiEndpoint.get("pattern", "/pattern/:token([a-z]+)"))
        .add(HttpApiEndpoint.get("joined", "/joined/:id-:token"))
        .add(HttpApiEndpoint.get("secret", "/secrets/:secret"))
        .add(HttpApiEndpoint.get("apiKey", "/keys/:apiKey"))
        .add(HttpApiEndpoint.get("credential", "/credentials/:credential"))
        .add(HttpApiEndpoint.get("bearer", "/bearers/:bearer"))
        .add(HttpApiEndpoint.get("query", "/query", { query: { token: Schema.String } }))
        .add(HttpApiEndpoint.get("plain", "/plain/:id", { query: { cursor: Schema.String } })),
    );
    expect(secretsIn(spellings)).toEqual([
      "GET /optional/:token?",
      "GET /pattern/:token([a-z]+)",
      "GET /joined/:id-:token",
      "GET /secrets/:secret",
      "GET /keys/:apiKey",
      "GET /credentials/:credential",
      "GET /bearers/:bearer",
      "GET /query",
    ]);
  });
});
