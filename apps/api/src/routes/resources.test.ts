import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { MendDBLive, migrations, ResourcesRepo, ResourcesRepoLive, UserFacts } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ImageDigest, resourceListEntries, type ResourcesPage } from "@mend/domain/workbench";
import {
  ImageResolutionError,
  type ResourceImageResolver,
  type ResourceLoads,
  type ResourceRuntime,
  type WorktreeServiceRestarts,
  WORKTREE_STAMP,
  type ResourceTableWrites,
} from "@mend/sessions";
import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_WORKTREE_IN_SHARED_A,
  type HarnessUser,
  ids,
} from "../../test/support/tenancy-harness.ts";

const postgres = postgresTestConfig();
const shared = ids("shared-a");
const NAMES: Readonly<Record<string, string>> = { alice: "Alice", carol: "Carol" };

const pgLayer = (url: string) => PgClient.layer({ url: Redacted.make(url), maxConnections: 4 });
const admin = (statement: string) =>
  Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe(statement)).pipe(
      Effect.provide(pgLayer(postgres.adminUrl)),
      Effect.scoped,
      Effect.asVoid,
    ),
  );

/** The digest the fake registry pins `image` to. */
const digestFor = (image: string) =>
  ImageDigest.make(`sha256:${createHash("sha256").update(image).digest("hex")}`);

const json = async (response: Response) => ({
  status: response.status,
  body: await response.json(),
});

const MEND_TOML = `
[resource.mail]
image = "axllent/mailpit:v1.21"
scope = "worktree"
ports = { smtp = 1025 }
device = "/dev/null"
`;

