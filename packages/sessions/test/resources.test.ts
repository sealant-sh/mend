import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  ResourceArchivesRepo,
  ResourceArchivesRepoLive,
  ServicesRepoLive,
  SessionProcessesRepo,
  SessionProcessesRepoLive,
  migrations,
  OrganizationsRepoLive,
  ProjectEnvironmentRepoLive,
  ProjectSecretsRepoLive,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourcesRepo,
  ResourcesRepoLive,
  ResourceLoadsRepo,
  SessionsRepo,
  SessionsRepoLive,
  type StoredResourceInstance,
  type StoredResourceLoad,
  UsersRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import {
  AgentTurnId,
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionMessageId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  AgentTurn,
  ImageDigest,
  ownDatabaseName,
  presetDefinition,
  PresetVersion,
  ResourceName,
  type Viewer,
  type ServiceDependency,
} from "@mend/domain/workbench";
import {
  type ResourceScope,
  ResourceScopes,
  SealantClient,
  type ScopeInstance,
  type ScopeInstanceSpec,
} from "@mend/sealant";
import { Duration, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionEngine, SessionTurnRefusedError } from "../src/engine.ts";
import {
  type AppendResourceTableResult,
  ResourceTableWrites,
} from "../src/resources/append-table.ts";
import { ResourceImageResolver } from "../src/resources/image-resolver.ts";
import { ResourceRemoval, ResourceRemovalLive } from "../src/resources/removal.ts";
import { Resources, ResourcesChannelLive, ResourcesLive } from "../src/resources/resources.ts";
import { ResourceRuntime, resourceRuntimeLayer } from "../src/resources/runtime.ts";
import {
  WorktreeServiceRestartsLive,
  WorktreeServiceRestarts,
} from "../src/resources/service-restarts.ts";
import { ResourceStatusReadsLive } from "../src/resources/status-reads.ts";
import { ResourceTableReadsLive } from "../src/resources/worktree-tables.ts";
import { SessionChannelRegistry, SessionChannelRegistryLive } from "../src/session-channel.ts";
import { SessionRepository } from "../src/session-repository.ts";
import { WORKTREE_STAMP, WorktreeReads } from "../src/worktree-reads.ts";
import { execAnswer, fakeWorkspace } from "./fake-workspace.ts";

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

/** The merge-gate verifier's file (mend#1201): an env value on the line that does not parse. */
const VERIFIER_FILE = `
[resource.mail]
image = "axllent/mailpit:v1.21"
ports = { smtp = 1025 }
env = { MP_UI_AUTH = "fake-value-gate1201" BAD }
device = "/dev/null"
`;

let file = { text: "", stamp: WORKTREE_STAMP };
let defaultFile: string | undefined;
let workspaceFile: string | undefined;

