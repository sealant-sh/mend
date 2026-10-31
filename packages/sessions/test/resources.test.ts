import * as http from "node:http";

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
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { OrganizationId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  ResourceDefinitionInput,
  withPresetCommand,
  WORKSPACE_RESOURCE_REFUSAL,
} from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ResourceImageResolver } from "../src/resources/image-resolver.ts";
import { Resources, ResourcesChannelLive, ResourcesLive } from "../src/resources/resources.ts";
import {
  handleSessionRequest,
  SessionChannelRegistry,
  SessionChannelRegistryLive,
} from "../src/session-channel.ts";
import type { SessionSocketApi } from "../src/session-socket.ts";
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

/** The merge-gate verifier's file (mend#1201): an env value on the line that does not parse. */
const VERIFIER_FILE = `
[resource.mail]
image = "axllent/mailpit:v1.21"
ports = { smtp = 1025 }
env = { MP_UI_AUTH = "fake-value-gate1201" BAD }
device = "/dev/null"
`;

const notHere = () => Effect.die("not in this test");
const sessionApi: SessionSocketApi = {
  recipes: notHere,
  listServices: notHere,
  runServiceRecipe: notHere,
  runService: notHere,
  addService: notHere,
  stopService: notHere,
  restartService: notHere,
  stopSession: notHere,
  land: notHere,
  agentHook: notHere,
  mcpCaller: notHere,
  resourceSession: () => Effect.succeed(SESSION),
  listRepositories: notHere,
  addableProjects: notHere,
  addRepository: notHere,
  gitTransport: notHere,
  gitTransportDone: notHere,
};

const asked: Array<string> = [];
let file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
const reads = Layer.mock(WorktreeReads, {
  readFile: (_project, worktree, relative) =>
    Effect.sync(() => {
      asked.push(`${worktree}:${relative}`);
      return {
        value: {
          bytes: new TextEncoder().encode(file.text),
          size: file.text.length,
          truncated: false,
          binary: false,
        },
        stamp: file.stamp,
      };
    }),
});

const dbLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
);
/** Each worktree whose sessions were listed, which is how a change owner is looked up. */
const ownerLookups: Array<string> = [];
const countedSessions = Layer.effect(
  SessionsRepo,
  Effect.map(SessionsRepo, (live) => ({
    ...live,
    listForWorktree: (worktreeId: WorktreeId) => {
      ownerLookups.push(worktreeId);
      return live.listForWorktree(worktreeId);
    },
  })),
).pipe(Layer.provide(SessionsRepoLive));
const repos = Layer.mergeAll(
  ResourcesRepoLive,
  ProjectsRepoLive,
  countedSessions,
  UsersRepoLive,
  WorktreesRepoLive,
).pipe(Layer.provideMerge(dbLayer));
const images = Layer.mock(ResourceImageResolver, {});
const resources = ResourcesLive.pipe(Layer.provideMerge(Layer.mergeAll(repos, reads, images)));
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
        const imageDigest = ImageDigest.make(`sha256:${"a".repeat(64)}`);
        yield* repo.declare(
          PROJECT,
          {
            imageDigest,
            spec: decodeSpec({
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
          },
          "u-maria",
        );
        yield* repo.declare(
          PROJECT,
          {
            imageDigest,
            spec: withPresetCommand(
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
            ),
          },
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
    ownerLookups.length = 0;
    const status = await runtime.runPromise(
      Effect.flatMap(serve, (read) => read(SESSION, { kind: "read" }, clock)),
    );
    expect(asked).toEqual([`${WORKTREE}:mend.toml`]);
    // A workspace's read carries no flags, so it looks up no change owner.
    expect(ownerLookups).toEqual([]);
    expect(status).toEqual({
      statusLines: [
        "@cache · redis 8 · project · added by Tom · not started",
        "@queue · rabbitmq 4 · project · added by Maria · not started",
      ],
      file: {
        kind: "read",
        observed: "observed on the worktree",
        statusLines: ["@mail · mailpit · project · in mend.toml · not in settings"],
        notices: ["resource.mail.device · is ignored: this Mend does not read it"],
      },
    });
    const wire = JSON.stringify(status);
    for (const secret of ["s3cret-literal", "hunter2", "u-tom", "u-maria", "digest", "spec"]) {
      expect(wire).not.toContain(secret);
    }
  });

  it("answers a file that does not parse with its stamp and position over HTTP, never its source", async () => {
    file = {
      text: VERIFIER_FILE,
      stamp: { ...WORKTREE_STAMP, source: "capture", captureN: 2, seq: "1", partial: true },
    };
    const registry = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* SessionChannelRegistry;
      }),
    );
    const server = http.createServer((request, response) => {
      void handleSessionRequest(sessionApi, request, response, registry);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/resources?timeZone=Europe%2FAthens`);
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(wire).file).toEqual({
        kind: "unparsed",
        observed: "observed at capture 2 · seq 1 · partial",
        message:
          "mend.toml is not valid TOML: line 5, column 44 · unexpected character encountered",
      });
      for (const excerpt of ["fake-value-gate1201", "MP_UI_AUTH", "BAD", "smtp", "/dev/null"]) {
        expect(wire).not.toContain(excerpt);
      }
    } finally {
      file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses every change a workspace asks, in the permission function's words", async () => {
    for (const act of [
      { kind: "add", replaces: null },
      { kind: "remove-definition", addedBy: "u-tom" },
      { kind: "use", changeOwner: "u-tom" },
    ] as const) {
      const outcome = await runtime.runPromise(
        Effect.flatMap(serve, (read) => read(SESSION, act, clock)).pipe(Effect.result),
      );
      expect(Result.isFailure(outcome) ? outcome.failure.message : "answered").toBe(
        WORKSPACE_RESOURCE_REFUSAL,
      );
    }
  });

  it("says the worktree's stored choice in its workspace's read", async () => {
    const statusLines = await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ResourcesRepo;
        const queue = yield* repo.byName(PROJECT, "queue");
        if (queue === null) return yield* Effect.die(new Error("no @queue"));
        yield* repo.setSelection(PROJECT, WORKTREE, queue.id, { mode: "off" }, "u-tom");
        const read = yield* serve;
        return (yield* read(SESSION, { kind: "read" }, clock)).statusLines;
      }),
    );
    expect(statusLines[1]).toBe(
      "@queue · rabbitmq 4 · project · added by Maria · off · not started",
    );
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
