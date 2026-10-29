import { PgClient } from "@effect/sql-pg";
import { ProjectId, SealantWorkspaceId, ServiceId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { RepoRelativePath, type ServiceLaunch } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { ServicesRepo, ServicesRepoLive } from "../src/repos/services.ts";
import { SessionProcessesRepo, SessionProcessesRepoLive } from "../src/repos/session-processes.ts";
import { postgresTestConfig } from "./postgres.ts";

/** Runs in a throwaway PostgreSQL database. See postgresTestConfig for local opt-out. */
const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_services_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(
  ServicesRepoLive,
  SessionsRepoLive,
  SessionProcessesRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))));

type Repos = ServicesRepo | SessionsRepo | SessionProcessesRepo | SqlClient.SqlClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-web");
const WORKTREE = WorktreeId.make("wt-1");
const HELD = SessionId.make("s-held");
const QUIET = SessionId.make("s-quiet");

describe.skipIf(postgres.skip)("Services that keep a workspace up, in Postgres", () => {
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

  it("remembers who started a Service, and reads it without changing the Service (docs/adr/0016)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const services = yield* ServicesRepo;
        yield* sql`
          INSERT INTO services (id, session_id, name, declaration_source, workspace_port)
          VALUES ('svc-person', ${HELD}, 'person', 'explicit-run', 3001)`;
        const before = yield* services.startedByOf(ServiceId.make("svc-person"));
        yield* services.setStartedBy(ServiceId.make("svc-person"), "user-maria");
        return {
          before,
          after: yield* services.startedByOf(ServiceId.make("svc-person")),
          service: (yield* services.byId(ServiceId.make("svc-person")))?.name ?? null,
        };
      }),
    );
    expect(result).toEqual({ before: null, after: "user-maria", service: "person" });
  });

  it("records an attempt's launch for its restart, and a Service's host policy and address (0143)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const services = yield* ServicesRepo;
        const processes = yield* SessionProcessesRepo;
        const service = yield* services.create({
          sessionId: HELD,
          name: "wp",
          declarationSource: "recipe-file",
          workspacePort: 8080,
          transport: "tcp",
          browserScheme: "http",
          bindAddresses: ["127.0.0.1"],
          hostPolicy: "preserve",
          address: "docker",
        });
        const attempt = (launch: ServiceLaunch | null) =>
          processes.create({
            sessionId: HELD,
            sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
            sealantSessionId: null,
            serviceId: service.id,
            kind: "service",
            label: "wp",
            argv: ["sh", "-c", "docker compose up"],
            launch,
          });
        const launched = yield* attempt({
          cwd: RepoRelativePath.make("deploy/wp"),
          env: { WP_ENV: "local" },
          ready: { _tag: "Http", path: "/wp-login.php", timeoutMs: 120_000 },
        });
        const explicit = yield* attempt(null);
        yield* sql`
          INSERT INTO services (id, session_id, name, declaration_source, workspace_port)
          VALUES ('svc-older', ${HELD}, 'older', 'explicit-run', 3002)`;
        return {
          service: (yield* services.byId(service.id)) ?? null,
          older: (yield* services.byId(ServiceId.make("svc-older"))) ?? null,
          launch: yield* processes.launchOf(launched.id),
          explicit: yield* processes.launchOf(explicit.id),
        };
      }),
    );
    expect(result.service).toMatchObject({ hostPolicy: "preserve", address: "docker" });
    expect(result.older, "a row from before 0143").toMatchObject({
      hostPolicy: "rewrite",
      address: "loopback",
    });
    expect(result.launch).toEqual({
      cwd: "deploy/wp",
      env: { WP_ENV: "local" },
      ready: { _tag: "Http", path: "/wp-login.php", timeoutMs: 120_000 },
    });
    expect(result.explicit, "an attempt with no recorded launch").toBeNull();
  });
});