const reads = Layer.mock(WorktreeReads, {
  readDefaultBranchFile: () =>
    Effect.sync(() => ({
      value: {
        bytes: new TextEncoder().encode(defaultFile ?? file.text),
        size: (defaultFile ?? file.text).length,
        truncated: false,
        binary: false,
      },
      stamp: file.stamp,
    })),
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
  commands: [] as Array<ReadonlyArray<string>>,
  specs: new Map<string, ScopeInstanceSpec>(),
  instances: new Map<string, ScopeInstance>(),
  upDelay: Duration.zero,
  execAnswer: "copied",
  failDumpOf: "",
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
      sealant.commands.push(options.argv);
      sealant.calls.push(`exec ${key} ${options.user} ${options.argv.slice(4).join(" ")}`);
      return {
        exitCode: options.argv[4] === sealant.failDumpOf ? 1 : 0,
        stdout: `${sealant.execAnswer}\n`,
        stderr: options.argv[4] === sealant.failDumpOf ? "dump check refused" : "",
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
  ResourceArchivesRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
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
const tableReads = ResourceTableReadsLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      repos,
      reads,
      Layer.mock(SessionRepository, { worktreeMount: () => Effect.succeed(undefined) }),
      Layer.mock(SealantClient, {
        getWorkspace: (id) => Effect.succeed(fakeWorkspace(id)),
        exec: () =>
          Effect.sync(() =>
            execAnswer(
              `.mend/mend.toml\n${Buffer.from(workspaceFile ?? file.text).toString("base64")}`,
            ),
          ),
      }),
    ),
  ),
);
const runtimeLayer = resourceRuntimeLayer(Duration.millis(300)).pipe(
  Layer.provideMerge(Layer.mergeAll(repos, reads, tableReads, images, scopes)),
);
/** The loads the repo answers as each target's latest. */
let loadRows: ReadonlyArray<StoredResourceLoad> = [];
/** Each worktree whose Services a switch restarted, and by whom; it ran `web`. */
const restarted: Array<string> = [];
const told: Array<{ message: string; except: SessionId | null }> = [];
const tellFailures: string[] = [];
const restarts = Layer.succeed(WorktreeServiceRestarts, {
  restart: (worktreeId, by) =>
    Effect.sync(() => {
      restarted.push(`${worktreeId} ${by}`);
      return [{ name: "web", kind: "restarted" as const }];
    }),
  tell: (_, __, message, except) =>
    Effect.sync(() => {
      told.push({ message, except });
      return tellFailures;
    }),
});
let appended: { readonly name: string; readonly table: string } | null = null;
let writeResult: AppendResourceTableResult = { kind: "written", path: ".mend/mend.toml" };
const resources = ResourcesLive.pipe(
  Layer.provide(
    Layer.mock(ResourceTableWrites, {
      appendResourceTable: (input) =>
        Effect.sync(() => {
          appended = input;
          return writeResult;
        }),
    }),
  ),
  Layer.provideMerge(ResourceStatusReadsLive),
  Layer.provide(tableReads),
  Layer.provide(Layer.mock(ResourceLoadsRepo, { latest: () => Effect.sync(() => loadRows) })),
  Layer.provideMerge(Layer.merge(runtimeLayer, restarts)),
);
const removalLayer = ResourceRemovalLive.pipe(Layer.provideMerge(Layer.merge(repos, scopes)));
const channel = ResourcesChannelLive.pipe(
  Layer.provideMerge(Layer.mergeAll(resources, removalLayer, SessionChannelRegistryLive)),
);

