import { CREDENTIAL_QUERY_PARAMETERS, SECRET_SEGMENT_PREFIXES } from "@mend/network";
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

/**
 * A secret may be a path's segment only right after a path the edge redacts the next segment of.
 * The API logs and traces a route's template, never the segment itself.
 */
const redactedAtTheEdge = (path: string, name: string) =>
  SECRET_SEGMENT_PREFIXES.some(
    (prefix) => path === `${prefix}/:${name}` || path.startsWith(`${prefix}/:${name}/`),
  );

const secretsIn = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ReadonlyArray<string> => {
  const secretPaths: Array<string> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const exposed = [
        ...pathParameterNames(endpoint.path).filter(
          (name) => namesSecret(name) && !redactedAtTheEdge(endpoint.path, name),
        ),
        ...queryFieldNames(endpoint.query).filter(namesSecret),
      ];
      if (exposed.length > 0) secretPaths.push(`${endpoint.method} ${endpoint.path}`);
    },
  });
  return secretPaths;
};

describe("endpoint URLs", () => {
  it("carry no secret in a path parameter or a query field", () => {
    expect(
      secretsIn(MendApi),
      "a URL reaches edge and proxy access logs: send the secret in a body",
    ).toEqual([]);
  });

  it("count a secret however the router spells its parameter, in a query field, and past the segment the edge redacts", () => {
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
        .add(HttpApiEndpoint.get("plain", "/plain/:id", { query: { cursor: Schema.String } }))
        .add(HttpApiEndpoint.get("redacted", "/api/devices/:token"))
        .add(HttpApiEndpoint.post("redactedThen", "/api/me/cli-auth/:code/approve"))
        .add(HttpApiEndpoint.get("pastTheRedacted", "/api/devices/:id/:token"))
        .add(
          HttpApiEndpoint.get("redactedButQuery", "/api/devices/:token", {
            query: { code: Schema.String },
          }),
        ),
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
      "GET /api/devices/:id/:token",
      "GET /api/devices/:token",
    ]);
  });
});
