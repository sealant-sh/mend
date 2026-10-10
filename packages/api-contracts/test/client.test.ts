import { Schema } from "effect";
import * as SchemaAST from "effect/SchemaAST";
import { HttpApi } from "effect/unstable/httpapi";
import { describe, expect, it } from "vitest";

import { MendApi } from "../src/api.ts";
import { errorStatusByTag } from "../src/client.ts";
import { AdoptProject } from "../src/workbench-views.ts";

describe("AdoptProject", () => {
  const decode = Schema.decodeUnknownSync(AdoptProject);

  it("accepts GitHub selection URLs and SSH clone spellings", () => {
    expect(decode({ name: "mend", source: "https://github.com/sealant-sh/Mend" }).source).toBe(
      "https://github.com/sealant-sh/Mend",
    );
    expect(decode({ name: "mend", source: "git@github.com:sealant-sh/Mend.git" }).source).toBe(
      "git@github.com:sealant-sh/Mend.git",
    );
  });

  it.each([
    "/srv/repos/mend",
    "https://oauth2:TOKEN@github.com/sealant-sh/Mend.git",
    "http://user:se'cret@github.com/sealant-sh/Mend.git",
  ])(
    "leaves %s to the route, which refuses it with its reason rather than a bare 400",
    (source) => {
      expect(decode({ name: "mend", source }).source).toBe(source);
    },
  );
});

describe("errorStatusByTag", () => {
  it("derives every declared error's status from the contract itself", () => {
    // Spot-check the statuses transports depend on; the map is built by
    // walking MendApi, so a contract change moves these without code edits.
    // These assertions also pin the "~sentinels" annotation the walk reads —
    // if an effect upgrade renames it, the map comes back empty and this
    // fails before any transport misroutes an error.
    expect(errorStatusByTag.get("Unauthorized")).toBe(401);
    expect(errorStatusByTag.get("NotFound")).toBe(404);
    expect(errorStatusByTag.get("EnvironmentRejected")).toBe(422);
    expect(errorStatusByTag.get("EnvironmentStaleWrite")).toBe(409);
    expect(errorStatusByTag.get("PairingRateLimited")).toBe(429);
    expect(errorStatusByTag.size).toBeGreaterThanOrEqual(10);
  });

  it("no error tag is declared with two different statuses anywhere in the API", () => {
    // The map keeps the first status it sees per tag; that is only sound
    // while the contract never declares one tag at two statuses. Walk the
    // API and prove it.
    const seen = new Map<string, Set<number>>();
    const tagOf = SchemaAST.resolveAt("~sentinels");
    HttpApi.reflect(MendApi, {
      onGroup: () => {},
      onEndpoint: ({ errors }) => {
        for (const [status, schemas] of errors) {
          for (const schema of schemas) {
            const sentinels = tagOf(schema.ast) as
              | ReadonlyArray<{ readonly key: string; readonly literal: unknown }>
              | undefined;
            const tag = sentinels?.find((sentinel) => sentinel.key === "_tag")?.literal;
            if (typeof tag !== "string") continue;
            const statuses = seen.get(tag) ?? new Set<number>();
            statuses.add(status);
            seen.set(tag, statuses);
          }
        }
      },
    });
    const conflicts = [...seen].filter(([, statuses]) => statuses.size > 1);
    expect(conflicts).toEqual([]);
  });
});
