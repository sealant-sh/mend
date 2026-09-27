import { PgClient } from "@effect/sql-pg";
import { Effect, Layer, Redacted } from "effect";
import * as Str from "effect/String";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import {
  hashSessionChannelToken,
  SessionChannelTokensRepo,
  SessionChannelTokensRepoLive,
} from "../src/repos/session-channel-tokens.ts";

/**
 * Migration 0083 and the per-launch channel tokens against Postgres (review 2026-09-28 (3) #1 and
 * #5, cross-repo decision 5), in a throwaway database: a token from before names its session as
 * its launch — what that executor's plan answered and its seal names — and a new launch adds a
 * token without rotating another's. Skips without a database; set MEND_TEST_DATABASE_URL.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_launch_identity_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({
  url: Redacted.make(scratchUrl),
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
});
const reposLayer = SessionChannelTokensRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, SessionChannelTokensRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
const LEGACY_TOKEN = "legacy-token-legacy-token-legacy-token-xyz1";

describe.skipIf(!reachable)("launch identity (0083), in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Everything before 0083, then a token and a session as they stood.
        for (const [name, migration] of ordered) {
          if (name >= "0083") break;
          yield* migration;
        }
        yield* sql`
          INSERT INTO session_channel_tokens (session_id, token_hash)
          VALUES ('s-legacy', ${hashSessionChannelToken(LEGACY_TOKEN)})`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES ('p-1', 'p', '/store/p-1/repo.git', 'main', (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES ('wt-1', 'p-1', 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        for (const [id, workspace] of [
          ["s-legacy", "ws-legacy"],
          ["s-idle", null],
        ] as const) {
          yield* sql`
            INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch,
                                        base_sha, base_ref, sealant_workspace_id)
            VALUES (${id}, 'p-1', 'wt-1', 'claude', 'wt-1', 'mend/wt-1', 'abc', 'main',
                    ${workspace})`;
        }
        for (const [name, migration] of ordered) {
          if (name >= "0083") yield* migration;
        }
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("a token from before 0083 names its session as its launch, and a session with a workspace carries it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tokens = yield* SessionChannelTokensRepo;
        const launches = yield* sql<{
          readonly id: string;
          readonly executorLaunchId: string | null;
        }>`
          SELECT id, executor_launch_id FROM agent_sessions ORDER BY id`;
        return {
          resolved: yield* tokens.resolve(LEGACY_TOKEN),
          verified: yield* tokens.verify("s-legacy", LEGACY_TOKEN),
          launches: launches.map((row) => [row.id, row.executorLaunchId]),
        };
      }),
    );
    expect(result.resolved).toEqual({ sessionId: "s-legacy", launchId: "s-legacy" });
    expect(result.verified).toBe("s-legacy");
    expect(result.launches).toEqual([
      ["s-idle", null],
      ["s-legacy", "s-legacy"],
    ]);
  });

  it("a new launch adds a token beside the others; ending a launch revokes only its own", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tokens = yield* SessionChannelTokensRepo;
        const first = yield* tokens.issue("s-new", "launch:s-new:1:a");
        const retried = yield* tokens.issue("s-new", "launch:s-new:1:a");
        const next = yield* tokens.issue("s-new", "launch:s-new:2:b");
        const before = [
          yield* tokens.resolve(first),
          yield* tokens.resolve(retried),
          yield* tokens.resolve(next),
        ];
        yield* tokens.revokeLaunch("launch:s-new:1:a");
        const after = [
          yield* tokens.resolve(first),
          yield* tokens.resolve(retried),
          yield* tokens.verify("s-new", next),
          yield* tokens.verify("s-other", next),
        ];
        yield* tokens.revoke("s-new");
        return { before, after, revoked: yield* tokens.resolve(next) };
      }),
    );
    expect(result.before).toEqual([
      { sessionId: "s-new", launchId: "launch:s-new:1:a" },
      { sessionId: "s-new", launchId: "launch:s-new:1:a" },
      { sessionId: "s-new", launchId: "launch:s-new:2:b" },
    ]);
    expect(result.after).toEqual([null, null, "launch:s-new:2:b", null]);
    expect(result.revoked).toBeNull();
  });
});
