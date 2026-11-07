import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AuthSessionId, type AuthEnvironmentScope } from "@mend/t3-contracts";
import { Effect, Option } from "effect";

import { GRANTED_SCOPES } from "../src/auth.ts";
import { openGatewayState } from "../src/state.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { testBearerSession } from "./support/stubs.ts";

describe("usage grants", () => {
  it.effect(
    "widens existing standard grants once and preserves intentionally narrower grants",
    () =>
      Effect.gen(function* () {
        const path = join(mkdtempSync(join(tmpdir(), "t3-usage-grants-")), "state.sqlite");
        const prior = GRANTED_SCOPES.filter((scope) => scope !== "diagnostics:read");
        const grants: ReadonlyArray<readonly [string, ReadonlyArray<AuthEnvironmentScope>]> = [
          ["standard", prior],
          ["reordered", prior.toReversed()],
          ["read-only", ["orchestration:read"]],
          ...prior.map((omitted): readonly [string, ReadonlyArray<AuthEnvironmentScope>] => [
            `without-${omitted}`,
            prior.filter((scope) => scope !== omitted),
          ]),
          ["already", GRANTED_SCOPES],
        ];
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* openGatewayState(path);
            for (const [id, scopes] of grants) {
              yield* state.insertSession({
                ...testBearerSession,
                sessionId: AuthSessionId.make(id),
                tokenHash: `hash-${id}`,
                scopes,
              });
            }
          }),
        );
        // Replay the appended data-only widening against grants stored by the previous build.
        const before = new DatabaseSync(path);
        assert.deepStrictEqual(
          before
            .prepare(
              "SELECT name FROM sqlite_schema WHERE name IN ('thread_pull_requests', 'next_speeds') ORDER BY name",
            )
            .all()
            .map((table) => table["name"]),
          ["next_speeds", "thread_pull_requests"],
        );
        const row = before.prepare("PRAGMA user_version").get();
        const version = row?.["user_version"];
        if (typeof version !== "number") throw new Error("Missing schema version");
        before.exec(`PRAGMA user_version = ${version - 1}`);
        before.close();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* openGatewayState(path);
            for (const [id, original] of grants) {
              const stored = Option.getOrThrow(
                yield* state.findSessionById(AuthSessionId.make(id)),
              );
              assert.deepStrictEqual(
                stored.scopes,
                id === "standard" || id === "reordered"
                  ? [...original, "diagnostics:read"]
                  : original,
              );
            }
            yield* state.insertSession({
              ...testBearerSession,
              sessionId: AuthSessionId.make("later-custom"),
              tokenHash: "later-custom",
              scopes: prior,
            });
          }),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* openGatewayState(path);
            const stored = Option.getOrThrow(
              yield* state.findSessionById(AuthSessionId.make("later-custom")),
            );
            assert.deepStrictEqual(stored.scopes, prior);
          }),
        );
      }),
  );
});
