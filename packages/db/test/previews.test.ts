import { randomBytes } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import {
  PreviewId,
  PreviewLabel,
  ProjectId,
  ServiceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  PREVIEW_CONTROL_INITIAL,
  previewStartId,
  serviceStartCorrelation,
} from "@mend/domain/workbench";
import { Crypto, Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import type { SqlError } from "effect/sql/SqlError";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import {
  PreviewsRepo,
  PreviewsRepoLive,
  TAILNET_PORT_QUIET_HOURS,
  TAILNET_PORT_RENEW_AFTER_HOURS,
} from "../src/repos/previews.ts";
import { SessionProcessesRepo, SessionProcessesRepoLive } from "../src/repos/session-processes.ts";
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
  Layer.mergeAll(PreviewsRepoLive, SessionsRepoLive, SessionProcessesRepoLive).pipe(
    Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
    Layer.provide(crypto),
  );
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    PreviewsRepo | SessionsRepo | SessionProcessesRepo | SqlClient.SqlClient
  >,
  crypto?: Layer.Layer<Crypto.Crypto>,
) => Effect.runPromise(effect.pipe(Effect.provide(repoLayer(crypto)), Effect.scoped));
let created = false;
const CheckViolation = Schema.Struct({ code: Schema.Literal("23514"), constraint: Schema.String });

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

