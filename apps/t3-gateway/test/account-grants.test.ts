import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { AuthSessionId } from "@mend/t3-contracts";
import { Effect, Option } from "effect";

import { GRANTED_SCOPES } from "../src/auth.ts";
import { openGatewayState } from "../src/state.ts";
import { assert, describe, it } from "./support/effect-vitest.ts";
import { testBearerSession } from "./support/stubs.ts";

describe("account-control grants", () => {
  it.effect(
    "widens the complete preceding standard grant once, preserving every narrower grant",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync(join(tmpdir(), "t3-account-grants-"))),
            (path) => Effect.sync(() => rmSync(path, { recursive: true, force: true })),
          );
          const path = join(directory, "state.sqlite");
          const prior = GRANTED_SCOPES.filter((scope) => scope !== "providers:manage");
          const samples = [
            { id: "standard", scopes: prior },
            ...prior.map((omitted, index) => ({
              id: `narrow-${index}`,
              scopes: prior.filter((scope) => scope !== omitted),
            })),
          ];
          yield* Effect.scoped(
            Effect.gen(function* () {
              const state = yield* openGatewayState(path);
              for (const sample of samples)
                yield* state.insertSession({
                  ...testBearerSession,
                  sessionId: AuthSessionId.make(sample.id),
                  tokenHash: sample.id,
                  scopes: sample.scopes,
                });
            }),
          );
          const database = new DatabaseSync(path);
          const version = database.prepare("PRAGMA user_version").get()?.["user_version"];
          if (typeof version !== "number") return assert.fail("Missing schema version");
          database.exec(`PRAGMA user_version = ${version - 1}`);
          database.close();
          for (let reopen = 0; reopen < 2; reopen++)
            yield* Effect.scoped(
              Effect.gen(function* () {
                const state = yield* openGatewayState(path);
                for (const sample of samples) {
                  const stored = Option.getOrThrow(
                    yield* state.findSessionById(AuthSessionId.make(sample.id)),
                  );
                  assert.deepStrictEqual(
                    stored.scopes,
                    sample.id === "standard" ? [...prior, "providers:manage"] : sample.scopes,
                  );
                }
                if (reopen === 0)
                  yield* state.insertSession({
                    ...testBearerSession,
                    sessionId: AuthSessionId.make("later-narrow"),
                    tokenHash: "later-narrow",
                    scopes: prior,
                  });
                else
                  assert.deepStrictEqual(
                    Option.getOrThrow(
                      yield* state.findSessionById(AuthSessionId.make("later-narrow")),
                    ).scopes,
                    prior,
                  );
              }),
            );
        }),
      ),
  );
});
