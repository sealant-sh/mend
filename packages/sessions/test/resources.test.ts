import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
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
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
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
  type ScopeInstance,
  type ScopeInstanceSpec,
} from "@mend/sealant";
import { Duration, Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { SessionEngine, SessionTurnRefusedError } from "../src/engine.ts";
import { ResourceImageResolver } from "../src/resources/image-resolver.ts";
import { Resources, ResourcesChannelLive, ResourcesLive } from "../src/resources/resources.ts";
import { ResourceRuntime, resourceRuntimeLayer } from "../src/resources/runtime.ts";
import {
  WorktreeServiceRestartsLive,
  WorktreeServiceRestarts,
} from "../src/resources/service-restarts.ts";
import { ResourceStatusReadsLive } from "../src/resources/status-reads.ts";
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
const runtimeLayer = resourceRuntimeLayer(Duration.millis(300)).pipe(
  Layer.provideMerge(Layer.mergeAll(repos, reads, images, scopes)),
);
/** The loads the repo answers as each target's latest. */
let loadRows: ReadonlyArray<StoredResourceLoad> = [];
/** Each worktree whose Services a switch restarted, and by whom; it ran `web`. */
const restarted: Array<string> = [];
const told: Array<{ message: string; except: SessionId | null }> = [];
const restarts = Layer.succeed(WorktreeServiceRestarts, {
  restart: (worktreeId, by) =>
    Effect.sync(() => {
      restarted.push(`${worktreeId} ${by}`);
      return [{ name: "web", kind: "restarted" as const }];
    }),
  tell: (_, __, message, except) =>
    Effect.sync(() => {
      told.push({ message, except });
      return [];
    }),
});
const resources = ResourcesLive.pipe(
  Layer.provideMerge(ResourceStatusReadsLive),
  Layer.provide(Layer.mock(ResourceLoadsRepo, { latest: () => Effect.sync(() => loadRows) })),
  Layer.provideMerge(Layer.merge(runtimeLayer, restarts)),
);
const channel = ResourcesChannelLive.pipe(
  Layer.provideMerge(Layer.merge(resources, SessionChannelRegistryLive)),
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
    sealant.calls.length = 0;
    sealant.specs.clear();
    sealant.instances.clear();
    restarted.length = 0;
    told.length = 0;
    sealant.upDelay = Duration.zero;
    file = {
      text: '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\nports = { postgres = 5432 }\nvolumes = { data = "/var/lib/postgresql/data" }\n[resource.cache]\npreset = "redis"\nimage = "redis:8"\nports = { redis = 6379 }\nvolumes = { data = "/data" }',
      stamp: WORKTREE_STAMP,
    };
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`TRUNCATE resource_definitions CASCADE`;
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
      "@db stopped by u-tom",
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

  it("keeps malformed file source out of the status response", async () => {
    file.text = VERIFIER_FILE;
    const page = await runtime.runPromise(
      Effect.flatMap(Resources, (actions) => actions.list(awaitedProject, maria, WORKTREE, clock)),
    );
    expect(page.file.kind).toBe("unparsed");
    expect(JSON.stringify(page)).not.toContain("fake-value-gate1201");
  });
  it("tells only other live agent sessions, as the switching person, and reports refused sends", async () => {
    const other = SessionId.make("s-other-agent");
    const shell = SessionId.make("s-shell-only");
    const sent: Array<{ sessionId: SessionId; sender: string; message: string }> = [];
    await runtime.runPromise(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
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
          [shell, "shell only", "shell"],
        ] as const) {
          yield* sessions.create({ ...original, id, label, baseRef: original.baseRef ?? "main" });
          yield* sessions.setStatus(id, "running");
          yield* (yield* SessionProcessesRepo).create({
            sessionId: id,
            sealantWorkspaceId: SealantWorkspaceId.make(`ws-${id}`),
            sealantSessionId: null,
            kind,
            label,
            argv: ["codex"],
          });
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
                  return yield* new SessionTurnRefusedError({
                    sessionId: input.sessionId,
                    message: "shared control is off",
                  });
                }),
            }),
          ),
        );
        const failed = yield* Effect.flatMap(WorktreeServiceRestarts, (service) =>
          service.tell(WORKTREE, "u-tom", "switch message", SESSION),
        ).pipe(Effect.provide(live));
        expect(failed).toEqual(["could not tell the agent in other agent: shared control is off"]);
      }),
    );
    expect(sent).toEqual([{ sessionId: other, sender: "u-tom", message: "switch message" }]);
  });
});
