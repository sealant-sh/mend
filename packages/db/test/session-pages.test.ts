import { PgClient } from "@effect/sql-pg";
import { PageId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { SessionPagesRepo, SessionPagesRepoLive } from "../src/repos/session-pages.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_session_pages_test_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const reposLayer = Layer.mergeAll(SessionPagesRepoLive, SessionsRepoLive).pipe(
  Layer.provideMerge(
    MendDBLive.pipe(
      Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
    ),
  ),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, SessionPagesRepo | SessionsRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-pages");
const WORKTREE = WorktreeId.make("wt-pages");
const SESSION = SessionId.make("s-pages");
const OTHER = SessionId.make("s-pages-other");

const page = {
  sessionId: SESSION,
  callKey: "call-1",
  accountId: "alice",
  agentProcessId: null,
  title: "Latency by region",
  height: 420,
  html: "<!doctype html><p>p99 · 41 ms ✓</p>",
};

describe.skipIf(postgres.skip)("session pages in Postgres", () => {
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
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'pages', '/store/p-pages/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-pages', 'wt-pages', 'mend/wt-pages', 'abc')`;
        for (const id of [SESSION, OTHER]) {
          yield* (yield* SessionsRepo).create({
            id,
            projectId: PROJECT,
            worktreeId: WORKTREE,
            harness: "claude",
            label: null,
            worktree: "wt-pages",
            branch: "mend/wt-pages",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            contextSnapshotId: null,
            ownerUserId: "alice",
            origin: "mend",
          });
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

  it("stores a page with its digest and byte count, and reads it back by id", async () => {
    const [stored, read] = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const published = yield* pages.publish(page);
        return [published, yield* pages.byId(published.id)] as const;
      }),
    );
    expect(read).toEqual(stored);
    expect(stored).toEqual({
      sessionId: page.sessionId,
      callKey: page.callKey,
      accountId: page.accountId,
      title: page.title,
      height: page.height,
      html: page.html,
      id: stored.id,
      sha256: stored.sha256,
      bytes: stored.bytes,
      publishedAt: stored.publishedAt,
    });
    expect(stored.bytes).toBe(Buffer.byteLength(page.html, "utf8"));
    expect(stored.bytes).toBeGreaterThan(page.html.length);
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
    const missing = await run(
      Effect.flatMap(SessionPagesRepo, (pages) => pages.byId(PageId.make("no-such"))),
    );
    expect(missing).toBeNull();
  });

  it("answers a retried call with its first row, concurrently too, and refuses a reused key", async () => {
    const result = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const sql = yield* SqlClient.SqlClient;
        const retried = { ...page, callKey: "call-retried" };
        const answers = yield* Effect.all(
          Array.from({ length: 6 }, () => pages.publish(retried)),
          { concurrency: "unbounded" },
        );
        const rows = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM session_pages
          WHERE session_id = ${SESSION} AND call_key = 'call-retried'`;
        const otherPage = yield* Effect.flip(pages.publish({ ...retried, html: "<p>other</p>" }));
        const otherTitle = yield* Effect.flip(pages.publish({ ...retried, title: "Another" }));
        const otherPerson = yield* Effect.flip(pages.publish({ ...retried, accountId: "ben" }));
        const otherSession = yield* pages.publish({ ...retried, sessionId: OTHER });
        return { answers, rows, otherPage, otherTitle, otherPerson, otherSession };
      }),
    );
    expect(new Set(result.answers.map((answer) => answer.id)).size).toBe(1);
    expect(result.rows).toEqual([{ count: "1" }]);
    for (const refused of [result.otherPage, result.otherTitle, result.otherPerson]) {
      expect(refused).toMatchObject({
        _tag: "SessionPageConflictError",
        sessionId: SESSION,
        callKey: "call-retried",
      });
    }
    expect(result.otherSession.id).not.toBe(result.answers[0]?.id);
  });

  it("fails as a storage error, not a defect, when the database cannot answer", async () => {
    const failures = await run(
      Effect.gen(function* () {
        const pages = yield* SessionPagesRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`ALTER TABLE session_pages RENAME TO session_pages_away`;
        return yield* Effect.all([
          Effect.flip(pages.publish({ ...page, callKey: "call-outage" })),
          Effect.flip(pages.byId(PageId.make("any"))),
        ]).pipe(
          Effect.ensuring(
            sql`ALTER TABLE session_pages_away RENAME TO session_pages`.pipe(Effect.orDie),
          ),
        );
      }),
    );
    expect(failures.map((failure) => failure._tag)).toEqual([
      "SessionPageStorageError",
      "SessionPageStorageError",
    ]);
  });

  it("fails as a missing session, not a storage error, for a session Mend no longer has", async () => {
    const failure = await run(
      Effect.flip(
        Effect.flatMap(SessionPagesRepo, (pages) =>
          pages.publish({ ...page, sessionId: SessionId.make("s-pages-gone"), callKey: "gone" }),
        ),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "SessionPageSessionNotFoundError",
      sessionId: "s-pages-gone",
    });
  });

  it("goes with its session", async () => {
    const left = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* (yield* SessionPagesRepo).publish({ ...page, sessionId: OTHER, callKey: "gone" });
        yield* sql`DELETE FROM agent_sessions WHERE id = ${OTHER}`;
        return yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM session_pages WHERE session_id = ${OTHER}`;
      }),
    );
    expect(left).toEqual([{ count: "0" }]);
  });
});
