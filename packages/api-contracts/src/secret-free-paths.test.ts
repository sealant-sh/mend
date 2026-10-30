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

interface PathParameter {
  readonly name: string;
  readonly colonIndex: number;
  readonly wholeSegment: boolean;
}

/**
 * Parameters as Effect's router reads a path: `::` is a literal colon, a name ends at `/`, `-`,
 * `.`, `(` or an optional's `?`, and a `(…)` pattern after it is not a name.
 */
const pathParameters = (path: string): ReadonlyArray<PathParameter> => {
  const parameters: Array<PathParameter> = [];
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
      const end = at + 1 + name.length;
      parameters.push({
        name,
        colonIndex: at,
        wholeSegment: path[at - 1] === "/" && (end === path.length || path[end] === "/"),
      });
      at = end - 1;
    }
  }
  return parameters;
};

const queryFieldNames = (query: Schema.Top | undefined): ReadonlyArray<string> => {
  if (query === undefined) return [];
  const ast = SchemaAST.toEncoded(query.ast);
  return SchemaAST.isObjects(ast) ? ast.propertySignatures.map(({ name }) => String(name)) : [];
};

const REDACTED_API_SEGMENTS: ReadonlyMap<string, string> = new Map([
  [
    "/api/me/cli-auth",
    "the short code a person reads off `mend login` and types into the approve page; the CLI's " +
      "secret device code rides a body",
  ],
  ["/api/devices", "apps released before 0.37 still unpair here; the handler ignores the token"],
  [
    "/api/auth/reset-password",
    "Better Auth's own reset link, which the API answers 404 before Better Auth reads it",
  ],
]);

const redactedAtTheEdge = (path: string, parameter: PathParameter) =>
  parameter.wholeSegment &&
  [...REDACTED_API_SEGMENTS.keys()].some(
    (prefix) => path.slice(0, parameter.colonIndex) === `${prefix}/`,
  );

const secretsIn = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): ReadonlyArray<string> => {
  const secretPaths: Array<string> = [];
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      const exposed = [
        ...pathParameters(endpoint.path).filter(
          (parameter) =>
            namesSecret(parameter.name) && !redactedAtTheEdge(endpoint.path, parameter),
        ),
        ...queryFieldNames(endpoint.query).filter(namesSecret),
      ];
      if (exposed.length > 0) secretPaths.push(`${endpoint.method} ${endpoint.path}`);
    },
  });
  return secretPaths;
};

describe("endpoint URLs", () => {
  it("are allowed a secret segment only after an API path the edge redacts", () => {
    expect([...REDACTED_API_SEGMENTS.keys()]).toEqual(
      SECRET_SEGMENT_PREFIXES.filter((prefix) => prefix.startsWith("/api/")),
    );
  });

  it("carry no secret in a path parameter or a query field", () => {
    expect(
      secretsIn(MendApi),
      "a URL reaches edge and proxy access logs: send the secret in a body",
    ).toEqual([]);
  });

  it("count a secret however the router spells its parameter, in a query field, past the segment the edge redacts, and after a page's path", () => {
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
        )
        .add(HttpApiEndpoint.get("repeated", "/api/devices/:token/:token"))
        .add(HttpApiEndpoint.get("linkPage", "/join/:token")),
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
      "GET /api/devices/:token/:token",
      "GET /join/:token",
    ]);
  });
});
