import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
  SessionsRepo,
  SessionsRepoLive,
  UsersRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import { ResourceDefinitionInput, WORKSPACE_RESOURCE_REFUSAL } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Resources, ResourcesChannelLive, ResourcesLive } from "../src/resources/resources.ts";
import { SessionChannelRegistry, SessionChannelRegistryLive } from "../src/session-channel.ts";
import { WORKTREE_STAMP, WorktreeReads } from "../src/worktree-reads.ts";

const postgres = postgresTestConfig();
const SCRATCH_DB = `mend_resources_session_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${SCRATCH_DB}`;
const adminLayer = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });

const PROJECT = ProjectId.make("p-res");
const WORKTREE = WorktreeId.make("wt-res");
const SESSION = SessionId.make("s-res");
const ORG = OrganizationId.make("org-res");

const MEND_TOML = `
[resource.mail]
image = "axllent/mailpit:v1.21"
ports = { smtp = 1025 }
env = { MP_UI_AUTH = "tom:hunter2" }
device = "/dev/null"
`;

const asked: Array<string> = [];
const reads = Layer.mock(WorktreeReads, {
  readFile: (_project, worktree, relative) =>
    Effect.sync(() => {
      asked.push(`${worktree}:${relative}`);
      return {
        value: {
          bytes: new TextEncoder().encode(MEND_TOML),
          size: MEND_TOML.length,
          truncated: false,
          binary: false,
        },
        stamp: WORKTREE_STAMP,
      };
    }),
});

const dbLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
);
const repos = Layer.mergeAll(
  ResourcesRepoLive,
  ProjectsRepoLive,
  SessionsRepoLive,
  UsersRepoLive,
).pipe(Layer.provideMerge(dbLayer));
const resources = ResourcesLive.pipe(Layer.provideMerge(Layer.merge(repos, reads)));
const channel = ResourcesChannelLive.pipe(
  Layer.provideMerge(Layer.merge(resources, SessionChannelRegistryLive)),
);

const decodeSpec = Schema.decodeUnknownSync(ResourceDefinitionInput);
const runtime = ManagedRuntime.make(channel);
const clock = { now: new Date("2026-10-30T10:00:00Z"), timeZone: "Europe/Athens" };

describe.skipIf(postgres.skip)("a session's read of its project's resources, end to end", () => {
  beforeAll(async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`INSERT INTO organizations (id, name) VALUES (${ORG}, 'res')`;
        for (const [id, name] of [
          ["u-maria", "Maria"],
          ["u-tom", "Tom"],
        ]) {
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt")
            VALUES (${id}, ${name}, ${`${id}@example.invalid`}, '2026-01-01T00:00:00Z')`;
        }
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id, created_by_user_id)
          VALUES (${PROJECT}, 'res', '/store/p-res/repo.git', 'main', ${ORG}, 'u-maria')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-res', 'wt-res', 'mend/wt-res', 'abc')`;
        yield* (yield* SessionsRepo).create({
          id: SESSION,
          projectId: PROJECT,
          worktreeId: WORKTREE,
          harness: "claude",
          label: null,
          worktree: "wt-res",
          branch: "mend/wt-res",
          baseSha: Sha.make("abc"),
          baseRef: "main",
          contextSnapshotId: null,
          ownerUserId: "u-tom",
          origin: "mend",
        });
        const repo = yield* ResourcesRepo;
        yield* repo.declare(
          PROJECT,
          decodeSpec({
            name: "queue",
            scope: "project",
            preset: null,
            image: "rabbitmq:4-management",
            command: null,
            ports: [{ name: "amqp", port: 5672, protocol: "tcp" }],
            env: { RABBITMQ_DEFAULT_PASS: "s3cret-literal" },
            volumes: [],
            ready: { kind: "tcp" },
            exports: {},
          }),
          "u-maria",
        );
        yield* repo.propose(
          PROJECT,
          decodeSpec({
            name: "cache",
            scope: "project",
            preset: "redis",
            image: "redis:8",
            command: null,
            ports: [{ name: "redis", port: 6379, protocol: "tcp" }],
            env: {},
            volumes: [{ name: "data", mountPath: "/data" }],
            ready: { kind: "preset" },
            exports: {},
          }),
          "u-tom",
        );
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await runtime.dispose();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
  });

  const serve = Effect.gen(function* () {
    const read = (yield* SessionChannelRegistry).resources();
    if (read === undefined) return yield* Effect.die(new Error("the channel serves no resources"));
    return read;
  });

  it("reads its project's status lines and its own worktree's file, and nothing a spec holds", async () => {
    asked.length = 0;
    const status = await runtime.runPromise(
      Effect.flatMap(serve, (read) => read(SESSION, { kind: "read" }, clock)),
    );
    expect(asked).toEqual([`${WORKTREE}:mend.toml`]);
    expect(status).toEqual({
      statusLines: [
        "@queue · rabbitmq 4 · project · waiting for approval",
        "@cache · redis 8 · project · proposed by Tom · waiting for approval",
      ],
      file: {
        kind: "read",
        observed: "observed on the worktree",
        statusLines: ["@mail · mailpit · project · proposed in mend.toml · waiting for approval"],
        notices: ["resource.mail.device · is ignored: this Mend does not read it"],
      },
    });
    const wire = JSON.stringify(status);
    for (const secret of ["s3cret-literal", "hunter2", "u-tom", "u-maria", "digest", "spec"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("refuses every change a workspace asks, in the permission function's words", async () => {
    for (const act of [
      { kind: "propose" },
      { kind: "remove-definition" },
      { kind: "remove-proposal", proposedBy: "u-tom" },
    ] as const) {
      const outcome = await runtime.runPromise(
        Effect.flatMap(serve, (read) => read(SESSION, act, clock)).pipe(Effect.result),
      );
      expect(Result.isFailure(outcome) ? outcome.failure.message : "answered").toBe(
        WORKSPACE_RESOURCE_REFUSAL,
      );
    }
  });

  it("refuses a person's read of a project they cannot see, in the service itself", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* ProjectsRepo).byId(PROJECT);
        const outsider = {
          kind: "person" as const,
          viewer: {
            userId: "eve",
            organizationId: OrganizationId.make("org-elsewhere"),
            role: "owner" as const,
          },
        };
        return yield* (yield* Resources).list(project, outsider, null, clock);
      }).pipe(Effect.result),
    );
    expect(Result.isFailure(outcome) ? outcome.failure : "read").toMatchObject({
      _tag: "ResourceActRefusedError",
      message: "is not a project you can see",
    });
  });
});
