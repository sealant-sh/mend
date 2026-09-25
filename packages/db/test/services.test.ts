import { PgClient } from "@effect/sql-pg";
import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { ServicesRepo, ServicesRepoLive } from "../src/repos/services.ts";

/**
 * docs/SESSION-SERVICES.md, "Stop": which Services keep a session's workspace up, against the dev
 * Postgres (`compose.dev.yaml`, :5434) in a throwaway database. Without one reachable these skip
 * rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_services_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(ServicesRepoLive, SessionsRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

type Repos = ServicesRepo | SessionsRepo | SqlClient.SqlClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const PROJECT = ProjectId.make("p-web");
const WORKTREE = WorktreeId.make("wt-1");
const HELD = SessionId.make("s-held");
const QUIET = SessionId.make("s-quiet");

describe.skipIf(!reachable)("Services that keep a workspace up, in Postgres", () => {
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
        const sessions = yield* SessionsRepo;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt")
          VALUES ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
        const base = {
          projectId: PROJECT,
          worktreeId: WORKTREE,
          harness: "claude",
          label: null,
          worktree: "wt-1",
          branch: "mend/wt-1",
          baseSha: Sha.make("abc"),
          baseRef: "main",
          contextSnapshotId: null,
          ownerUserId: "alice",
          origin: "mend" as const,
        };
        yield* sessions.create({ ...base, id: HELD });
        yield* sessions.create({ ...base, id: QUIET });
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

  it("counts a running attempt and an open forward, and nothing that ended", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const services = yield* ServicesRepo;
        const service = (id: string, session: SessionId, name: string) => sql`
          INSERT INTO services (id, session_id, name, declaration_source, workspace_port)
          VALUES (${id}, ${session}, ${name}, 'explicit-run', 3000)`;
        const attempt = (id: string, session: SessionId, serviceId: string, exited: boolean) => sql`
          INSERT INTO session_processes
            (id, session_id, sealant_workspace_id, kind, status, service_id, attempt_ordinal,
             exited_at)
          VALUES (${id}, ${session}, 'ws-1', 'service', ${exited ? "stopped" : "running"},
                  ${serviceId}, 1, ${exited ? new Date() : null})`;
        const forward = (id: string, serviceId: string, state: string) => sql`
          INSERT INTO service_forwards (id, service_id, sealant_workspace_id, state)
          VALUES (${id}, ${serviceId}, 'ws-1', ${state})`;

        // Held: a supervised Service still running, and an adopted port still bound.
        yield* service("svc-web", HELD, "web");
        yield* attempt("att-web", HELD, "svc-web", false);
        yield* sql`UPDATE services SET current_attempt_id = 'att-web' WHERE id = 'svc-web'`;
        yield* service("svc-db", HELD, "db");
        yield* forward("fwd-db", "svc-db", "bound");
        yield* sql`UPDATE services SET current_forward_id = 'fwd-db' WHERE id = 'svc-db'`;
        // Held too, but not by these: an attempt that exited and a forward that closed.
        yield* service("svc-old", HELD, "old");
        yield* attempt("att-old", HELD, "svc-old", true);
        yield* forward("fwd-old", "svc-old", "closed");
        yield* sql`
          UPDATE services SET current_attempt_id = 'att-old', current_forward_id = 'fwd-old'
          WHERE id = 'svc-old'`;
        // Quiet: a declaration with neither.
        yield* service("svc-idle", QUIET, "idle");

        const counts = yield* services.liveCountsForSessions([HELD, QUIET]);
        expect(counts.get(HELD)).toBe(2);
        expect(counts.has(QUIET)).toBe(false);
        expect((yield* services.liveCountsForSessions([])).size).toBe(0);
      }),
    );
  });

  it("records who stopped a session's Services in its control log", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO session_control_events (id, session_id, actor_user_id, kind)
          VALUES ('ctl-1', ${HELD}, 'alice', 'services-stop')`;
        const rows = yield* sql<{ readonly kind: string }>`
          SELECT kind FROM session_control_events WHERE id = 'ctl-1'`;
        expect(rows.map((row) => row.kind)).toEqual(["services-stop"]);
      }),
    );
  });
});
