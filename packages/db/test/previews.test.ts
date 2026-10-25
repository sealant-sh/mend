import { randomBytes } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { PreviewLabel, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Crypto, Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { PreviewsRepo, PreviewsRepoLive } from "../src/repos/previews.ts";
import { WorktreeNotFoundError } from "../src/repos/worktrees.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_previews_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const scratchLayer = PgClient.layer({ url: Redacted.make(url.toString()) });
const cryptoWith = (bytes: (size: number) => Uint8Array) =>
  Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: bytes,
      digest: () => Effect.die("preview identities do not use digests"),
    }),
  );
const repoLayer = (crypto = cryptoWith(randomBytes)) =>
  Layer.mergeAll(PreviewsRepoLive, SessionsRepoLive).pipe(
    Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
    Layer.provide(crypto),
  );
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<A, E, PreviewsRepo | SessionsRepo | SqlClient.SqlClient>,
  crypto?: Layer.Layer<Crypto.Crypto>,
) => Effect.runPromise(effect.pipe(Effect.provide(repoLayer(crypto)), Effect.scoped));
let created = false;

const seed = Effect.fn("previews.test.seed")(function* (
  suffix: string,
  project = ProjectId.make(`p-${suffix}`),
) {
  const sql = yield* SqlClient.SqlClient;
  const worktree = WorktreeId.make(`wt-${suffix}`);
  yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
    VALUES (${project}, ${project}, ${`/store/${project}`}, 'main', (SELECT id FROM organizations LIMIT 1))
    ON CONFLICT DO NOTHING`;
  yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
    VALUES (${worktree}, ${project}, ${suffix}, ${suffix}, ${`mend/${suffix}`}, 'abc')`;
  const sessions = yield* SessionsRepo;
  for (const ordinal of [1, 2]) {
    const sessionId = SessionId.make(`s-${suffix}-${ordinal}`);
    const serviceId = `svc-${suffix}-${ordinal}`;
    const attemptId = `att-${suffix}-${ordinal}`;
    yield* sessions.create({
      id: sessionId,
      projectId: project,
      worktreeId: worktree,
      harness: "claude",
      label: null,
      worktree: suffix,
      branch: `mend/${suffix}`,
      baseSha: Sha.make("abc"),
      baseRef: "main",
      contextSnapshotId: null,
      ownerUserId: "alice",
      origin: "mend",
    });
    yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port, browser_scheme)
      VALUES (${serviceId}, ${sessionId}, 'web', 'explicit-run', 3000, 'http')`;
    yield* sql`INSERT INTO session_processes
      (id, session_id, sealant_workspace_id, kind, status, service_id, attempt_ordinal, argv, created_at)
      VALUES (${attemptId}, ${sessionId}, 'ws-1', 'service', 'running', ${serviceId}, 1,
        '["npm", "run", "dev"]'::jsonb, ${new Date(`2026-10-24T10:00:0${ordinal}Z`)})`;
    yield* sql`UPDATE services SET current_attempt_id = ${attemptId} WHERE id = ${serviceId}`;
  }
  return { project, worktree };
});

const holdingRows = Effect.fn("previews.test.holdingRows")(function* (
  statements: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
) {
  const sql = yield* SqlClient.SqlClient;
  const holding = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const holder = yield* Effect.forkChild(
    sql.withTransaction(
      Effect.gen(function* () {
        yield* statements;
        yield* Deferred.succeed(holding, undefined);
        yield* Deferred.await(release);
      }),
    ),
  );
  yield* Deferred.await(holding);
  return Effect.gen(function* () {
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
  }).pipe(Effect.orDie);
});

const someoneWaitsOnALock = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (;;) {
    const [waiting] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    if ((waiting?.count ?? 0) > 0) return;
    yield* Effect.sleep("20 millis");
  }
}).pipe(Effect.timeout("20 seconds"));

describe.skipIf(postgres.skip)("preview identity and binding in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
        created = true;
      }),
    );
    await run(
      Effect.gen(function* () {
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* (yield* SqlClient.SqlClient)`INSERT INTO "user" (id, name, email, "createdAt")
        VALUES ('alice', 'Alice', 'alice@example.com', now())`;
      }),
    );
  });
  afterAll(async () => {
    if (created)
      await withAdmin(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient).unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
        }),
      );
  });

  it("concurrent readers of two sessions reserve one label; a second worktree gets another", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree, project } = yield* seed("shared");
        const other = yield* seed("other", project);
        const previews = yield* PreviewsRepo;
        const readers = yield* Effect.all(
          Array.from({ length: 8 }, () => previews.ensureForWorktree(worktree)),
          { concurrency: "unbounded" },
        );
        const first = readers[0]?.[0];
        if (first === undefined) return yield* Effect.die("missing preview");
        for (const rows of readers) expect(rows).toEqual([first]);
        expect(first.binding).toEqual({
          _tag: "Bound",
          serviceId: "svc-shared-1",
          attemptId: "att-shared-1",
        });
        expect(first.preview).toMatchObject({
          worktreeId: worktree,
          projectId: project,
          serviceName: "web",
          state: "kept",
        });
        expect(first.preview.label).toMatch(/^[a-z2-7]{25}[aeimquy4]$/);
        const [second] = yield* previews.ensureForWorktree(other.worktree);
        expect(second?.preview.id).not.toBe(first.preview.id);
        expect(second?.preview.label).not.toBe(first.preview.label);
        expect(yield* previews.resolveByLabel(first.preview.label)).toEqual(first);
        expect(yield* previews.byLabel(first.preview.label)).toEqual(first.preview);
        expect(yield* previews.byId(first.preview.id)).toEqual(first.preview);
        const sql = yield* SqlClient.SqlClient;
        const count = yield* sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM previews WHERE worktree_id = ${worktree}`;
        expect(count[0]?.count).toBe(1);
        yield* sql`UPDATE services SET current_attempt_id = NULL WHERE id = 'svc-shared-1'`;
        expect((yield* previews.ensureForWorktree(worktree))[0]?.binding).toEqual(first.binding);
        yield* sql`UPDATE session_processes SET exited_at = now() WHERE id = 'att-shared-1'`;
        expect((yield* previews.ensureForWorktree(worktree))[0]?.binding).toEqual({
          _tag: "Bound",
          serviceId: "svc-shared-2",
          attemptId: "att-shared-2",
        });
        yield* sql`UPDATE session_processes SET exited_at = now() WHERE id = 'att-shared-2'`;
        const [stopped] = yield* previews.ensureForWorktree(worktree);
        expect(stopped?.preview).toEqual(first.preview);
        expect(stopped?.binding).toEqual({ _tag: "Unbound", reason: "no-live-attempt" });
        yield* sql`DELETE FROM agent_sessions WHERE worktree_id = ${worktree}`;
        expect((yield* previews.ensureForWorktree(worktree))[0]?.binding).toEqual({
          _tag: "Unbound",
          reason: "service-missing",
        });
      }),
    );
  });

  it.each(["worktree", "project"])(
    "a removed %s leaves a permanent label tombstone",
    async (kind) => {
      await run(
        Effect.gen(function* () {
          const { worktree, project } = yield* seed(`remove-${kind}`);
          const previews = yield* PreviewsRepo;
          const [before] = yield* previews.ensureForWorktree(worktree);
          if (before === undefined) return yield* Effect.die("missing preview");
          const sql = yield* SqlClient.SqlClient;
          if (kind === "worktree") yield* sql`DELETE FROM worktrees WHERE id = ${worktree}`;
          else yield* sql`DELETE FROM projects WHERE id = ${project}`;
          const tombstone = {
            preview: {
              ...before.preview,
              worktreeId: null,
              projectId: kind === "project" ? null : project,
              state: "removed",
            },
            binding: { _tag: "Unbound", reason: "removed" },
          };
          expect(yield* previews.resolveByLabel(before.preview.label)).toEqual(tombstone);
          expect(yield* previews.byLabel(before.preview.label)).toEqual(tombstone.preview);
          expect(yield* previews.byId(before.preview.id)).toEqual(tombstone.preview);
          expect(yield* Effect.flip(previews.ensureForWorktree(worktree))).toEqual(
            new WorktreeNotFoundError({ id: worktree }),
          );
          const replacement = yield* seed(
            `replacement-${kind}`,
            kind === "worktree" ? project : undefined,
          );
          const [after] = yield* previews.ensureForWorktree(replacement.worktree);
          expect(after?.preview.label).not.toBe(before.preview.label);
          expect(after?.preview.id).not.toBe(before.preview.id);
          expect(yield* previews.resolveByLabel(before.preview.label)).toEqual(tombstone);
          if (kind === "worktree") {
            yield* sql`DELETE FROM projects WHERE id = ${project}`;
            expect(yield* previews.resolveByLabel(before.preview.label)).toEqual({
              ...tombstone,
              preview: { ...tombstone.preview, projectId: null },
            });
          }
        }),
      );
    },
  );

  it("retries a label that belongs to a tombstone instead of reusing it", async () => {
    let draws = 0;
    const crypto = cryptoWith((size) => (++draws <= 2 ? new Uint8Array(size) : randomBytes(size)));
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("collision");
        const sql = yield* SqlClient.SqlClient;
        const label = PreviewLabel.make("aaaaaaaaaaaaaaaaaaaaaaaaaa");
        yield* sql`INSERT INTO previews (id, service_name, label) VALUES ('reserved', 'web', ${label})`;
        const previews = yield* PreviewsRepo;
        const [allocated] = yield* previews.ensureForWorktree(worktree);
        expect(allocated?.preview.label).not.toBe(label);
        expect(yield* previews.resolveByLabel(label)).toMatchObject({
          preview: { id: "reserved", state: "removed" },
          binding: { _tag: "Unbound", reason: "removed" },
        });
        expect(
          yield* previews.resolveByLabel(PreviewLabel.make("bbbbbbbbbbbbbbbbbbbbbbbbba")),
        ).toBeNull();
      }),
      crypto,
    );
  });

  it("creates previews for adopted and HTTPS browser Services, and omits raw ports", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("schemes");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port, browser_scheme)
        VALUES ('adopt', 's-schemes-1', 'adopted', 'explicit-adopt', 3001, 'http'),
          ('https', 's-schemes-1', 'tls', 'explicit-run', 3002, 'https'),
          ('raw', 's-schemes-1', 'raw', 'explicit-adopt', 3003, NULL),
          ('recipe', 's-schemes-1', 'recipe', 'recipe-file', 3004, 'http')`;
        yield* sql`INSERT INTO session_processes
          (id, session_id, sealant_workspace_id, kind, status, service_id, attempt_ordinal, argv, exited_at)
          VALUES ('recipe-1', 's-schemes-1', 'ws-1', 'service', 'exited', 'recipe', 1,
            '["pnpm", "dev"]'::jsonb, now())`;
        const rows = yield* (yield* PreviewsRepo).ensureForWorktree(worktree);
        expect(rows.map((row) => [row.preview.serviceName, row.binding])).toEqual([
          ["adopted", { _tag: "Unbound", reason: "no-recorded-command" }],
          ["recipe", { _tag: "Unbound", reason: "no-live-attempt" }],
          ["tls", { _tag: "Unbound", reason: "https-unsupported" }],
          ["web", { _tag: "Bound", serviceId: "svc-schemes-1", attemptId: "att-schemes-1" }],
        ]);
      }),
    );
  });
  it("a read that allocates nothing takes no row lock, and neither does a label lookup", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree, project } = yield* seed("lock-free");
        const previews = yield* PreviewsRepo;
        const [allocated] = yield* previews.ensureForWorktree(worktree);
        if (allocated === undefined) return yield* Effect.die("missing preview");
        const sql = yield* SqlClient.SqlClient;
        const release = yield* holdingRows(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM projects WHERE id = ${project} FOR UPDATE`;
            yield* sql`SELECT id FROM worktrees WHERE id = ${worktree} FOR UPDATE`;
          }),
        );
        const read = yield* previews
          .ensureForWorktree(worktree)
          .pipe(Effect.timeout("5 seconds"), Effect.ensuring(release));
        expect(read).toEqual([allocated]);
        expect(yield* previews.resolveByLabel(allocated.preview.label)).toEqual(allocated);
      }),
    );
  });

  it("resolves previews against the Services of the snapshot they were read in", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree, project } = yield* seed("snapshot");
        const previews = yield* PreviewsRepo;
        const sql = yield* SqlClient.SqlClient;
        const release = yield* holdingRows(
          Effect.gen(function* () {
            yield* sql`INSERT INTO previews (id, project_id, worktree_id, service_name, label)
              VALUES ('racing-web', ${project}, ${worktree}, 'web', 'ccccccccccccccccccccccccca')`;
            yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port, browser_scheme)
              VALUES ('docs', 's-snapshot-2', 'docs', 'explicit-run', 3001, 'http')`;
            yield* sql`INSERT INTO session_processes
              (id, session_id, sealant_workspace_id, kind, status, service_id, attempt_ordinal, argv)
              VALUES ('docs-1', 's-snapshot-2', 'ws-1', 'service', 'running', 'docs', 1,
                '["pnpm", "docs"]'::jsonb)`;
            yield* sql`INSERT INTO previews (id, project_id, worktree_id, service_name, label)
              VALUES ('racing-docs', ${project}, ${worktree}, 'docs', 'ddddddddddddddddddddddddda')`;
          }),
        );
        const reader = yield* Effect.forkChild(previews.ensureForWorktree(worktree));
        yield* someoneWaitsOnALock.pipe(Effect.ensuring(release));
        const rows = yield* Fiber.join(reader);
        expect(rows.map((row) => [row.preview.id, row.binding])).toEqual([
          ["racing-docs", { _tag: "Bound", serviceId: "docs", attemptId: "docs-1" }],
          [
            "racing-web",
            { _tag: "Bound", serviceId: "svc-snapshot-1", attemptId: "att-snapshot-1" },
          ],
        ]);
      }),
    );
  });

  it("a label lookup never allocates a preview for another Service", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("lookup");
        const previews = yield* PreviewsRepo;
        const [web] = yield* previews.ensureForWorktree(worktree);
        if (web === undefined) return yield* Effect.die("missing preview");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port, browser_scheme)
          VALUES ('lookup-docs', 's-lookup-1', 'docs', 'explicit-adopt', 3001, 'http')`;
        expect(yield* previews.resolveByLabel(web.preview.label)).toEqual(web);
        const [count] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
          FROM previews WHERE worktree_id = ${worktree}`;
        expect(count?.count).toBe(1);
      }),
    );
  });

  it("an attempt with a value only the canonical mapper tolerates still binds", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("tolerant");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE session_processes SET waiting = '{"unknown": true}'::jsonb
          WHERE id = 'att-tolerant-1'`;
        const [web] = yield* (yield* PreviewsRepo).ensureForWorktree(worktree);
        expect(web?.binding).toEqual({
          _tag: "Bound",
          serviceId: "svc-tolerant-1",
          attemptId: "att-tolerant-1",
        });
      }),
    );
  });
});