describe.skipIf(postgres.skip)("a project's resources over the API", () => {
  const database = `mend_resource_routes_${process.pid}_${Date.now()}`;
  const runtimeFor = (url: string) =>
    ManagedRuntime.make(
      ResourcesRepoLive.pipe(Layer.provideMerge(MendDBLive), Layer.provideMerge(pgLayer(url))),
    );
  let runtime: ReturnType<typeof runtimeFor>;
  let api: TenancyApi | undefined;

  beforeAll(async () => {
    await admin(`CREATE DATABASE ${database}`);
    const url = new URL(postgres.adminUrl);
    url.pathname = `/${database}`;
    runtime = runtimeFor(url.toString());
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(
          Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b)),
          ([, migration]) => migration,
          { discard: true },
        );
        yield* sql`INSERT INTO organizations (id, name) VALUES ('org-a', 'A')`;
        yield* sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${shared.project}, 'shared-a', '/store/shared-a', 'main', 'org-a')`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${shared.worktree}, ${shared.project}, 'wt', 'wt', 'mend/wt', 'abc')`;
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${CAROL_WORKTREE_IN_SHARED_A}, ${shared.project}, 'carol', 'carol', 'mend/carol', 'abc')`;
      }),
    );
  });

  afterEach(async () => {
    await api?.dispose();
    api = undefined;
    file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
    resolved.length = 0;
    resolveImage = pinned;
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM resource_definitions`;
        yield* sql`DELETE FROM resource_selections`;
      }),
    );
  });

  afterAll(async () => {
    await runtime?.dispose();
    await admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  });

  const repoNow = Effect.gen(function* () {
    return yield* ResourcesRepo;
  });
  let file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
  /** Each image the registry was asked for; every tag pins to the same digest per image. */
  const resolved: Array<string> = [];
  const pinned: ResourceImageResolver["Service"]["resolve"] = (image) =>
    Effect.succeed({ digest: digestFor(image), resolvedBy: "docker-mirror:5000" });
  let resolveImage = pinned;
  const harness = () => {
    if (api === undefined) throw new Error("start the API first");
    return api;
  };

  const start = async (
    override: (repo: ResourcesRepo["Service"]) => ResourcesRepo["Service"] = (repo) => repo,
    resourceRuntime: Layer.PartialEffectful<ResourceRuntime["Service"]> = {},
    serviceRestarts: Layer.PartialEffectful<WorktreeServiceRestarts["Service"]> = {},
    resourceLoads: Layer.PartialEffectful<ResourceLoads["Service"]> = {},
    resourceTableWrites: Layer.PartialEffectful<ResourceTableWrites["Service"]> = {},
  ) => {
    const repo = override(await runtime.runPromise(repoNow));
    api = await createTenancyApi(undefined, {
      implement: {
        resources: repo,
        resourceRuntime,
        serviceRestarts,
        resourceLoads,
        resourceTableWrites,
        users: {
          byIds: (accounts) =>
            Effect.succeed(
              accounts.flatMap((id) =>
                NAMES[id] === undefined
                  ? []
                  : [new UserFacts({ id, name: NAMES[id], email: `${id}@example.test` })],
              ),
            ),
        },
        images: {
          resolve: (image) =>
            Effect.suspend(() => {
              resolved.push(image);
              return resolveImage(image);
            }),
        },
        reads: {
          readDefaultBranchFile: () =>
            Effect.succeed({
              value: {
                bytes: new TextEncoder().encode(file.text),
                size: file.text.length,
                truncated: false,
                binary: false,
              },
              stamp: file.stamp,
            }),
          readFile: () =>
            Effect.succeed({
              value: {
                bytes: new TextEncoder().encode(file.text),
                size: file.text.length,
                truncated: false,
                binary: false,
              },
              stamp: file.stamp,
            }),
        },
      },
    });
    return api;
  };

  const zone = "timeZone=Europe%2FAthens";
  const list = (as: HarnessUser, query = ""): Promise<{ status: number; body: ResourcesPage }> =>
    harness()
      .request(as, "GET", `/api/projects/${shared.project}/resources?${zone}${query}`)
      .then(json);
  const control = (as: HarnessUser, name: string, level: "project" | "worktree", restart = false) =>
    harness()
      .request(as, "POST", `/api/projects/${shared.project}/resources/${name}/start?${zone}`, {
        level,
        worktreeId: CAROL_WORKTREE_IN_SHARED_A,
        restart,
      })
      .then(json);
  const seedFile = (image = "postgres:17") => {
    file.text = `[resource.db]\npreset = "postgres"\nimage = "${image}"\nports = { postgres = 5432 }\nvolumes = { data = "/var/lib/postgresql/data" }`;
  };
  it.each(["written", "declared", "unparsed", "unreachable"] as const)(
    "add returns %s without registering or starting anything",
    async (kind) => {
      let appended = "";
      await start(
        undefined,
        {},
        {},
        {},
        {
          appendResourceTable: (input) => {
            appended = input.table;
            return Effect.succeed(
              kind === "unreachable"
                ? { kind, reason: "offline", table: input.table }
                : kind === "unparsed"
                  ? { kind, path: "mend.toml", message: "mend.toml: invalid TOML" }
                  : { kind, path: "mend.toml" },
            );
          },
        },
      );
      const response = await json(
        await harness().request(
          "carol",
          "POST",
          `/api/projects/${shared.project}/worktrees/resources`,
          {
            worktreeId: CAROL_WORKTREE_IN_SHARED_A,
            definition: { name: "db", preset: "postgres", version: "17" },
          },
        ),
      );
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        kind,
        table: '[resource.db]\npreset = "postgres"\nimage = "postgres:17"\n',
      });
      expect(appended).toBe(response.body.table);
      expect(
        await runtime.runPromise(
          Effect.flatMap(ResourcesRepo, (repo) => repo.listForProject(shared.project)),
        ),
      ).toEqual([]);
      expect(resolved).toEqual([]);
    },
  );
  it("previews with no worktree without touching a writer", async () => {
    await start();
    const response = await json(
      await harness().request(
        "carol",
        "POST",
        `/api/projects/${shared.project}/worktrees/resources`,
        {
          worktreeId: null,
          definition: { name: "db", preset: "postgres", version: "17" },
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      kind: "unreachable",
      reason: "this project has no selected worktree",
    });
    expect(response.body.table).toContain("[resource.db]");
  });
  it("refuses Mend-owned names before writing", async () => {
    await start();
    const response = await json(
      await harness().request(
        "carol",
        "POST",
        `/api/projects/${shared.project}/worktrees/resources`,
        {
          worktreeId: null,
          definition: { name: "preview", preset: "redis", version: "8" },
        },
      ),
    );
    expect(response.status).toBe(422);
    expect(response.body.message).toContain("generates env names Mend owns");
  });
  it("stops and removes a remembered project instance without a selected worktree", async () => {
    await start();
    seedFile();
    expect((await control("carol", "db", "project")).status).toBe(200);
    file.text = "";
    const stopped = await json(
      await harness().request(
        "carol",
        "POST",
        `/api/projects/${shared.project}/resources/db/stop?${zone}`,
        { level: "project", worktreeId: null },
      ),
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.instance).toBe("stopped");
    const removed = await json(
      await harness().request("carol", "DELETE", `/api/projects/${shared.project}/resources/db`, {
        level: "project",
        worktreeId: null,
      }),
    );
    expect(removed).toMatchObject({
      status: 200,
      body: { statusLine: "@db · project · archived · volumes kept" },
    });
  });
  it("starts only through the explicit level endpoint and remembers the file's spec", async () => {
    const observed = new Map<string, { instance: { kind: "running" }; observedAt: Date }>();
    await start(undefined, {
      observe: () => Effect.succeed({ kind: "observed", byKey: observed }),
    });
    seedFile();
    expect(await control("carol", "db", "project")).toMatchObject({
      status: 200,
      body: { kind: "started", instance: "running" },
    });
    expect(resolved).toEqual(["postgres:17"]);
    const remembered = await runtime.runPromise(
      Effect.flatMap(ResourcesRepo, (repo) => repo.listForProject(shared.project)),
    );
    for (const row of remembered)
      observed.set(row.id, { instance: { kind: "running" }, observedAt: new Date() });
    const page = (await list("carol", `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`)).body;
    expect(page.settings).toHaveLength(1);
    expect(page.settings[0]?.level).toBe("project");
    const entries = resourceListEntries(page);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "db",
      definition: { spec: { name: "db" } },
      instances: [{ instance: "running" }],
    });
    expect(entries[0]?.statusLine).not.toContain("not started");
  });
  it("returns needs-restart and leaves the old image until an explicit restart", async () => {
    await start();
    seedFile();
    await control("carol", "db", "project");
    seedFile("postgres:18");
    expect(await control("carol", "db", "project")).toMatchObject({
      status: 200,
      body: { kind: "needs-restart", hint: "mend resource start db --project --restart" },
    });
    expect(resolved).toEqual(["postgres:17"]);
    expect(await control("carol", "db", "project", true)).toMatchObject({
      status: 200,
      body: { kind: "started" },
    });
    expect(resolved).toEqual(["postgres:17", "postgres:18"]);
  });
  it("requires a level and worktree, refuses missing definitions, and hides invisible projects", async () => {
    await start();
    seedFile();
    expect(
      (
        await harness().request(
          "carol",
          "POST",
          `/api/projects/${shared.project}/resources/db/start?${zone}`,
          {},
        )
      ).status,
    ).toBe(400);
    expect((await control("carol", "missing", "project")).status).toBe(403);
    expect((await control("bob", "db", "project")).status).toBe(404);
  });
  it("refuses malformed definitions and Mend process env collisions before resolving an image", async () => {
    await start();
    file.text = '[resource.preview]\nimage = "redis:8"\nports = { redis = 6379 }';
    expect((await control("carol", "preview", "project")).status).toBe(422);
    expect(resolved).toEqual([]);
  });
  it("has no add-to-settings route", async () => {
    await start();
    expect(
      (
        await harness().request(
          "carol",
          "POST",
          `/api/projects/${shared.project}/resources?${zone}`,
          {},
        )
      ).status,
    ).toBe(404);
  });
  it("returns the exact switch message and restarts this worktree's Services", async () => {
    const asked: string[] = [];
    await start(undefined, undefined, {
      restart: (id) =>
        Effect.sync(() => {
          asked.push(id);
          return [{ name: "web", kind: "restarted" as const }];
        }),
    });
    seedFile();
    await control("carol", "db", "worktree");
    const switched = await harness()
      .request(
        "carol",
        "PUT",
        `/api/projects/${shared.project}/worktrees/${CAROL_WORKTREE_IN_SHARED_A}/resources/db/selection?${zone}`,
        { mode: "project" },
      )
      .then(json);
    expect(switched.status).toBe(200);
    expect(switched.body.message).toContain("@db switched from worktree to project.");
    expect(asked).toHaveLength(2);
  });
  it("refuses selecting a missing own database and archives one instance by name and level", async () => {
    await start();
    seedFile();
    await control("carol", "db", "project");
    const chosen = await harness()
      .request(
        "carol",
        "PUT",
        `/api/projects/${shared.project}/worktrees/${CAROL_WORKTREE_IN_SHARED_A}/resources/db/selection?${zone}`,
        { mode: "worktree" },
      )
      .then(json);
    expect(chosen).toMatchObject({
      status: 403,
      body: { message: "@db · no own database yet · mend resource start db --worktree" },
    });
    expect(
      (
        await harness().request("carol", "DELETE", `/api/projects/${shared.project}/resources/db`, {
          level: "project",
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
        })
      ).status,
    ).toBe(200);
    expect((await list("carol")).body.settings).toHaveLength(0);
  });
  it("reports an unavailable registry without remembering an instance", async () => {
    await start();
    seedFile();
    resolveImage = (image) =>
      Effect.fail(new ImageResolutionError({ image, reason: "unavailable" }));
    expect((await control("carol", "db", "project")).status).toBe(503);
    expect((await list("carol")).body.settings).toHaveLength(0);
  });
});
