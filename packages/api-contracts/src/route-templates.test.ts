import { HttpApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { MendApi } from "./index.ts";
import { MEND_API_ROUTE_TEMPLATES } from "./route-templates.ts";

describe("the API's route templates", () => {
  it("are every path the contract serves, once each, in order", () => {
    const paths = new Set<string>();
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ endpoint }) => {
        paths.add(endpoint.path);
      },
    });
    expect(
      MEND_API_ROUTE_TEMPLATES,
      "route-templates.ts lists each endpoint path of MendApi, sorted: add or remove the path you changed",
    ).toEqual([...paths].toSorted());
  });
});
