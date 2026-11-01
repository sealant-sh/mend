import { randomUUID } from "node:crypto";

import { NodeCrypto } from "@effect/platform-node";
import { PgClient } from "@effect/sql-pg";
import {
  InstanceRolesRepoLive,
  MendDBLive,
  migrations,
  OrganizationsRepoLive,
  PreviewGrantsRepoLive,
  PreviewsRepo,
  PreviewsRepoLive,
  ProjectsRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  type TicketCredential,
  UpgradeTicketsRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import type { Preview } from "@mend/domain/workbench";
import { Effect, Layer, Redacted, String as Str } from "effect";
import { SqlClient } from "effect/sql";

import { ProjectAccessLive } from "../../src/access.ts";

/** One viewer's pool holds at most six forwards, so tests that need more forwards use more people. */
export const PEOPLE = ["alice", "carol", "dave", "erin", "frank", "gina"] as const;

export const PREVIEW_WORKSPACE = "ws-1";
export const SERVICES = {
  web: { id: "svc-web", attemptId: "att-web-1", port: 3000 },
  docs: { id: "svc-docs", attemptId: "att-docs-1", port: 3001 },
} as const;
export type ServiceKey = keyof typeof SERVICES;
export const SERVICE_KEYS: ReadonlyArray<ServiceKey> = ["web", "docs"];

export type KeptPreview = Extract<Preview, { readonly state: "kept" }>;

export interface PreviewDatabase {
  readonly url: string;
  readonly previews: Readonly<Record<ServiceKey, KeptPreview>>;
  readonly drop: () => Promise<void>;
}

const pgLayer = (url: string) =>
  PgClient.layer({
    url: Redacted.make(url),
    maxConnections: 6,
    transformResultNames: Str.snakeToCamel,
    transformQueryNames: Str.camelToSnake,
  });

export const previewReposLayer = (url: string) =>
  Layer.mergeAll(
    PreviewsRepoLive.pipe(Layer.provide(NodeCrypto.layer)),
    PreviewGrantsRepoLive,
    UpgradeTicketsRepoLive,
    SessionsRepoLive,
    SessionProcessesRepoLive,
    OrganizationsRepoLive,
    ProjectAccessLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          InstanceRolesRepoLive,
          OrganizationsRepoLive,
          ProjectsRepoLive,
          ServicesRepoLive,
          SessionProcessesRepoLive,
          SessionsRepoLive,
          WorktreeChangesRepoLive,
          WorktreesRepoLive,
        ),
      ),
    ),
  ).pipe(Layer.provideMerge(MendDBLive), Layer.provideMerge(pgLayer(url)));

const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
    ([, migration]) => migration,
    { discard: true },
  );
  for (const userId of PEOPLE) {
    yield* sql`INSERT INTO "user" ("id", "name", "email", "createdAt")
      VALUES (${userId}, ${userId}, ${`${userId}@example.com`}, now())`;
  }
  yield* sql`INSERT INTO organizations (id, name) VALUES ('org-a', 'A')`;
  for (const userId of PEOPLE) {
    yield* sql`INSERT INTO organization_members (organization_id, user_id, role)
      VALUES ('org-a', ${userId}, ${userId === "alice" ? "owner" : "member"})`;
  }
  yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id,
      visibility, created_by_user_id)
    VALUES ('p-1', 'p-1', '/store/p-1', 'main', 'org-a', 'shared', 'alice')`;
  yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
    VALUES ('wt-1', 'p-1', 'wt-1', 'wt-1', 'mend/wt-1', 'abc')`;
  yield* (yield* SessionsRepo).create({
    id: SessionId.make("s-1"),
    projectId: ProjectId.make("p-1"),
    worktreeId: WorktreeId.make("wt-1"),
    harness: "claude",
    label: null,
    worktree: "wt-1",
    branch: "mend/wt-1",
    baseSha: Sha.make("abc"),
    baseRef: "main",
    contextSnapshotId: null,
    ownerUserId: "alice",
    origin: "mend",
  });
  for (const key of SERVICE_KEYS) {
    const service = SERVICES[key];
    yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port,
        browser_scheme)
      VALUES (${service.id}, 's-1', ${key}, 'explicit-run', ${service.port}, 'http')`;
    yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, status,
        service_id, attempt_ordinal, argv, sealant_session_id, created_at)
      VALUES (${service.attemptId}, 's-1', ${PREVIEW_WORKSPACE}, 'service', 'running',
        ${service.id}, 1, '["npm", "run", "dev"]'::jsonb, ${`pty-${service.attemptId}`},
        ${new Date("2026-10-25T08:00:00Z")})`;
    yield* sql`UPDATE services SET current_attempt_id = ${service.attemptId}
      WHERE id = ${service.id}`;
  }
  const views = yield* (yield* PreviewsRepo).ensureForWorktree(WorktreeId.make("wt-1"));
  const kept = (key: ServiceKey) => {
    const preview = views.find((view) => view.preview.serviceName === key)?.preview;
    return preview?.state === "kept"
      ? Effect.succeed(preview)
      : Effect.die(`no kept preview for ${key}`);
  };
  return { web: yield* kept("web"), docs: yield* kept("docs") };
});

export const createPreviewDatabase = async (tag: string): Promise<PreviewDatabase> => {
  const postgres = postgresTestConfig();
  const name = `mend_${tag}_${process.pid}_${Date.now()}`;
  const url = new URL(postgres.adminUrl);
  url.pathname = `/${name}`;
  const admin = (statement: string) =>
    Effect.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
        Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
        Effect.scoped,
        Effect.asVoid,
      ),
    );
  await admin(`CREATE DATABASE ${name}`);
  const drop = () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  try {
    const previews = await Effect.runPromise(
      seed.pipe(Effect.provide(previewReposLayer(url.toString())), Effect.scoped),
    );
    return { url: url.toString(), previews, drop };
  } catch (error) {
    await drop();
    throw error;
  }
};

export const signInRow = (
  userId: string,
): Effect.Effect<TicketCredential, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = `sign-in-${randomUUID()}`;
    yield* sql`INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
      VALUES (${id}, '2100-01-01T00:00:00Z', ${`token-${id}`}, now(), now(), ${userId})`.pipe(
      Effect.orDie,
    );
    const credential: TicketCredential = `session:${id}`;
    return credential;
  });

export const exitAttempts = (key: ServiceKey): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql`UPDATE session_processes SET exited_at = now(), status = 'exited'
      WHERE service_id = ${SERVICES[key].id} AND exited_at IS NULL`.pipe(
      Effect.orDie,
      Effect.asVoid,
    ),
  );