const runtime = ManagedRuntime.make(channel);
const clock = { now: new Date("2026-10-30T10:00:00Z"), timeZone: "Europe/Athens" };
const maria: Viewer = { userId: "u-tom", organizationId: ORG, role: "member" };

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
  let db: StoredResourceInstance;
  let cache: StoredResourceInstance;

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
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha, change_owner_user_id, change_owner_proven, change_owner_recorded)
          VALUES (${WORKTREE}, ${PROJECT}, 'wt-res', 'wt-res', 'mend/wt-res', 'abc', 'u-tom', true, true)`;
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
      }),
    );
  }, 60_000);

  beforeEach(async () => {
    defaultFile = undefined;
    workspaceFile = undefined;
    appended = null;
    writeResult = { kind: "written", path: ".mend/mend.toml" };
    sealant.calls.length = 0;
    sealant.commands.length = 0;
    sealant.specs.clear();
    sealant.instances.clear();
    restarted.length = 0;
    told.length = 0;
    tellFailures.length = 0;
    sealant.upDelay = Duration.zero;
    sealant.failDumpOf = "";
    file = {
      text: '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\nports = { postgres = 5432 }\nvolumes = { data = "/var/lib/postgresql/data" }\n[resource.cache]\npreset = "redis"\nimage = "redis:8"\nports = { redis = 6379 }\nvolumes = { data = "/data" }',
      stamp: WORKTREE_STAMP,
    };
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`TRUNCATE resource_definitions CASCADE`;
        yield* sql`UPDATE agent_sessions SET sealant_workspace_id = NULL WHERE id = ${SESSION}`;
        const repo = yield* ResourcesRepo;
        for (const [name, preset, version] of [
          ["db", "postgres", "17"],
          ["cache", "redis", "8"],
        ] as const) {
          const identity = yield* repo.ensureIdentity(PROJECT, name);
          const spec = presetDefinition({
            name: ResourceName.make(name),
            preset,
            version: PresetVersion.make(version),
          });
          const row = yield* repo.remember(PROJECT, identity.id, null, spec, DIGEST, "u-tom");
          if (name === "db") db = row;
          else cache = row;
        }
      }),
    );
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

  const project = () =>
    runtime.runPromise(Effect.flatMap(ProjectsRepo, (repo) => repo.byId(PROJECT)));
  const start = async (name = "db", level: "project" | "worktree" = "project", restart = false) =>
    runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.start(awaitedProject, maria, name, { level, worktreeId: WORKTREE, restart }, clock),
      ),
    );
  let awaitedProject: Awaited<ReturnType<typeof project>>;
  beforeEach(async () => {
    awaitedProject = await project();
  });

  it("starts the first workspace definition immediately, before capture, through the session CLI", async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`TRUNCATE resource_definitions CASCADE`;
        yield* sql`UPDATE agent_sessions SET sealant_workspace_id = 'ws-1' WHERE id = ${SESSION}`;
      }),
    );
    file.text = "";
    workspaceFile = '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n';
    expect(await fromSession("start", "db", "--project")).toEqual([
      expect.stringContaining("@db · running · project · shared database"),
    ]);
    workspaceFile = workspaceFile.replace("postgres:17", "postgres:16");
    expect(await start()).toMatchObject({
      kind: "needs-restart",
      statusLine: expect.stringContaining("definition differs"),
    });
    const listed = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) => actions.list(awaitedProject, maria, WORKTREE, clock)),
    );
    expect(listed.settings.find((entry) => entry.spec.name === "db")?.statusLine).toContain(
      "definition differs",
    );
    expect(file.text).toBe("");
  });

  it("launch never starts a missing instance, adopts a file definition, or creates an own database", async () => {
    file.text += '\n[resource.mail]\nimage = "axllent/mailpit:v1.21"\nports = { smtp = 1025 }';
    const answer = await prepare();
    expect(answer.env.MEND_DB_URL).toBe("postgres://postgres@db:5432/app");
    expect(sealant.calls).toEqual(["link ws-1 wt-res"]);
    expect(
      await runtime.runPromise(
        Effect.flatMap(ResourcesRepo, (repo) => repo.byName(PROJECT, "mail")),
      ),
    ).toBeNull();
  });

  it("wakes only idle-stopped instances, with their remembered spec", async () => {
    await start();
    await start("cache");
    const dbSpec = sealant.specs.get(db.id)!;
    sealant.instances.set(
      db.id,
      instanceOf(
        db.id,
        dbSpec,
        { kind: "stopped", at: new Date(), reason: { kind: "idle" } },
        { kind: "idle" },
      ),
    );
    const cacheSpec = sealant.specs.get(cache.id)!;
    const reason = { kind: "person" as const, by: "Maria" };
    sealant.instances.set(
      cache.id,
      instanceOf(cache.id, cacheSpec, { kind: "stopped", at: new Date(), reason }, reason),
    );
    file.text = file.text.replace('image = "postgres:17"', 'image = "postgres:18"');
    sealant.calls.length = 0;
    await prepare();
    expect(sealant.calls).toEqual(["link ws-1 wt-res", `up ${db.id} use`]);
    expect(sealant.specs.get(db.id)?.image).toBe(db.image);
  });

  it("starts both non-Postgres levels explicitly and selects the worktree instance", async () => {
    await start("cache");
    const own = await start("cache", "worktree");
    expect(own.kind).toBe("started");
    expect(sealant.specs.get(`${cache.id}@${WORKTREE}`)?.worktreeKey).toBe(WORKTREE);
    const rows = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.listForProject(PROJECT)),
    );
    expect(rows.filter((row) => row.spec.name === "cache")).toHaveLength(2);
    expect(restarted).toEqual([`${WORKTREE} u-tom`]);
  });

  it("requires restart for a differing definition and replaces it only when requested", async () => {
    file.text = file.text.replace('image = "postgres:17"', 'image = "postgres:18"');
    const refused = await start();
    expect(refused).toMatchObject({
      kind: "needs-restart",
      statusLine: "@db · project · definition differs from this worktree",
      hint: "mend resource start db --project --restart",
      worktrees: [{ id: WORKTREE, name: "wt-res" }],
    });
    expect(sealant.calls).toEqual([]);
    await start("db", "project", true);
    expect(sealant.specs.get(db.id)?.image).toContain("postgres:18@");
  });

  it("requires restart independently for a changed worktree image", async () => {
    await start("cache", "worktree");
    file.text = file.text.replace('image = "redis:8"', 'image = "redis:9"');
    sealant.calls.length = 0;
    const answer = await start("cache", "worktree");
    expect(answer).toMatchObject({
      kind: "needs-restart",
      hint: "mend resource start cache --worktree --restart",
      worktrees: [{ id: WORKTREE, name: "wt-res" }],
    });
    expect(sealant.calls).toEqual([]);
    await start("cache", "worktree", true);
    expect(sealant.specs.get(`${cache.id}@${WORKTREE}`)?.image).toContain("redis:9@");
  });

  it("refuses an invalid file even when an older instance is remembered", async () => {
    file.text = '[resource.db]\nimage = "postgres:17"\nports = { postgres = 70000 }';
    const answer = await fromSession("start", "db", "--project");
    expect(answer[0]).toContain("refused:");
    expect(sealant.calls).toEqual([]);
  });

  it("allows off after the last remembered instance is removed", async () => {
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.removeInstance(cache.id, null)),
    );
    const answer = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.use(awaitedProject, maria, WORKTREE, "cache", "off", clock),
      ),
    );
    expect(answer.mode).toBe("off");
  });

  it("relinks every live workspace when a project resource is started", async () => {
    const other = SessionId.make("s-relink");
    const otherWorktree = WorktreeId.make("wt-relink");
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO worktrees(id, project_id, name, directory, branch, base_sha) VALUES (${otherWorktree}, ${PROJECT}, 'relink', 'relink', 'mend/relink', 'abc')`;
        const original = yield* (yield* SessionsRepo).byId(SESSION);
        yield* (yield* SessionsRepo).create({
          ...original,
          id: other,
          worktreeId: otherWorktree,
          worktree: "relink",
          branch: "mend/relink",
          baseRef: "main",
        });
        yield* sql`UPDATE agent_sessions SET status = 'running', sealant_workspace_id = CASE WHEN id = ${SESSION} THEN 'ws-first' ELSE 'ws-other' END WHERE id IN (${SESSION}, ${other})`;
      }),
    );
    await start();
    expect(sealant.calls).toContain("link ws-first wt-res");
    expect(sealant.calls).toContain("link ws-other wt-relink");
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE agent_sessions SET sealant_workspace_id = null, status = 'starting' WHERE id = ${SESSION}`;
        yield* sql`DELETE FROM agent_sessions WHERE id = ${other}`;
        yield* sql`DELETE FROM worktrees WHERE id = ${otherWorktree}`;
      }),
    );
  });

  it("uses a differing project Postgres server for its own database without replacing it", async () => {
    file.text = file.text.replace('image = "postgres:17"', 'image = "postgres:18"');
    const answer = await start("db", "worktree");
    expect(answer.kind === "started" && answer.message).toContain(
      "@db · own database on the project server (postgres:17) · this worktree's file asks postgres:18",
    );
    expect(sealant.specs.get(db.id)?.image).toBe(db.image);
    expect((await prepare()).env.MEND_DB_DATABASE).toBe(OWN);
    expect(
      (
        await runtime.runPromise(
          Effect.flatMap(ResourcesRepo, (repo) => repo.listForProject(PROJECT)),
        )
      ).filter((row) => row.spec.name === "db"),
    ).toHaveLength(1);
  });

  it("creates the project server first when starting an own Postgres database", async () => {
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.removeInstance(db.id, null)),
    );
    const answer = await start("db", "worktree");
    expect(answer.kind === "started" && answer.message).toContain(
      "started the project server for it",
    );
    expect(sealant.calls.findIndex((line) => line.startsWith("up "))).toBeLessThan(
      sealant.calls.findIndex((line) => line.startsWith("exec ")),
    );
  });

  it("starts remembered state when the table is missing, and refuses an unknown name", async () => {
    file.text = "";
    expect(await start()).toMatchObject({
      kind: "started",
      message: "not in this worktree's .mend/mend.toml · started as it last ran",
    });
    expect(await fromSession("start", "missing", "--project")).toEqual([
      "refused: no [resource.missing] in this worktree's .mend/mend.toml",
    ]);
    expect(await fromSession("start", "db")).toEqual([
      "refused: choose a level: mend resource start db --project or --worktree",
    ]);
  });

  it("refuses use of a missing target, then switches, restarts Services and excludes the calling session", async () => {
    expect(await fromSession("use", "db", "worktree")).toEqual([
      "refused: @db · no own database yet · mend resource start db --worktree",
    ]);
    await start("db", "worktree");
    told.length = 0;
    restarted.length = 0;
    const answer = await fromSession("use", "db", "shared");
    expect(answer.join(" ")).toContain("Changed: MEND_DB_URL, MEND_DB_DATABASE.");
    expect(answer.join(" ")).toContain("Printing values does not update your shell.");
    expect(told).toEqual([{ message: answer[0], except: SESSION }]);
    expect(restarted).toEqual([`${WORKTREE} u-tom`]);
  });

  it("returns separate helper lines for starts and choices with switch notifications", async () => {
    const terminal =
      "the agent in other agent runs in a terminal, so Mend did not type this into it · pass it on or restart that session";
    tellFailures.push(terminal);
    const started = await fromSession("start", "db", "--worktree");
    expect(started).toHaveLength(3);
    expect(started[0]).toContain("running");
    expect(started[1]).toBe(told.at(-1)?.message);
    expect(started[2]).toBe(terminal);
    const selected = await fromSession("use", "db", "project");
    expect(selected).toEqual([told.at(-1)?.message, terminal]);
    expect([...started, ...selected].every((line) => !line.includes("\n"))).toBe(true);
  });

  it("resolves Service references and refuses missing or person-stopped dependencies", async () => {
    const resolved = await prepare([{ kind: "resource", name: "db", env: {} }], {
      DATABASE_URL: "${MEND_DB_URL}",
    });
    expect(resolved.env.DATABASE_URL).toBe("postgres://postgres@db:5432/app");
    await fromSession("use", "db", "off");
    expect((await prepare([{ kind: "resource", name: "db", env: {} }])).refusal).toBe(
      "process needs @db · @db is not running for this worktree · mend resource start db --project or --worktree",
    );
    await fromSession("use", "db", "project");
    await start();
    await runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.stop(awaitedProject, maria, "db", { worktreeId: WORKTREE }, clock),
      ),
    );
    expect((await prepare([{ kind: "resource", name: "db", env: {} }])).refusal).toBe(
      "@db stopped by Tom",
    );
  });

  it("archives one instance, keeping identity, other instances and own database inventory", async () => {
    await start("cache", "worktree");
    const answer = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.remove(awaitedProject, maria, "cache", {
          level: "worktree",
          worktreeId: WORKTREE,
        }),
      ),
    );
    expect(answer.statusLine).toBe("@cache · worktree · archived · volumes kept");
    expect(sealant.calls).toContain(`archive ${cache.id}@${WORKTREE}`);
    expect(
      await runtime.runPromise(
        Effect.flatMap(ResourcesRepo, (repo) => repo.byName(PROJECT, "cache")),
      ),
    ).not.toBeNull();
  });

  const OTHER_WORKTREE = WorktreeId.make("wt-archive-b");
  const archiveDb = () =>
    runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.remove(awaitedProject, maria, "db", {
          level: "project",
          worktreeId: WORKTREE,
        }),
      ),
    );
  const seedOwnDatabases = async () => {
    await start("db", "worktree");
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
        VALUES (${OTHER_WORKTREE}, ${PROJECT}, 'archive-b', 'archive-b', 'mend/archive-b', 'abc')
        ON CONFLICT (id) DO NOTHING`;
        yield* (yield* ResourcesRepo).recordOwnDatabase(OTHER_WORKTREE, db.id, "empty");
      }),
    );
    sealant.calls.length = 0;
    sealant.commands.length = 0;
  };
  const ownRows = (worktreeId: WorktreeId) =>
    runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.ownDatabaseRemovals(worktreeId)),
    );

  it("checks both own databases before archiving, removes their worktrees without a server, then archives the project", async () => {
    await seedOwnDatabases();
    expect((await archiveDb()).statusLine).toBe("@db · project · archived · volumes kept");
    for (const worktreeId of [WORKTREE, OTHER_WORKTREE]) {
      expect(await ownRows(worktreeId)).toEqual([
        expect.objectContaining({
          dumpName: expect.stringContaining(`${ownDatabaseName(worktreeId)}-removed-`),
          dumpAt: expect.any(Date),
          checkedAt: expect.any(Date),
          removedAt: null,
        }),
      ]);
    }
    const archiveIndex = sealant.calls.indexOf(`archive ${db.id}`);
    expect(
      sealant.calls.filter((call, i) => i < archiveIndex && call.includes("-removed-")),
    ).toHaveLength(2);
    expect(sealant.commands.some((argv) => argv[2]?.includes("drop database"))).toBe(false);
    sealant.calls.length = 0;
    const projectRow = await project();
    for (const worktreeId of [WORKTREE, OTHER_WORKTREE]) {
      const lines = await runtime.runPromise(
        Effect.flatMap(ResourceRemoval, (removal) => removal.worktree(projectRow, worktreeId)),
      );
      expect(lines).toEqual([expect.stringContaining("saved when @db was archived")]);
      expect((await ownRows(worktreeId))[0]?.removedAt).toBeInstanceOf(Date);
    }
    expect(sealant.calls).toEqual([]);
    await runtime.runPromise(
      Effect.flatMap(ResourceRemoval, (removal) => removal.project(projectRow)),
    );
    const archived = await runtime.runPromise(
      Effect.flatMap(ResourceArchivesRepo, (repo) => repo.byProject(PROJECT)),
    );
    expect(archived?.complete).toBe(true);
  });

  it("refuses the archive if one own dump fails, names its worktree, and keeps the instance", async () => {
    await seedOwnDatabases();
    sealant.failDumpOf = ownDatabaseName(OTHER_WORKTREE);
    const result = await archiveDb().then(
      () => "archived",
      (error: unknown) => error,
    );
    expect(result).toMatchObject({
      message: expect.stringContaining(
        "@db · not archived · could not save the own databases of archive-b ·",
      ),
    });
    expect(sealant.calls).not.toContain(`archive ${db.id}`);
    expect(sealant.instances.get(db.id)?.state.kind).toBe("running");
    expect((await ownRows(OTHER_WORKTREE))[0]?.checkedAt).toBeNull();
    expect(
      await runtime.runPromise(Effect.flatMap(ResourcesRepo, (repo) => repo.byName(PROJECT, "db"))),
    ).not.toBeNull();
    sealant.failDumpOf = "";
    await archiveDb();
    expect((await ownRows(OTHER_WORKTREE))[0]?.checkedAt).toBeInstanceOf(Date);
  });

  it.each(["idle", "person"] as const)(
    "starts a server stopped by %s to save the own databases for archive and says so",
    async (kind) => {
      await seedOwnDatabases();
      const instance = sealant.instances.get(db.id);
      if (instance === undefined) throw new Error("missing server");
      const reason = kind === "idle" ? { kind } : { kind, by: "Maria" };
      sealant.instances.set(db.id, {
        ...instance,
        state: { kind: "stopped", at: new Date(), reason },
        stopReason: reason,
      });
      expect((await archiveDb()).statusLine).toBe(
        "@db · project · archived · volumes kept · archive started its server",
      );
      expect(sealant.calls[0]).toBe(`up ${db.id} person`);
    },
  );

  it("refuses to replace an archived server without saved dumps, naming every affected worktree", async () => {
    await seedOwnDatabases();
    const instance = sealant.instances.get(db.id);
    if (instance === undefined) throw new Error("missing server");
    sealant.instances.set(db.id, { ...instance, state: { kind: "archived", at: new Date() } });
    const result = await archiveDb().then(
      () => "archived",
      (error: unknown) => error,
    );
    expect(result).toMatchObject({
      message:
        "@db · not archived · could not save the own databases of archive-b, wt-res · server is archived · nothing archived or dropped · volumes kept",
    });
    expect(sealant.calls).toEqual([]);
    expect(sealant.commands).toEqual([]);
  });

  it("archives without starting a server when there are no remaining own databases", async () => {
    await start();
    expect((await archiveDb()).statusLine).toBe("@db · project · archived · volumes kept");
    expect(sealant.calls.filter((call) => call.startsWith("exec "))).toEqual([]);
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.recordOwnDatabase(WORKTREE, db.id, "empty")),
    );
    await runtime.runPromise(
      Effect.gen(function* () {
        const repo = yield* ResourcesRepo;
        const at = new Date();
        yield* repo.reserveRemovalDump(WORKTREE, db.id, `${OWN}-removed-20261101T120000Z.dump`, at);
        yield* repo.checkRemovalDump(WORKTREE, db.id, at);
        yield* repo.removeOwnDatabase(WORKTREE, db.id, at);
      }),
    );
    // Re-remember the server to exercise the already-removed inventory on a new archive.
    await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) =>
        repo.remember(PROJECT, db.id, null, db.spec, DIGEST, "u-tom"),
      ),
    );
    sealant.calls.length = 0;
    await archiveDb();
    expect(sealant.calls).toEqual([`archive ${db.id}`]);
  });

  it.each([
    [
      { kind: "written", path: "mend.toml" },
      "@mail · added to mend.toml in wt-res · start it: mend resource start mail --project or --worktree",
    ],
    [{ kind: "declared", path: ".mend/mend.toml" }, "@mail · already declared in .mend/mend.toml"],
    [
      { kind: "unparsed", path: "mend.toml", message: "mend.toml: invalid TOML" },
      "mend.toml: invalid TOML",
    ],
    [
      { kind: "unreachable", reason: "offline", table: "ignored" },
      "@mail · offline · add this table to .mend/mend.toml yourself:",
    ],
  ] satisfies ReadonlyArray<readonly [AppendResourceTableResult, string]>)(
    "helper add answers %# and never starts or remembers the definition",
    async (result, line) => {
      writeResult = result;
      const lines = await fromSession(
        "add",
        "mail",
        "--image",
        "axllent/mailpit:v1.21",
        "--port",
        "smtp=1025",
      );
      expect(lines[0]).toBe(line);
      expect(appended).toMatchObject({
        name: "mail",
        table: '[resource.mail]\nimage = "axllent/mailpit:v1.21"\nports = { smtp = 1025 }\n',
      });
      if (result.kind === "unreachable")
        expect(lines.slice(1).join("\n")).toBe(appended?.table.trimEnd());
      expect(sealant.calls).toEqual([]);
      expect(
        await runtime.runPromise(
          Effect.flatMap(ResourcesRepo, (repo) => repo.byName(PROJECT, "mail")),
        ),
      ).toBeNull();
    },
  );
  it("lists default-branch definitions even when the selected worktree lacks the table, and Start names that absence", async () => {
    defaultFile = '[resource.mail]\nimage = "axllent/mailpit:v1.21"\nports = { smtp = 1025 }\n';
    file.text = "";
    const page = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.list(awaitedProject, maria, WORKTREE, clock, true),
      ),
    );
    expect(page.file.kind === "read" && page.file.tables.map((table) => table.spec.name)).toEqual([
      "mail",
    ]);
    expect(page.file.kind === "read" && page.file.worktreeId).toBeNull();
    expect(await fromSession("start", "mail", "--project")).toEqual([
      "refused: no [resource.mail] in this worktree's .mend/mend.toml",
    ]);
  });
  it("lists a running instance after its table is removed, independently of the default-branch definitions", async () => {
    await start("db");
    file.text = "";
    const page = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) =>
        actions.list(awaitedProject, maria, WORKTREE, clock, true),
      ),
    );
    expect(page.file.kind === "read" && page.file.tables).toEqual([]);
    expect(page.settings.find((entry) => entry.spec.name === "db")).toMatchObject({
      instance: "running",
      canRemove: true,
    });
  });
  it("keeps malformed file source out of the status response", async () => {
    file.text = VERIFIER_FILE;
    const page = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) => actions.list(awaitedProject, maria, WORKTREE, clock)),
    );
    expect(page.file.kind).toBe("unparsed");
    expect(JSON.stringify(page)).not.toContain("fake-value-gate1201");
  });
  it("groups helper list definitions with their observations without a second not-started entry", async () => {
    await start("db");
    const lines = await fromSession("list");
    expect(lines.filter((line) => line.startsWith("@db"))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith("@db"))).not.toContain("not started");
    expect(lines.find((line) => line.startsWith("  @db"))).toContain("running");
    file.text += '\n[resource.mail]\nimage = "axllent/mailpit:v1.21"\nports = { smtp = 1025 }\n';
    expect((await fromSession("list")).find((line) => line.startsWith("@mail"))).toContain(
      "not started",
    );
  });
  it.each([null, "shared control is off", ""])(
    "tells live conversation agents, reports terminal agents and preserves refusal reasons (%s)",
    async (refusal) => {
      const other = SessionId.make("s-other-agent");
      const shell = SessionId.make("s-shell-only");
      const sent: Array<{ sessionId: SessionId; sender: string; message: string }> = [];
      await runtime.runPromise(
        Effect.gen(function* () {
          const sessions = yield* SessionsRepo;
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM agent_sessions WHERE project_id = ${PROJECT} AND id <> ${SESSION}`;
          const original = yield* sessions.byId(SESSION);
          yield* (yield* SessionProcessesRepo).create({
            sessionId: SESSION,
            sealantWorkspaceId: SealantWorkspaceId.make("ws-original"),
            sealantSessionId: null,
            kind: "agent-protocol",
            label: "current agent",
            argv: ["codex"],
          });
          for (const [id, label, kind] of [
            [other, "other agent", "agent-protocol"],
            [SessionId.make("s-terminal"), "terminal agent", "agent-pty"],
            [SessionId.make("s-stopped"), "stopped agent", "agent-protocol"],
            [SessionId.make("s-exited"), "exited agent", "agent-pty"],
            [shell, "shell only", "shell"],
          ] as const) {
            yield* sessions.create({ ...original, id, label, baseRef: original.baseRef ?? "main" });
            yield* sessions.setStatus(id, id === "s-stopped" ? "stopped" : "running");
            const process = yield* (yield* SessionProcessesRepo).create({
              sessionId: id,
              sealantWorkspaceId: SealantWorkspaceId.make(`ws-${id}`),
              sealantSessionId: null,
              kind,
              label,
              argv: ["codex"],
            });
            if (id === "s-exited")
              yield* (yield* SessionProcessesRepo).markExited(process.id, "exited", 0);
          }
          yield* sessions.setStatus(SESSION, "running");
          const live = WorktreeServiceRestartsLive.pipe(
            Layer.provide(
              Layer.mock(SessionEngine, {
                launchUnderWay: () => false,
                sendMessage: (input) =>
                  Effect.gen(function* () {
                    sent.push({
                      sessionId: input.sessionId,
                      sender: input.sender,
                      message: input.input,
                    });
                    if (refusal === null)
                      return {
                        _tag: "Turn" as const,
                        messageId: SessionMessageId.make("6dd5c2a6-0a8c-4980-8b24-bfb298ecf18f"),
                        explanation: "queued",
                        turn: new AgentTurn({
                          id: AgentTurnId.make("resource-switch-turn"),
                          sessionId: input.sessionId,
                          processId: SessionProcessId.make("resource-agent"),
                          ordinal: 0,
                          author: input.sender,
                          input: input.input,
                          status: "queued",
                          providerTurnId: null,
                          error: null,
                          usage: null,
                          createdAt: new Date(),
                          startedAt: null,
                          endedAt: null,
                        }),
                      };
                    return yield* new SessionTurnRefusedError({
                      sessionId: input.sessionId,
                      message: refusal,
                    });
                  }),
              }),
            ),
          );
          const failed = yield* Effect.flatMap(WorktreeServiceRestarts, (service) =>
            service.tell(WORKTREE, "u-tom", "switch message", SESSION),
          ).pipe(Effect.provide(live));
          expect(failed).toEqual(
            expect.arrayContaining([
              "the agent in terminal agent runs in a terminal, so Mend did not type this into it · pass it on or restart that session",
              ...(refusal === null
                ? []
                : [
                    `could not tell the agent in other agent: ${refusal || "SessionTurnRefusedError"}`,
                  ]),
            ]),
          );
          expect(failed).toHaveLength(refusal === null ? 1 : 2);
        }),
      );
      expect(sent).toEqual([{ sessionId: other, sender: "u-tom", message: "switch message" }]);
    },
  );
});
