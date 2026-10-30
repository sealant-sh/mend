import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { HandoffQuery, HandoffRefused, handoffsGroup } from "./index.ts";

describe("handoffs contract", () => {
  it("keeps every receive and terms error on its own status", () => {
    const statuses = new Map<string, ReadonlySet<number>>();
    HttpApi.reflect(HttpApi.make("handoffs").add(handoffsGroup), {
      onGroup: () => {},
      onEndpoint: ({ endpoint, errors }) => {
        statuses.set(endpoint.identifier, new Set(errors.keys()));
      },
    });
    expect(statuses.get("instanceTerms")).toEqual(new Set([401, 422]));
    expect(statuses.get("terms")).toEqual(new Set([401, 404, 422]));
    expect(statuses.get("receive")).toEqual(new Set([401, 404, 409, 422, 429]));
  });

  it("refuses a reason outside the closed set", () => {
    const decode = Schema.decodeUnknownSync(HandoffRefused);
    expect(
      decode({ _tag: "HandoffRefused", reason: "base-unknown", message: "fetch main" }).reason,
    ).toBe("base-unknown");
    expect(() => decode({ _tag: "HandoffRefused", reason: "nope", message: "x" })).toThrow();
  });

  it("takes hold only as true or false", () => {
    const query = Schema.Struct(HandoffQuery);
    expect(Schema.is(query)({ harness: "claude", hold: "true" })).toBe(true);
    expect(Schema.is(query)({ harness: "claude", hold: "yes" })).toBe(false);
  });
});
