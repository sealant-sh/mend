import { CREDENTIAL_QUERY_PARAMETERS } from "@mend/network";
import { Schema, SchemaAST } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { MendApi } from "./index.ts";

const SECRET_NAMES = [
  ...CREDENTIAL_QUERY_PARAMETERS,
  "password",
  "secret",
  "key",
  "credential",
  "bearer",
];
const namesSecret = (name: string) =>
  SECRET_NAMES.some((secret) => name.toLowerCase().endsWith(secret));

/**
 * Parameter names as Effect's router reads a path: `::` is a literal colon, a name ends at `/`,
 * `-`, `.`, `(` or an optional's `?`, and a `(…)` pattern after it is not a name.
 */
const pathParameterNames = (path: string): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (let at = 0; at < path.length; at++) {
    if (path[at] === "(") {
      for (let depth = 1; depth > 0 && at < path.length - 1; ) {
        at++;
        if (path[at] === "\\") at++;
        else if (path[at] === "(") depth++;
        else if (path[at] === ")") depth--;
      }
    } else if (path[at] === ":" && path[at + 1] === ":") {
      at++;
    } else if (path[at] === ":") {
      const name = /^[^/\-.(?]*/.exec(path.slice(at + 1))?.[0] ?? "";
      names.push(name);
      at += name.length;
    }
  }
  return names;
};

const queryFieldNames = (query: Schema.Top | undefined): ReadonlyArray<string> => {
  if (query === undefined) return [];
  const ast = SchemaAST.toEncoded(query.ast);
  return SchemaAST.isObjects(ast) ? ast.propertySignatures.map(({ name }) => String(name)) : [];
};

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
      const named = [...pathParameterNames(endpoint.path), ...queryFieldNames(endpoint.query)].some(
        namesSecret,
      );
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
