import { HttpApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { MendApi } from "./index.ts";

const SECRET_PARAM = /^:\w*(token|ticket|password|code)$/i;

const CLI_AUTH_USER_CODE =
  "the short code a person reads off `mend login` and types into the approve page: it names a " +
  "request only a signed-in account can approve, and the CLI's secret device code rides a body";
const ALLOWED: ReadonlyMap<string, string> = new Map([
  ["/api/me/cli-auth/:code", CLI_AUTH_USER_CODE],
  ["/api/me/cli-auth/:code/approve", CLI_AUTH_USER_CODE],
  ["/api/me/cli-auth/:code/deny", CLI_AUTH_USER_CODE],
]);

describe("endpoint paths", () => {
  it("carry no secret in a path parameter", () => {
    const secretPaths: Array<string> = [];
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => {
        const named = endpoint.path.split("/").some((segment) => SECRET_PARAM.test(segment));
        if (named && !ALLOWED.has(endpoint.path)) {
          secretPaths.push(`${endpoint.method} ${endpoint.path}`);
        }
      },
    });
    expect(
      secretPaths,
      "a URL path reaches request logs, spans and edge access logs: send the secret in a body",
    ).toEqual([]);
  });
});