const waitingOnLocks = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (;;) {
      const [waiting] = yield* sql<{ count: number }>`SELECT count(*)::int AS count
      FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((waiting?.count ?? 0) >= count) return;
      yield* Effect.sleep("20 millis");
    }
  }).pipe(Effect.timeout("20 seconds"));
const someoneWaitsOnALock = waitingOnLocks(1);

const startedByRequest = (serviceId: string, sourceAttemptId: string) =>
  serviceStartCorrelation(
    serviceId,
    previewStartId({
      previewId: PreviewId.make("p"),
      revision: 0,
      sourceAttemptId: SessionProcessId.make(sourceAttemptId),
    }),
  );

const dormant = (sourceAttemptId: string) => ({
  _tag: "Dormant",
  revision: 0,
  source: { serviceId: "svc-dormant-2", sourceAttemptId },
  workspaceId: null,
});

const LOOPBACK = { host: "rewrite", dial: "session-bound" } as const;

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

  it("keeps monotonic batched activity and the idle attempt across repository reads", () =>
    run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("activity");
        const repo = yield* PreviewsRepo;
        const id = yield* repo.ensureNamed(worktree, "web");
        const recent = new Date("2026-10-31T10:00:00Z");
        yield* repo.touchActivity(new Map([[id, recent]]));
        yield* repo.touchActivity(new Map([[id, new Date(recent.getTime() - 1000)]]));
        expect((yield* repo.activityOf(id))?.lastAdmittedAt).toEqual(recent);
        const candidate = (yield* repo.idleCandidates()).find((row) => row.previewId === id);
        expect(candidate?.lastAdmittedAt).toEqual(recent);
        yield* repo.recordIdleStop(id, SessionProcessId.make("att-activity-2"), 30, recent);
        expect(yield* repo.activityOf(id)).toMatchObject({
          idleStoppedAttemptId: "att-activity-2",
          idleMinutes: 30,
          idleStoppedAt: recent,
        });
        yield* repo.touchActivity(new Map([[id, new Date(recent.getTime() + 1000)]]));
        expect((yield* repo.activityOf(id))?.idleMinutes).toBe(30);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM previews WHERE id = ${id}`;
        expect(yield* repo.activityOf(id)).toBeNull();
      }),
    ));

  it("holds the gateway on a leased preparation while the old attempt is dormant", () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* PreviewsRepo;
        const { worktree } = yield* seed("preparing");
        const id = yield* repo.ensureNamed(worktree, "web");
        yield* sql`UPDATE session_processes SET status = 'stopped', exited_at = now()
        WHERE session_id IN ('s-preparing-1', 's-preparing-2')`;
        yield* sql`UPDATE services SET current_attempt_id = NULL
        WHERE session_id IN ('s-preparing-1', 's-preparing-2')`;
        yield* sql`INSERT INTO agent_turns (id, session_id, process_id, ordinal, input, status)
        VALUES ('turn-preparing', 's-preparing-1', 'att-preparing-1', 1, 'edit', 'completed')`;
        yield* sql`INSERT INTO preview_preparations
        (turn_id, session_id, worktree_id, state, service_name, preview_id, start_id, phase,
         claim_id, claimed_at, lease_until)
        VALUES ('turn-preparing', 's-preparing-1', ${worktree}, 'starting', 'web', ${id},
          'preview-turn:turn-preparing', 'setup', '00000000-0000-0000-0000-000000000001',
          now(), now() + interval '1 minute')`;
        expect((yield* repo.gatewaySnapshot(id))?.resolution).toEqual({
          _tag: "Starting",
          revision: 0,
          attemptId: null,
          workspaceId: null,
        });
        yield* sql`UPDATE preview_preparations SET lease_until = now() - interval '1 second'
        WHERE turn_id = 'turn-preparing'`;
        expect((yield* repo.gatewaySnapshot(id))?.resolution._tag).toBe("Dormant");
      }),
    ));

  it("a read-only reader allocates nothing, however often it reads, and reads what an allocation made", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("readonly");
        const previews = yield* PreviewsRepo;
        const sql = yield* SqlClient.SqlClient;
        const rows = () =>
          sql<{
            count: number;
          }>`SELECT count(*)::int AS count FROM previews WHERE worktree_id = ${worktree}`.pipe(
            Effect.map(([row]) => row?.count),
          );
        for (let read = 0; read < 3; read++) {
          expect(yield* previews.readForWorktree(worktree)).toEqual([]);
        }
        expect(yield* rows()).toBe(0);
        const allocated = yield* previews.ensureForWorktree(worktree);
        expect(allocated).toHaveLength(1);
        expect(yield* previews.readForWorktree(worktree)).toEqual(allocated);
        expect(yield* rows()).toBe(1);
        expect(yield* previews.readForWorktree(WorktreeId.make("wt-gone"))).toEqual([]);
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
          ...LOOPBACK,
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
        expect(yield* previews.resolveById(first.preview.id)).toEqual(first);
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
          ...LOOPBACK,
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

  it("keeps a preview by name before any Service of that name has a row, once", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("named");
        const previews = yield* PreviewsRepo;
        const [first, again] = yield* Effect.all(
          [
            previews.ensureNamed(worktree, "storybook"),
            previews.ensureNamed(worktree, "storybook"),
          ],
          { concurrency: 2 },
        );
        expect(again).toBe(first);
        const kept = yield* previews.ensureForWorktree(worktree);
        expect(kept.find((view) => view.preview.serviceName === "storybook")?.preview.id).toBe(
          first,
        );
        expect(
          yield* Effect.flip(previews.ensureNamed(WorktreeId.make("wt-gone"), "storybook")),
        ).toMatchObject({ _tag: "WorktreeNotFoundError" });
      }),
    );
  });

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
        expect(yield* previews.resolveById(PreviewId.make("reserved"))).toMatchObject({
          preview: { label, state: "removed" },
          binding: { _tag: "Unbound", reason: "removed" },
        });
        expect(yield* previews.resolveById(PreviewId.make("no-such-preview"))).toBeNull();
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
          [
            "web",
            { _tag: "Bound", serviceId: "svc-schemes-1", attemptId: "att-schemes-1", ...LOOPBACK },
          ],
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
          ["racing-docs", { _tag: "Bound", serviceId: "docs", attemptId: "docs-1", ...LOOPBACK }],
          [
            "racing-web",
            {
              _tag: "Bound",
              serviceId: "svc-snapshot-1",
              attemptId: "att-snapshot-1",
              ...LOOPBACK,
            },
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
          ...LOOPBACK,
        });
      }),
    );
  });

  const live = Effect.fn("previews.test.live")(function* (suffix: string) {
    const { worktree, project } = yield* seed(suffix);
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE session_processes SET sealant_session_id = 'pty-' || id
      WHERE session_id LIKE ${`s-${suffix}-%`}`;
    const [view] = yield* (yield* PreviewsRepo).ensureForWorktree(worktree);
    if (view === undefined) return yield* Effect.die("missing preview");
    return { worktree, project, preview: view.preview };
  });

  it("a control write moves the revision once per change of state, under concurrent writers", async () => {
    await run(
      Effect.gen(function* () {
        const { preview } = yield* live("control");
        const previews = yield* PreviewsRepo;
        expect(yield* previews.controlOf(preview.id)).toEqual(PREVIEW_CONTROL_INITIAL);
        expect(
          yield* previews.changeControl(preview.id, {
            _tag: "Start",
            seq: yield* previews.nextControlSeq(),
          }),
        ).toEqual(PREVIEW_CONTROL_INITIAL);
        const at = new Date("2026-10-25T08:00:00Z");
        const askedBefore = yield* previews.nextControlSeq();
        const stops = yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            previews.changeControl(preview.id, {
              _tag: "Stop",
              by: "alice",
              at: new Date(at.getTime() + index),
            }),
          ),
          { concurrency: "unbounded" },
        );
        for (const stopped of stops)
          expect(stopped).toMatchObject({ _tag: "Stopped", revision: 1 });
        const stopped = yield* previews.controlOf(preview.id);
        expect(stopped, "the last Stop written is the latest").toMatchObject({
          seq: Math.max(...stops.map((stop) => (stop._tag === "Stopped" ? stop.seq : 0))),
        });
        expect(
          yield* previews.changeControl(preview.id, { _tag: "Start", seq: askedBefore }),
          "a Start asked before those Stops",
        ).toEqual(stopped);
        const start = () =>
          Effect.flatMap(previews.nextControlSeq(), (seq) =>
            previews.changeControl(preview.id, { _tag: "Start", seq }),
          );
        expect(yield* start()).toEqual({ _tag: "Automatic", revision: 2 });
        expect(yield* start()).toEqual({ _tag: "Automatic", revision: 2 });
        const sql = yield* SqlClient.SqlClient;
        const [row] = yield* sql<{ revision: number; stopped_by: string | null }>`
          SELECT revision, stopped_by FROM preview_controls WHERE preview_id = ${preview.id}`;
        expect(row).toEqual({ revision: 2, stopped_by: null });
        const refusedBy = (statement: Effect.Effect<unknown, SqlError>) =>
          Effect.flip(statement).pipe(
            Effect.map(
              (error) => Schema.decodeUnknownSync(CheckViolation)(error.reason.cause).constraint,
            ),
          );
        for (const [state, by, stoppedAt, constraint] of [
          ["stopped", null, at, "preview_controls_stop_facts"],
          ["stopped", "alice", null, "preview_controls_stop_facts"],
          ["automatic", "alice", at, "preview_controls_stop_facts"],
          ["paused", null, null, "preview_controls_state_check"],
        ] as const) {
          expect(
            yield* refusedBy(sql`UPDATE preview_controls SET state = ${state}, stopped_by = ${by},
              stopped_at = ${stoppedAt} WHERE preview_id = ${preview.id}`),
            `${state} ${by} ${stoppedAt}`,
          ).toBe(constraint);
        }
        expect(
          yield* refusedBy(
            sql`UPDATE preview_controls SET revision = -1 WHERE preview_id = ${preview.id}`,
          ),
        ).toBe("preview_controls_revision_check");
      }),
    );
  });

  it("finds the kept preview that selects a Service, by its worktree and name, and allocates none", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("of-service");
        const previews = yield* PreviewsRepo;
        expect(yield* previews.previewOfService(ServiceId.make("svc-of-service-1"))).toBeNull();
        const [web] = yield* previews.ensureForWorktree(worktree);
        const of = (id: string) => previews.previewOfService(ServiceId.make(id));
        expect(yield* of("svc-of-service-1"), "the oldest live attempt's Service").toBe(
          web?.preview.id,
        );
        expect(yield* of("svc-of-service-2"), "a same-named Service it does not select").toBeNull();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE session_processes SET exited_at = now(), status = 'stopped'
          WHERE id = 'att-of-service-1'`;
        expect(yield* of("svc-of-service-2"), "now the only live one").toBe(web?.preview.id);
        expect(yield* of("svc-of-service-1")).toBeNull();
        yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port, browser_scheme)
          VALUES ('of-service-docs', 's-of-service-1', 'docs', 'explicit-run', 3001, 'http')`;
        expect(yield* previews.previewOfService(ServiceId.make("of-service-docs"))).toBeNull();
        expect(yield* previews.previewOfService(ServiceId.make("missing"))).toBeNull();
        yield* sql`DELETE FROM worktrees WHERE id = ${worktree}`;
        expect(yield* previews.previewOfService(ServiceId.make("svc-of-service-2"))).toBeNull();
      }),
    );
  });

  it("binds the oldest live attempt with its workspace, port and platform session, and a person's Stop holds once it ends, named", async () => {
    await run(
      Effect.gen(function* () {
        const { preview } = yield* live("bound");
        const previews = yield* PreviewsRepo;
        const sql = yield* SqlClient.SqlClient;
        expect(yield* previews.gatewaySnapshot(preview.id)).toEqual({
          preview,
          resolution: {
            _tag: "Bound",
            revision: 0,
            attempt: {
              serviceId: "svc-bound-1",
              attemptId: "att-bound-1",
              sessionId: "s-bound-1",
              workspaceId: "ws-1",
              port: 3000,
              platformSessionId: "pty-att-bound-1",
              ...LOOPBACK,
            },
          },
        });
        yield* sql`UPDATE session_processes SET status = 'starting', sealant_session_id = NULL
          WHERE id = 'att-bound-1'`;
        expect((yield* previews.gatewaySnapshot(preview.id))?.resolution).toEqual({
          _tag: "Starting",
          revision: 0,
          attemptId: "att-bound-1",
          workspaceId: "ws-1",
        });
        yield* sql`UPDATE session_processes SET status = 'running', sealant_session_id = 'pty-att-bound-1'
          WHERE id = 'att-bound-1'`;
        const stopped = yield* previews.changeControl(preview.id, {
          _tag: "Stop",
          by: "alice",
          at: new Date("2026-10-25T08:00:00Z"),
        });
        expect(
          (yield* previews.gatewaySnapshot(preview.id))?.resolution,
          "a run that outlives the Stop is served",
        ).toMatchObject({ _tag: "Bound", revision: 1 });
        yield* sql`UPDATE session_processes SET exited_at = now(), status = 'exited'
          WHERE session_id LIKE 's-bound-%'`;
        expect((yield* previews.gatewaySnapshot(preview.id))?.resolution).toEqual({
          _tag: "Stopped",
          control: { ...stopped, byName: "Alice" },
        });
        yield* previews.changeControl(preview.id, {
          _tag: "Start",
          seq: yield* previews.nextControlSeq(),
        });
        yield* previews.changeControl(preview.id, { _tag: "Stop", by: "gone", at: new Date() });
        expect(
          (yield* previews.gatewaySnapshot(preview.id))?.resolution,
          "a person with no name, or no row, reads as a member",
        ).toMatchObject({ _tag: "Stopped", control: { by: "gone", byName: "a member" } });
        yield* sql`UPDATE session_processes SET exited_at = NULL, status = 'running',
          sealant_session_id = NULL WHERE id = 'att-bound-1'`;
        expect((yield* previews.gatewaySnapshot(preview.id))?.resolution).toEqual({
          _tag: "Refused",
          reason: "process-binding-unavailable",
        });
      }),
    );
  });

  it("a dormant preview resumes its own Service's last attempt that answered or that a person started", async () => {
    await run(
      Effect.gen(function* () {
        const { preview } = yield* live("dormant");
        const previews = yield* PreviewsRepo;
        const processes = yield* SessionProcessesRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE session_processes SET exited_at = now(), status = 'exited'
          WHERE session_id LIKE 's-dormant-%'`;
        // The newest declaration of the name is the second session's: the first one's answering
        // attempt never makes it the Service a request starts.
        yield* processes.markReached(SessionProcessId.make("att-dormant-1"));
        expect((yield* previews.gatewaySnapshot(preview.id))?.resolution).toEqual(
          dormant("att-dormant-2"),
        );
        yield* sql`INSERT INTO session_processes
          (id, session_id, sealant_workspace_id, kind, status, service_id, attempt_ordinal, argv,
            launch_correlation_id, created_at, exited_at)
          VALUES ('att-dormant-2b', 's-dormant-2', 'ws-1', 'service', 'exited', 'svc-dormant-2', 2,
            '["npm", "run", "dev"]'::jsonb, ${startedByRequest("svc-dormant-2", "att-dormant-2")},
            ${new Date("2026-10-24T11:00:00Z")}, now())`;
        expect((yield* previews.gatewaySnapshot(preview.id))?.resolution).toEqual(
          dormant("att-dormant-2"),
        );
        yield* processes.markReached(SessionProcessId.make("att-dormant-2b"));
        expect(yield* processes.reached(SessionProcessId.make("att-dormant-2b"))).toBe(true);
        expect(yield* processes.reached(SessionProcessId.make("att-dormant-2"))).toBe(false);
        expect((yield* previews.gatewaySnapshot(preview.id))?.resolution).toEqual(
          dormant("att-dormant-2b"),
        );
        yield* sql`UPDATE agent_sessions SET sealant_workspace_id = 'ws-live' WHERE id = 's-dormant-2'`;
        expect(
          (yield* previews.gatewaySnapshot(preview.id))?.resolution,
          "a start runs in the session's live workspace",
        ).toMatchObject({ _tag: "Dormant", workspaceId: "ws-live" });
      }),
    );
  });

  it("a dormant Service whose only attempt is a request's start that never answered has no command", async () => {
    await run(
      Effect.gen(function* () {
        const { preview } = yield* live("no-source");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE session_processes SET exited_at = now(), status = 'exited',
          launch_correlation_id = ${startedByRequest("svc-no-source-2", "earlier")}
          WHERE id = 'att-no-source-2'`;
        yield* sql`UPDATE session_processes SET exited_at = now(), status = 'exited'
          WHERE id = 'att-no-source-1'`;
        expect((yield* (yield* PreviewsRepo).gatewaySnapshot(preview.id))?.resolution).toEqual({
          _tag: "Refused",
          reason: "no-recorded-command",
        });
      }),
    );
  });

  it("names the binding's other unbound reasons as the gateway's refusals", async () => {
    await run(
      Effect.gen(function* () {
        const { worktree } = yield* seed("reasons");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port, browser_scheme)
          VALUES ('reasons-adopt', 's-reasons-1', 'adopted', 'explicit-adopt', 3001, 'http'),
            ('reasons-tls', 's-reasons-1', 'tls', 'explicit-run', 3002, 'https'),
            ('reasons-raw', 's-reasons-1', 'raw', 'explicit-adopt', 3003, NULL)`;
        const previews = yield* PreviewsRepo;
        const views = yield* previews.ensureForWorktree(worktree);
        yield* sql`UPDATE services SET browser_scheme = NULL WHERE id = 'reasons-adopt'`;
        const read = yield* previews.gatewaySnapshots(views.map((view) => view.preview.id));
        expect(
          views.map((view) => [view.preview.serviceName, read.get(view.preview.id)?.resolution]),
        ).toEqual([
          ["adopted", { _tag: "Refused", reason: "not-browser-service" }],
          ["tls", { _tag: "Refused", reason: "https-unsupported" }],
          ["web", { _tag: "Refused", reason: "process-binding-unavailable" }],
        ]);
        yield* sql`DELETE FROM services WHERE id = 'reasons-tls'`;
        const [, tls] = views;
        if (tls === undefined) return yield* Effect.die("missing preview");
        expect((yield* previews.gatewaySnapshot(tls.preview.id))?.resolution).toEqual({
          _tag: "Refused",
          reason: "service-missing",
        });
      }),
    );
  });

  it("answers a removed preview as refused, an unknown one as null, and many in one snapshot", async () => {
    await run(
      Effect.gen(function* () {
        const { preview, worktree } = yield* live("many");
        const other = yield* live("many-other");
        const previews = yield* PreviewsRepo;
        const both = yield* previews.gatewaySnapshots([
          preview.id,
          other.preview.id,
          preview.id,
          PreviewId.make("unknown"),
        ]);
        expect([...both.keys()].toSorted()).toEqual([preview.id, other.preview.id].toSorted());
        expect(both.get(preview.id)).toEqual(yield* previews.gatewaySnapshot(preview.id));
        expect(both.get(other.preview.id)).toEqual(
          yield* previews.gatewaySnapshot(other.preview.id),
        );
        expect(yield* previews.gatewaySnapshot(PreviewId.make("unknown"))).toBeNull();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM worktrees WHERE id = ${worktree}`;
        expect(yield* previews.gatewaySnapshot(preview.id)).toEqual({
          preview: { ...preview, worktreeId: null, state: "removed" },
          resolution: { _tag: "Refused", reason: "service-missing" },
        });
      }),
    );
  });

  describe("the tailnet port pool", () => {
    const keptPreview = Effect.fn("previews.test.keptPreview")(function* (suffix: string) {
      const { worktree, project } = yield* seed(`pool-${suffix}`);
      const [view] = yield* (yield* PreviewsRepo).ensureForWorktree(worktree);
      if (view === undefined) return yield* Effect.die("missing preview");
      return { id: view.preview.id, worktree, project };
    });
    const portRows = Effect.fn("previews.test.portRows")(function* (ports: ReadonlyArray<number>) {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        readonly port: number;
        readonly previewId: string | null;
        readonly released: boolean;
      }>`SELECT port, preview_id AS "previewId", released_at IS NOT NULL AS released FROM preview_ports
        WHERE port IN ${sql.in(ports)} ORDER BY port`;
    });

    it("gives a preview one port at its first open, the same however many open it at once", async () => {
      await run(
        Effect.gen(function* () {
          const previews = yield* PreviewsRepo;
          const first = yield* keptPreview("once");
          const set = [31001, 31002, 31003];
          expect(yield* previews.tailnetPorts([first.id])).toEqual(new Map());
          const opens = yield* Effect.all(
            Array.from({ length: 8 }, () => previews.assignTailnetPort(first.id, set)),
            { concurrency: "unbounded" },
          );
          expect(new Set(opens.map((open) => JSON.stringify(open)))).toEqual(
            new Set([JSON.stringify({ _tag: "Assigned", port: 31001 })]),
          );
          expect(yield* previews.tailnetPorts([first.id])).toEqual(new Map([[first.id, 31001]]));
          expect((yield* previews.byTailnetPort(31001))?.preview.id).toBe(first.id);
          expect(yield* previews.byTailnetPort(31002)).toBeNull();
        }),
      );
    });

    it("gives previews opened at once a port each, and says the set's size when none is free", async () => {
      await run(
        Effect.gen(function* () {
          const previews = yield* PreviewsRepo;
          const opened = yield* Effect.forEach(["a", "b", "c"], (name) =>
            keptPreview(`full-${name}`),
          );
          const set = [31101, 31102];
          const answers = yield* Effect.all(
            opened.map(({ id }) => previews.assignTailnetPort(id, set)),
            { concurrency: "unbounded" },
          );
          const assigned = answers.flatMap((answer) =>
            answer._tag === "Assigned" ? [answer.port] : [],
          );
          expect(assigned.toSorted()).toEqual(set);
          expect(
            answers.flatMap((answer) => (answer._tag === "PoolFull" ? [answer.size] : [])),
          ).toEqual([2]);
        }),
      );
    });

    const backdatePorts = Effect.fn("previews.test.backdatePorts")(function* (
      ports: ReadonlyArray<number>,
      hours: number,
    ) {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE preview_ports
        SET last_used_at = last_used_at - make_interval(hours => ${hours}),
            released_at = released_at - make_interval(hours => ${hours})
        WHERE port IN ${sql.in(ports)}`;
    });

    it.each(["worktree", "project"])(
      "frees a port when its preview's %s is removed, and gives it again only after the quiet period",
      async (kind) => {
        await run(
          Effect.gen(function* () {
            const previews = yield* PreviewsRepo;
            const sql = yield* SqlClient.SqlClient;
            const base = kind === "worktree" ? 31200 : 31300;
            const set = [base + 1, base + 2];
            const [p1, p2, p3, p4] = yield* Effect.forEach(["1", "2", "3", "4"], (name) =>
              keptPreview(`quiet-${kind}-${name}`),
            );
            if (p1 === undefined || p2 === undefined || p3 === undefined || p4 === undefined)
              return yield* Effect.die("missing previews");
            expect(yield* previews.assignTailnetPort(p1.id, set)).toMatchObject({
              port: base + 1,
            });
            expect(yield* previews.assignTailnetPort(p2.id, set)).toMatchObject({
              port: base + 2,
            });
            const remove = (preview: { readonly worktree: string; readonly project: string }) =>
              kind === "worktree"
                ? sql`DELETE FROM worktrees WHERE id = ${preview.worktree}`
                : sql`DELETE FROM projects WHERE id = ${preview.project}`;
            yield* remove(p1);
            expect(yield* portRows(set)).toEqual([
              { port: base + 1, previewId: null, released: true },
              { port: base + 2, previewId: p2.id, released: false },
            ]);
            expect(yield* previews.byTailnetPort(base + 1)).toBeNull();
            expect(yield* previews.assignTailnetPort(p1.id, set)).toEqual({ _tag: "Removed" });

            yield* previews.touchTailnetPorts([p2.id]);
            const full = yield* previews.assignTailnetPort(p3.id, set);
            if (full._tag !== "PoolFull") return yield* Effect.die("the removed port came back");
            expect(full.size).toBe(2);
            const [frees] = yield* sql<{
              readonly at: Date;
            }>`SELECT released_at + make_interval(hours => ${TAILNET_PORT_QUIET_HOURS}) AS at
              FROM preview_ports WHERE port = ${base + 1}`;
            expect(
              full.nextFreeAt,
              "the removed port, a quiet period after its removal, before the one in use",
            ).toEqual(frees?.at);

            yield* backdatePorts([base + 1], TAILNET_PORT_QUIET_HOURS - 1);
            expect((yield* previews.assignTailnetPort(p3.id, set))._tag).toBe("PoolFull");
            yield* backdatePorts([base + 1], 2);
            expect(yield* previews.assignTailnetPort(p3.id, set)).toEqual({
              _tag: "Assigned",
              port: base + 1,
            });
            expect(yield* previews.tailnetPortReused(base + 1, p3.id)).toBe(true);
            expect(yield* previews.tailnetPortReused(base + 2, p2.id)).toBe(false);
            expect((yield* previews.assignTailnetPort(p4.id, set))._tag).toBe("PoolFull");
          }),
        );
      },
    );

    it("takes back a port whose preview had no open connection for the quiet period, and gives that preview a fresh one at its next open", async () => {
      await run(
        Effect.gen(function* () {
          const previews = yield* PreviewsRepo;
          const [idle, busy, next] = yield* Effect.forEach(["idle", "busy", "next"], (name) =>
            keptPreview(`reclaim-${name}`),
          );
          if (idle === undefined || busy === undefined || next === undefined)
            return yield* Effect.die("missing previews");
          const set = [31501, 31502];
          expect(yield* previews.assignTailnetPort(idle.id, set)).toMatchObject({ port: 31501 });
          expect(yield* previews.assignTailnetPort(busy.id, set)).toMatchObject({ port: 31502 });
          yield* backdatePorts(set, TAILNET_PORT_QUIET_HOURS + 1);
          yield* previews.touchTailnetPorts([busy.id]);
          expect(
            yield* previews.assignTailnetPort(next.id, set),
            "the port in use stays; the idle one goes",
          ).toEqual({ _tag: "Assigned", port: 31501 });
          expect(yield* previews.tailnetPorts([idle.id, busy.id, next.id])).toEqual(
            new Map([
              [busy.id, 31502],
              [next.id, 31501],
            ]),
          );
          expect(yield* previews.tailnetPortReused(31501, next.id)).toBe(true);
          expect(
            (yield* previews.assignTailnetPort(idle.id, set))._tag,
            "every port was used within the quiet period",
          ).toBe("PoolFull");
          expect(
            yield* previews.assignTailnetPort(idle.id, [...set, 31503]),
            "its next open, with a port free, gets a fresh one",
          ).toEqual({ _tag: "Assigned", port: 31503 });
        }),
      );
    });

    it.each<"renewal" | "reclaim">(["renewal", "reclaim"])(
      "a renewal and a reclaim of one quiet port, queued together: the %s goes first and wins",
      async (first) => {
        await run(
          Effect.gen(function* () {
            const previews = yield* PreviewsRepo;
            const sql = yield* SqlClient.SqlClient;
            const [web, docs] = yield* Effect.forEach(["web", "docs"], (name) =>
              keptPreview(`renew-${first}-${name}`),
            );
            if (web === undefined || docs === undefined)
              return yield* Effect.die("missing previews");
            const port = first === "renewal" ? 31701 : 31702;
            expect(yield* previews.assignTailnetPort(web.id, [port])).toEqual({
              _tag: "Assigned",
              port,
            });
            expect((yield* previews.byTailnetPort(port))?.renewDue, "used just now").toBe(false);
            yield* backdatePorts([port], TAILNET_PORT_RENEW_AFTER_HOURS);
            expect((yield* previews.byTailnetPort(port))?.renewDue).toBe(true);
            yield* backdatePorts([port], TAILNET_PORT_QUIET_HOURS);

            const release = yield* holdingRows(
              sql`SELECT pg_advisory_xact_lock(hashtext('mend:preview-ports'))`,
            );
            const queue = <A>(effect: Effect.Effect<A>, place: number) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.forkChild(effect);
                yield* waitingOnLocks(place);
                return fiber;
              });
            const renew = previews.renewTailnetPort(port, web.id);
            const renewedFirst = first === "renewal" ? yield* queue(renew, 1) : null;
            const reassignment = yield* queue(
              previews.assignTailnetPort(docs.id, [port]),
              first === "renewal" ? 2 : 1,
            );
            const renewal = renewedFirst ?? (yield* queue(renew, 2));
            yield* release;
            const renewed = yield* Fiber.join(renewal);
            const reassigned = yield* Fiber.join(reassignment);
            if (first === "renewal") {
              expect(renewed).toBe("Renewed");
              expect(reassigned._tag, "the renewed port is in use").toBe("PoolFull");
              expect(yield* previews.tailnetPorts([web.id, docs.id])).toEqual(
                new Map([[web.id, port]]),
              );
            } else {
              expect(reassigned).toEqual({ _tag: "Assigned", port });
              expect(renewed, "the port went to docs first").toBe("Moved");
              expect(yield* previews.tailnetPorts([web.id, docs.id])).toEqual(
                new Map([[docs.id, port]]),
              );
            }
          }),
        );
      },
    );

    it("gives the least recently used port first, never-used ports before any", async () => {
      await run(
        Effect.gen(function* () {
          const previews = yield* PreviewsRepo;
          const held = yield* Effect.forEach(["a", "b", "c"], (name) => keptPreview(`lru-${name}`));
          const set = [31601, 31602, 31603];
          for (const preview of held) yield* previews.assignTailnetPort(preview.id, set);
          yield* backdatePorts([31601], 30);
          yield* backdatePorts([31602], 26);
          yield* backdatePorts([31603], 50);
          const [fresh, x, y, z] = yield* Effect.forEach(["fresh", "x", "y", "z"], (name) =>
            keptPreview(`lru-${name}`),
          );
          if (fresh === undefined || x === undefined || y === undefined || z === undefined)
            return yield* Effect.die("missing previews");
          expect(
            yield* previews.assignTailnetPort(fresh.id, [...set, 31604]),
            "a port never used comes first",
          ).toEqual({ _tag: "Assigned", port: 31604 });
          const order = [];
          for (const preview of [x, y, z]) {
            const answer = yield* previews.assignTailnetPort(preview.id, set);
            order.push(answer._tag === "Assigned" ? answer.port : answer._tag);
          }
          expect(order, "used longest ago first").toEqual([31603, 31601, 31602]);
        }),
      );
    });

    it("replaces an assignment whose port left the set at the next open, and frees the old port", async () => {
      await run(
        Effect.gen(function* () {
          const previews = yield* PreviewsRepo;
          const moved = yield* keptPreview("moved");
          expect(yield* previews.assignTailnetPort(moved.id, [31401, 31402])).toEqual({
            _tag: "Assigned",
            port: 31401,
          });
          expect(yield* previews.assignTailnetPort(moved.id, [31402, 31403])).toEqual({
            _tag: "Assigned",
            port: 31402,
          });
          expect(yield* portRows([31401, 31402])).toEqual([
            { port: 31401, previewId: null, released: true },
            { port: 31402, previewId: moved.id, released: false },
          ]);
          expect(yield* previews.tailnetPorts([moved.id])).toEqual(new Map([[moved.id, 31402]]));
        }),
      );
    });

    it("refuses a port outside 1 to 65535", async () => {
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const outside = yield* Effect.flip(sql`INSERT INTO preview_ports (port) VALUES (65536)`);
          expect(Schema.decodeUnknownSync(CheckViolation)(outside.reason.cause).constraint).toBe(
            "preview_ports_port_check",
          );
        }),
      );
    });
  });
});
