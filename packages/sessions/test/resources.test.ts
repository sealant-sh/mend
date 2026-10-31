import * as http from "node:http";

import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  OrganizationsRepoLive,
  ProjectEnvironmentRepo,
  ProjectEnvironmentRepoLive,
  ProjectSecretsRepoLive,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
  ResourceLoadsRepo,
  SessionsRepo,
  SessionsRepoLive,
  type StoredResourceDefinition,
  type StoredResourceLoad,
  UsersRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  OrganizationId,
  ProjectId,
  ResourceLoadId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  ImageDigest,
  ownDatabaseName,
  presetDefinition,
  PresetVersion,
  ResourceDefinitionInput,
  ResourceName,
  resourceStatusLine,
  type Viewer,
  type ServiceDependency,
  withPresetCommand,
} from "@mend/domain/workbench";
import {
  type ResourceScope,
  ResourceScopes,
  type ScopeInstance,
  type ScopeInstanceSpec,
} from "@mend/sealant";
import { Duration, Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ResourceImageResolver } from "../src/resources/image-resolver.ts";
import { Resources, ResourcesChannelLive, ResourcesLive } from "../src/resources/resources.ts";
import { ResourceRuntime, resourceRuntimeLayer } from "../src/resources/runtime.ts";
import { WorktreeServiceRestarts } from "../src/resources/service-restarts.ts";
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
const OWN = ownDatabaseName(WORKTREE);
const DIGEST = ImageDigest.make(`sha256:${"a".repeat(64)}`);

const MEND_TOML = `
[resource.mail]
image = "axllent/mailpit:v1.21"
ports = { smtp = 1025 }
env = { MP_UI_AUTH = "tom:hunter2" }
scope = "worktree"
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

let file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
const reads = Layer.mock(WorktreeReads, {
  readFile: () =>
    Effect.sync(() => ({
      value: {
        bytes: new TextEncoder().encode(file.text),
        size: file.text.length,
        truncated: false,
        binary: false,
      },
      stamp: file.stamp,
    })),
});

/**
 * Sealant's scope, in memory: each call recorded, an instance a person stopped held against `use`,
 * and an exec answering the own database script's last line.
 */
const sealant = {
  calls: [] as Array<string>,
  specs: new Map<string, ScopeInstanceSpec>(),
  instances: new Map<string, ScopeInstance>(),
  upDelay: Duration.zero,
  execAnswer: "copied",
};
const instanceOf = (
  key: string,
  spec: ScopeInstanceSpec,
  state: ScopeInstance["state"],
  stopReason: ScopeInstance["stopReason"],
): ScopeInstance => ({
  id: `rin:${key}`,
  key,
  alias: spec.alias,
  worktreeKey: spec.worktreeKey,
  specDigest: "d",
  desired: state.kind === "stopped" ? "stopped" : "running",
  stopReason,
  state,
  observedAt: new Date(),
  startedAt: null,
  lastReachedAt: null,
  volumes: [],
});
const fakeScope: ResourceScope = {
  id: "rdm:fake",
  up: (key, spec, cause) =>
    Effect.gen(function* () {
      sealant.calls.push(`up ${key} ${cause}`);
      sealant.specs.set(key, spec);
      yield* Effect.sleep(sealant.upDelay);
      const held = sealant.instances.get(key);
      if (held !== undefined && held.stopReason?.kind === "person" && cause === "use") return held;
      const running = instanceOf(key, spec, { kind: "running", since: new Date() }, null);
      sealant.instances.set(key, running);
      return running;
    }),
  get: (key) => Effect.succeed(sealant.instances.get(key) ?? null),
  list: () => Effect.sync(() => [...sealant.instances.values()]),
  stop: (key, by) =>
    Effect.sync(() => {
      sealant.calls.push(`stop ${key} ${by}`);
      const spec = sealant.specs.get(key);
      if (spec === undefined) throw new Error(`no instance ${key}`);
      const reason = { kind: "person" as const, by };
      const stopped = instanceOf(key, spec, { kind: "stopped", at: new Date(), reason }, reason);
      sealant.instances.set(key, stopped);
      return stopped;
    }),
  exec: (key, options) =>
    Effect.sync(() => {
      sealant.calls.push(`exec ${key} ${options.user} ${options.argv.slice(4).join(" ")}`);
      return {
        exitCode: 0,
        stdout: `${sealant.execAnswer}\n`,
        stderr: "",
        truncated: false,
        timedOut: false,
      };
    }),
  archiveScope: () => Effect.succeed([]),
  archive: (key) =>
    Effect.sync(() => {
      sealant.calls.push(`archive ${key}`);
      sealant.instances.delete(key);
      return [];
    }),
  link: (workspaceId, worktreeKey) =>
    Effect.sync(() => {
      sealant.calls.push(`link ${workspaceId} ${worktreeKey}`);
    }),
};
const scopes = Layer.succeed(ResourceScopes, {
  of: (key) =>
    key === `mend:${PROJECT}` ? Effect.succeed(fakeScope) : Effect.die(`no scope ${key}`),
});

const dbLayer = MendDBLive.pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(scratchUrl.toString()) })),
);
const repos = Layer.mergeAll(
  ResourcesRepoLive,
  ProjectsRepoLive,
  SessionsRepoLive,
  UsersRepoLive,
  WorktreesRepoLive,
  OrganizationsRepoLive,
  ProjectEnvironmentRepoLive,
  ProjectSecretsRepoLive,
).pipe(Layer.provideMerge(dbLayer));
const images = Layer.succeed(ResourceImageResolver, {
  resolve: () => Effect.succeed({ digest: DIGEST, resolvedBy: "registry.example" }),
});
const runtimeLayer = resourceRuntimeLayer(Duration.millis(300)).pipe(
  Layer.provideMerge(Layer.mergeAll(repos, reads, images, scopes)),
);
/** The loads the repo answers as each target's latest. */
let loadRows: ReadonlyArray<StoredResourceLoad> = [];
/** Each worktree whose Services a switch restarted, and by whom; it ran `web`. */
const restarted: Array<string> = [];
const restarts = Layer.succeed(WorktreeServiceRestarts, {
  restart: (worktreeId, by) =>
    Effect.sync(() => {
      restarted.push(`${worktreeId} ${by}`);
      return ["web"];
    }),
});
const resources = ResourcesLive.pipe(
  Layer.provide(Layer.mock(ResourceLoadsRepo, { latest: () => Effect.sync(() => loadRows) })),
  Layer.provideMerge(Layer.merge(runtimeLayer, restarts)),
);
const channel = ResourcesChannelLive.pipe(
  Layer.provideMerge(Layer.merge(resources, SessionChannelRegistryLive)),
);

const decodeSpec = Schema.decodeUnknownSync(ResourceDefinitionInput);
const runtime = ManagedRuntime.make(channel);
const clock = { now: new Date("2026-10-30T10:00:00Z"), timeZone: "Europe/Athens" };
const maria: Viewer = { userId: "u-maria", organizationId: ORG, role: "member" };

const definition = (name: string) =>
  Effect.flatMap(ResourcesRepo, (repo) => repo.byName(PROJECT, name)).pipe(
    Effect.flatMap((found) =>
      found === null ? Effect.die(new Error(`no @${name}`)) : Effect.succeed(found),
    ),
  );
const prepare = (
  dependencies: ReadonlyArray<ServiceDependency> = [],
  recipeEnv: Readonly<Record<string, string>> = {},
) =>
  runtime.runPromise(
    Effect.flatMap(ResourceRuntime, (live) =>
      live.prepare({
        projectId: PROJECT,
        worktreeId: WORKTREE,
        workspaceId: "ws-1",
        launcher: "u-tom",
        dependencies,
        recipeEnv,
      }),
    ),
  );
const serve = Effect.gen(function* () {
  const read = (yield* SessionChannelRegistry).resources();
  if (read === undefined) return yield* Effect.die(new Error("the channel serves no resources"));
  return read;
});
/** `mend resource <argv>` from inside the session: its lines, or why it was refused. */
const fromSession = (...argv: ReadonlyArray<string>) =>
  runtime.runPromise(
    Effect.flatMap(serve, (read) => read(SESSION, argv, clock)).pipe(
      Effect.map((answer) => answer.lines),
      Effect.catch((error) => Effect.succeed([`refused: ${error.message}`])),
    ),
  );

describe.skipIf(postgres.skip)("a project's resources, run and reached", () => {
  let db: StoredResourceDefinition;
  let cache: StoredResourceDefinition;

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
          yield* sql`INSERT INTO organization_members (organization_id, user_id, role)
            VALUES (${ORG}, ${id}, 'member')`;
        }
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id, created_by_user_id, visibility)
          VALUES (${PROJECT}, 'res', '/store/p-res/repo.git', 'main', ${ORG}, 'u-maria', 'shared')`;
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
        db = yield* repo.declare(
          PROJECT,
          {
            imageDigest: DIGEST,
            spec: presetDefinition({
              name: ResourceName.make("db"),
              preset: "postgres",
              version: PresetVersion.make("17"),
              scope: "project",
            }),
          },
          "u-maria",
        );
        cache = yield* repo.declare(
          PROJECT,
          {
            imageDigest: DIGEST,
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

  beforeEach(() => {
    sealant.calls.length = 0;
    sealant.upDelay = Duration.zero;
    file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
  });

  afterAll(async () => {
    await runtime.dispose();
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }).pipe(Effect.provide(adminLayer), Effect.scoped),
    );
  });

  it("before a process opens: adds the file's new names, links, starts what the worktree uses and makes its own database once", async () => {
    const prepared = await prepare();
    const mail = await runtime.runPromise(definition("mail"));
    expect(mail.addedBy).toBe("u-tom");
    expect(sealant.calls.toSorted()).toEqual(
      [
        `exec ${db.id} postgres ${OWN} app`,
        "link ws-1 wt-res",
        `up ${cache.id} use`,
        `up ${db.id} use`,
        `up ${mail.id}@${WORKTREE} use`,
      ].toSorted(),
    );
    expect(sealant.specs.get(`${mail.id}@${WORKTREE}`)?.worktreeKey).toBe(WORKTREE);
    expect(sealant.specs.get(db.id)?.env).toEqual({
      POSTGRES_HOST_AUTH_METHOD: "trust",
      POSTGRES_DB: "app",
    });
    expect(prepared.views).toEqual([]);
    expect(prepared.env).toMatchObject({
      DATABASE_URL: `postgres://postgres@db:5432/${OWN}`,
      PGDATABASE: OWN,
      REDIS_URL: "redis://cache:6379",
      MEND_RESOURCE_MAIL_HOST: "mail",
      MEND_RESOURCE_MAIL_PORT_SMTP: "1025",
    });

    sealant.calls.length = 0;
    await prepare();
    expect(sealant.calls.filter((call) => call.startsWith("exec"))).toEqual([]);
    const owns = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabases(WORKTREE)),
    );
    expect(owns.get(db.id)?.kind).toBe("copied");
  });

  it("keeps a person's stop against a launch, which starts with the env and says so", async () => {
    const stopped = await runtime.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* ProjectsRepo).byId(PROJECT);
        return yield* (yield* Resources).stop(project, maria, "db", null, clock);
      }),
    );
    expect(stopped.instance).toBe("stopped");
    expect(stopped.statusLine).toMatch(
      /^@db · postgres 17 · project · added by Maria · stopped by Maria · observed /,
    );
    const prepared = await prepare();
    expect(prepared.env["DATABASE_URL"]).toBe(`postgres://postgres@db:5432/${OWN}`);
    expect(prepared.views.map((view) => resourceStatusLine(view, clock))).toEqual([
      "@db · stopped by Maria · this session starts without it",
    ]);

    const started = await runtime.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* ProjectsRepo).byId(PROJECT);
        return yield* (yield* Resources).start(project, maria, "db", null, clock);
      }),
    );
    expect(started.instance).toBe("running");
    expect((await prepare()).views).toEqual([]);
  });

  it("maps exports for a required resource and refuses a conventional name a recipe sets", async () => {
    const prepared = await prepare([
      {
        kind: "resource",
        name: "db",
        env: { TEST_DATABASE_URL: "url", TEST_DATABASE: "database", DB_LOGIN: "username" },
      },
    ]);
    expect(prepared.refusal).toBeUndefined();
    expect(prepared.env).toMatchObject({
      TEST_DATABASE_URL: `postgres://postgres@db:5432/${OWN}`,
      TEST_DATABASE: OWN,
      DB_LOGIN: "postgres",
    });
    expect(
      (await prepare([{ kind: "resource", name: "db", env: {} }], { DATABASE_URL: "literal" }))
        .refusal,
    ).toBe("DATABASE_URL comes from @db");
  });

  it("a preview wake starts an idle resource and holds a person's stop by name", async () => {
    await prepare();
    const spec = sealant.specs.get(db.id);
    if (spec === undefined) throw new Error("db did not start");
    const idle = { kind: "idle" } satisfies NonNullable<ScopeInstance["stopReason"]>;
    sealant.instances.set(
      db.id,
      instanceOf(db.id, spec, { kind: "stopped", at: new Date(), reason: idle }, idle),
    );
    const dependencies: ReadonlyArray<ServiceDependency> = [
      { kind: "resource", name: "db", env: {} },
    ];
    const woken = await prepare(dependencies);
    expect(woken.refusal).toBeUndefined();
    expect(sealant.instances.get(db.id)?.state.kind).toBe("running");
    await runtime.runPromise(fakeScope.stop(db.id, "Maria"));
    const held = await prepare(dependencies);
    expect(held.refusal).toBe("@db stopped by Maria");
    expect(held.resourceStopped).toEqual({ name: "db", by: "Maria" });
    expect(sealant.instances.get(db.id)?.state.kind).toBe("stopped");
    await runtime.runPromise(fakeScope.up(db.id, spec, "person"));
  });

  it("a missing or off resource refuses its dependent before any start", async () => {
    expect((await prepare([{ kind: "resource", name: "absent", env: {} }])).refusal).toContain(
      "@absent · no resource in this project",
    );
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) =>
        repo.setSelection(PROJECT, WORKTREE, db.id, "off", "u-maria"),
      ),
    );
    const before = sealant.calls.length;
    expect((await prepare([{ kind: "resource", name: "db", env: {} }])).refusal).toBe(
      "@db · this worktree has it off · mend resource use db shared",
    );
    expect(sealant.calls.length).toBe(before);
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) =>
        repo.setSelection(PROJECT, WORKTREE, db.id, "own", "u-maria"),
      ),
    );
  });

  it("opens a process past the bound with the same env, and the start goes on", async () => {
    sealant.upDelay = Duration.seconds(1);
    const prepared = await prepare();
    expect(prepared.env["DATABASE_URL"]).toBe(`postgres://postgres@db:5432/${OWN}`);
    expect(prepared.views.map((view) => resourceStatusLine(view, clock)).toSorted()).toEqual([
      "@cache · starting · this session starts without it",
      "@db · starting · this session starts without it",
      "@mail · starting · this session starts without it",
    ]);
  });

  it("leaves a name the project sets as the project sets it, and says so", async () => {
    await runtime.runPromise(
      Effect.flatMap(ProjectEnvironmentRepo, (environment) =>
        environment.create(PROJECT, { name: "DATABASE_URL", value: "postgres://elsewhere/app" }),
      ),
    );
    const prepared = await prepare();
    expect(prepared.env["DATABASE_URL"]).toBeUndefined();
    expect(prepared.env["PGDATABASE"]).toBe(OWN);
    expect(prepared.views.map((view) => resourceStatusLine(view, clock))).toEqual([
      "@db · DATABASE_URL left as the project sets it",
    ]);
  });

  it("answers the agent's mend resource as the session's owner", async () => {
    const list = await fromSession("list");
    expect(list).toEqual([
      "@cache · running · shared · observed 0 s ago",
      expect.stringMatching(
        /^@db · running · own database · copied from shared .+ · observed 0 s ago$/,
      ),
      "@mail · running · its own instance · observed 0 s ago",
      "mend.toml · observed on the worktree",
      "@mail · mailpit · worktree · in mend.toml · same as settings",
      "  resource.mail.device · is ignored: this Mend does not read it",
    ]);
    for (const secret of ["hunter2", "u-tom", "u-maria", DIGEST]) {
      expect(JSON.stringify(list)).not.toContain(secret);
    }
    expect(await fromSession("stop", "db")).toEqual([
      expect.stringMatching(/^@db · postgres 17 · project · added by Maria · stopped by Tom · /),
    ]);
    expect(await fromSession("start", "db")).toEqual([
      expect.stringMatching(/^@db · postgres 17 · project · added by Maria · running · /),
    ]);
    // Tom owns the worktree's first session, so its choices are his.
    expect(await fromSession("use", "cache", "off")).toEqual([
      "@cache · off · agents and shells keep their env until they restart",
    ]);
    expect(restarted).toEqual(["wt-res u-tom"]);
    // The same choice again changes nothing, so nothing restarts.
    await fromSession("use", "cache", "off");
    expect(restarted).toEqual(["wt-res u-tom"]);
    expect(await fromSession("use", "db", "copy")).toEqual([
      "refused: name a choice: mend resource use db shared|own|off",
    ]);
    const exports = await fromSession("env");
    expect(exports).toContain(`export PGDATABASE='${OWN}'`);
    expect(exports).toContain("# @db · DATABASE_URL left as the project sets it");
    expect(exports.some((line) => line.includes("REDIS_URL"))).toBe(false);
    expect(await fromSession("stop", "nope")).toEqual([
      "refused: no @nope in this project · mend resource list shows them",
    ]);
  });

  it("shows a load while it runs, and the runtime's line again once it has finished", async () => {
    const load = (phase: StoredResourceLoad["phase"]): StoredResourceLoad => ({
      id: ResourceLoadId.make("rload_1"),
      projectId: PROJECT,
      definitionId: db.id,
      worktreeId: WORKTREE,
      instanceKey: db.id,
      database: OWN,
      target: "own",
      label: "staging.dump",
      startedBy: "u-tom",
      phase,
      bytesDone: 40_000_000,
      bytesTotal: 120_000_000,
      savedPath: null,
      savedAt: null,
      message: null,
      createdAt: new Date(),
    });
    const dbLine = async () => (await fromSession("list")).find((line) => line.startsWith("@db"));
    try {
      loadRows = [load("restoring")];
      expect(await dbLine()).toMatch(/^@db · loading staging\.dump · restoring /);
      for (const phase of ["done", "failed"] as const) {
        loadRows = [load(phase)];
        expect(await dbLine()).toMatch(/^@db · running · own database · /);
      }
    } finally {
      loadRows = [];
    }
  });

  it("resets a worktree's own database: saves a dump, then copies shared again", async () => {
    sealant.execAnswer = "saved copied";
    const lines = await fromSession("reset", "db");
    expect(lines).toEqual([
      expect.stringMatching(
        /^@db · own database reset · copied from shared · previous data saved as a dump .+$/,
      ),
    ]);
    expect(sealant.calls.filter((call) => call.startsWith("exec"))).toEqual([
      `exec ${db.id} root `,
      expect.stringMatching(
        new RegExp(
          `^exec ${db.id} postgres ${OWN} app 1 /mend/dumps/${OWN}-\\d{8}T\\d{6}Z\\.dump$`,
        ),
      ),
    ]);
    sealant.execAnswer = "saved empty";
    expect(await fromSession("reset", "db", "--target", "shared")).toEqual([
      expect.stringMatching(
        /^@db · shared database reset · empty · previous data saved as a dump /,
      ),
    ]);
    expect(await fromSession("reset", "cache")).toEqual([
      "refused: @cache · a reset saves and empties a Postgres database, and @cache is not one",
    ]);
    sealant.execAnswer = "copied";
  });

  it("answers a file that does not parse over HTTP with its stamp and position, never its source", async () => {
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
      const response = await fetch(`http://127.0.0.1:${port}/resources?timeZone=Europe%2FAthens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ argv: ["list"] }),
      });
      const wire = await response.text();
      expect(response.status).toBe(200);
      expect(JSON.parse(wire).lines.at(-1)).toBe(
        "mend.toml · observed at capture 2 · seq 1 · partial · mend.toml is not valid TOML: line 5, column 44 · unexpected character encountered",
      );
      for (const excerpt of ["fake-value-gate1201", "MP_UI_AUTH", "BAD", "/dev/null"]) {
        expect(wire).not.toContain(excerpt);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("archives a removed definition's instances and keeps their volumes", async () => {
    const lines = await fromSession("remove", "cache");
    expect(lines).toEqual(["@cache · definition removed · its volumes are kept"]);
    expect(sealant.calls).toContain(`archive ${cache.id}`);
  });

  it("refuses a person's read of a project they cannot see, in the service itself", async () => {
    const outcome = await runtime.runPromise(
      Effect.gen(function* () {
        const project = yield* (yield* ProjectsRepo).byId(PROJECT);
        const outsider: Viewer = {
          userId: "eve",
          organizationId: OrganizationId.make("org-elsewhere"),
          role: "owner",
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
