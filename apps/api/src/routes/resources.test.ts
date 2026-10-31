import { createHash } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { MendDBLive, migrations, ResourcesRepo, ResourcesRepoLive, UserFacts } from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { ProjectId, type WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  presetDefinition,
  PresetVersion,
  type ResourceAdded,
  ResourceDefinitionInput,
  ResourceName,
  resourceRuntimeRefusal,
  type ResourcesPage,
} from "@mend/domain/workbench";
import { ImageResolutionError, type ResourceImageResolver, WORKTREE_STAMP } from "@mend/sessions";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_WORKTREE_IN_SHARED_A,
  type HarnessUser,
  ids,
} from "../../test/support/tenancy-harness.ts";

const postgres = postgresTestConfig();
const decodeSpec = Schema.decodeUnknownSync(ResourceDefinitionInput);
const lines = (entries: ReadonlyArray<{ readonly statusLine: string }>) =>
  entries.map((entry) => entry.statusLine);
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
  ) => {
    const repo = override(await runtime.runPromise(repoNow));
    api = await createTenancyApi(undefined, {
      implement: {
        resources: repo,
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
  const add = (as: HarnessUser, body: unknown): Promise<{ status: number; body: ResourceAdded }> =>
    harness()
      .request(as, "POST", `/api/projects/${shared.project}/resources?${zone}`, body)
      .then(json);
  const addPreset = (as: HarnessUser, version: string, scope = "project") =>
    add(as, { kind: "preset", name: "db", preset: "postgres", version, scope });
  const remove = (as: HarnessUser, id: string, digest: string) =>
    harness()
      .request(as, "DELETE", `/api/projects/${shared.project}/resources/${id}`, {
        expectedDigest: digest,
      })
      .then(json);
  const use = (as: HarnessUser, worktree: WorktreeId, definition: string, mode: string) =>
    harness()
      .request(
        as,
        "PUT",
        `/api/projects/${shared.project}/worktrees/${worktree}/resources/${definition}/selection?${zone}`,
        { mode },
      )
      .then(json);
  const mailpit = (name: string, scope: "project" | "worktree", image = "axllent/mailpit:v1.21") =>
    decodeSpec({
      name,
      scope,
      preset: null,
      image,
      command: null,
      ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
      env: {},
      volumes: [],
      ready: { kind: "tcp" },
      exports: {},
    });
  const definitionCount = () =>
    runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly n: number }>`SELECT count(*)::int AS n FROM resource_definitions`,
      ).pipe(Effect.map(([row]) => row?.n)),
    );
  const forCarol = `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`;
  const tableOf = async (as: HarnessUser) => {
    const read = (await list(as, forCarol)).body;
    if (read.file.kind !== "read") throw new Error(`no mend.toml read: ${read.file.kind}`);
    const [table] = read.file.tables;
    if (table === undefined) throw new Error("no [resource.*] table");
    return table;
  };

  describe("adding", () => {
    it("adds a preset as the project's, its image pinned to the digest the registry gave", async () => {
      await start();
      expect(await addPreset("carol", "17")).toMatchObject({
        status: 200,
        body: {
          resolvedBy: "docker-mirror:5000",
          definition: {
            spec: { image: "postgres:17" },
            image: `postgres:17@${digestFor("postgres:17")}`,
            addedBy: "carol",
            canRemove: true,
            statusLine: "@db · postgres 17 · project · added by Carol · not started",
          },
        },
      });
      expect(resolved).toEqual(["postgres:17"]);
      const page = await list("alice");
      expect(page.status).toBe(200);
      expect(page.body.settings).toMatchObject([
        {
          image: `postgres:17@${digestFor("postgres:17")}`,
          canRemove: true,
          statusLine: "@db · postgres 17 · project · added by Carol · not started",
        },
      ]);
      expect(page.body.file).toEqual({ kind: "not-selected" });
    });

    it("lets its adder or a manager replace a definition, and refuses another member", async () => {
      await start();
      expect((await addPreset("alice", "17")).status).toBe(200);
      expect(await addPreset("carol", "18")).toEqual({
        status: 403,
        body: {
          _tag: "ResourceDenied",
          message:
            "replacing a definition someone else added is theirs or a manager's: the project's creator or an organization owner",
        },
      });
      expect(resolved).toEqual(["postgres:17"]);
      expect(lines((await list("carol")).body.settings)).toEqual([
        "@db · postgres 17 · project · added by Alice · not started",
      ]);

      await remove("alice", (await list("alice")).body.settings[0]?.id ?? "", "0".repeat(64));
      const carols = await add("carol", { kind: "definition", spec: mailpit("mail", "project") });
      expect(carols.status).toBe(200);
      const replaced = await add("carol", {
        kind: "definition",
        spec: mailpit("mail", "project", "axllent/mailpit:v1.27"),
      });
      expect(replaced).toMatchObject({
        status: 200,
        body: { definition: { id: carols.body.definition.id, addedBy: "carol" } },
      });
      const byManager = await add("alice", {
        kind: "definition",
        spec: mailpit("mail", "project", "axllent/mailpit:v1.28"),
      });
      expect(byManager.body.definition).toMatchObject({
        id: carols.body.definition.id,
        image: `axllent/mailpit:v1.28@${digestFor("axllent/mailpit:v1.28")}`,
        statusLine: "@mail · mailpit · project · added by Alice · not started",
      });
    });

    it("answers the same spec as settings hold it to a member who may not replace it, asking no registry", async () => {
      await start();
      const alices = await addPreset("alice", "17");
      resolved.length = 0;
      const again = await addPreset("carol", "17");
      expect(again).toEqual({
        status: 200,
        body: {
          ...alices.body,
          resolvedBy: null,
          definition: { ...alices.body.definition, canRemove: false },
        },
      });
      expect(resolved).toEqual([]);
      // Its adder adding it again asks the registry again, and a tag that moved is pinned anew.
      resolveImage = () =>
        Effect.succeed({ digest: digestFor("a tag moved since"), resolvedBy: "fake-registry" });
      expect((await addPreset("alice", "17")).body).toMatchObject({
        resolvedBy: "fake-registry",
        definition: { image: `postgres:17@${digestFor("a tag moved since")}` },
      });
    });

    it("refuses a definition the rules refuse, a line per field, before any registry is asked", async () => {
      await start();
      const refused = await add("carol", {
        kind: "definition",
        spec: { ...mailpit("mail", "worktree"), ports: [] },
      });
      expect(refused).toMatchObject({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          message: "@mail · ports names no port, and a resource is reached on one",
        },
      });
      expect(resolved).toEqual([]);
      expect(await definitionCount()).toBe(0);
    });

    it("refuses a preset version that names no major, keyed by version, and stores nothing", async () => {
      await start();
      expect(await addPreset("carol", "latest")).toEqual({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          name: "db",
          refusals: [
            {
              key: "version",
              message:
                "is not an image tag that starts with its major version, such as 17 or 16.4-bookworm",
            },
          ],
          message:
            "@db · version is not an image tag that starts with its major version, such as 17 or 16.4-bookworm",
        },
      });
      expect(await definitionCount()).toBe(0);
    });

    it("refuses an image that is no reference, a terminal escape in it, and stores nothing", async () => {
      await start();
      const refused = await harness().request(
        "carol",
        "POST",
        `/api/projects/${shared.project}/resources?${zone}`,
        {
          kind: "definition",
          spec: { ...mailpit("mail", "project"), image: "mail\u001b[2J\u001b[H:1" },
        },
      );
      expect(refused.status).toBe(400);
      expect(await definitionCount()).toBe(0);
    });

    it("refuses a replacement that changes what own is while a worktree holds it as own, before any registry", async () => {
      await start();
      const db = (await addPreset("carol", "17")).body.definition;
      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "own")).status).toBe(200);
      resolved.length = 0;
      expect(await addPreset("carol", "17", "worktree")).toMatchObject({
        status: 422,
        body: {
          refusals: [
            {
              key: "scope",
              message:
                "changes what own is, and 1 worktree holds @db as own, with data of its own · switch it to shared or off first",
            },
          ],
        },
      });
      expect(resolved).toEqual([]);
      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "shared")).status).toBe(200);
      expect((await addPreset("carol", "17", "worktree")).status).toBe(200);
    });

    it("gives a whole preset definition with no command its engine settings", async () => {
      await start();
      const spec = presetDefinition({
        name: ResourceName.make("db"),
        preset: "postgres",
        version: PresetVersion.make("17"),
        scope: "project",
      });
      const added = await add("carol", { kind: "definition", spec: { ...spec, command: null } });
      expect(added.body.definition.spec.command).toEqual(spec.command);
      expect(added.body.definition.digest).toBe(
        (await addPreset("carol", "17")).body.definition.digest,
      );
    });

    it("says a registry that cannot pin the image, and adds nothing", async () => {
      await start();
      resolveImage = (image) =>
        Effect.fail(new ImageResolutionError({ image, reason: "unavailable" }));
      expect(await addPreset("carol", "17")).toEqual({
        status: 503,
        body: {
          _tag: "ResourceRegistryUnavailable",
          message:
            "@db · image postgres:17 · registry did not answer · try adding it again · not added",
        },
      });
      resolveImage = (image) =>
        Effect.fail(new ImageResolutionError({ image, reason: "not-found" }));
      expect(await addPreset("carol", "17")).toEqual({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          name: "db",
          refusals: [
            { key: "image", message: "postgres:17 · not found in the registry · not added" },
          ],
          message: "@db · image postgres:17 · not found in the registry · not added",
        },
      });
      expect(await definitionCount()).toBe(0);
    });

    it("answers 404 for a project the caller cannot see, before reading or writing anything", async () => {
      await start();
      expect((await list("bob")).status).toBe(404);
      expect((await addPreset("bob", "17")).status).toBe(404);
      expect((await addPreset("dave", "17")).status).toBe(404);
      expect(harness().world.calls.filter((call) => call.startsWith("resources."))).toEqual([]);
      expect(resolved).toEqual([]);
    });
  });

  describe("removing", () => {
    it("lets its adder or a manager remove a definition as they read it, and nobody else", async () => {
      await start();
      const alices = (await addPreset("alice", "17")).body.definition;
      expect((await list("carol")).body.settings).toMatchObject([{ canRemove: false }]);
      expect(await remove("carol", alices.id, alices.digest)).toEqual({
        status: 403,
        body: {
          _tag: "ResourceDenied",
          message:
            "removing a definition someone else added is theirs or a manager's: the project's creator or an organization owner",
        },
      });
      expect((await remove("alice", alices.id, "0".repeat(64))).status).toBe(409);
      expect(await remove("alice", alices.id, alices.digest)).toEqual({
        status: 200,
        body: { statusLine: "@db · definition removed" },
      });

      const carols = (await addPreset("carol", "17")).body.definition;
      expect(await remove("carol", carols.id, carols.digest)).toMatchObject({ status: 200 });
      expect((await list("alice")).body.settings).toEqual([]);
    });
  });

  describe("a worktree's mend.toml", () => {
    it("lists a table settings do not hold with an add, and adding it makes it the same", async () => {
      await start();
      const table = await tableOf("carol");
      expect(table).toMatchObject({
        statusLine: "@mail · mailpit · worktree · in mend.toml · not in settings",
        add: { kind: "ready" },
      });
      const added = await add("carol", { kind: "definition", spec: table.spec });
      expect(added.body.definition).toMatchObject({
        digest: table.digest,
        statusLine: "@mail · mailpit · worktree · added by Carol · not started",
      });
      expect(await tableOf("carol")).toMatchObject({
        statusLine: "@mail · mailpit · worktree · in mend.toml · same as settings",
        add: { kind: "added" },
      });
    });

    it("says a table differs from settings, and offers its replacement as the add answers", async () => {
      await start();
      await add("alice", {
        kind: "definition",
        spec: mailpit("mail", "worktree", "axllent/mailpit:v1.20"),
      });
      const carols = await tableOf("carol");
      const denied = {
        kind: "denied",
        message:
          "replacing a definition someone else added is theirs or a manager's: the project's creator or an organization owner",
      };
      expect(carols).toMatchObject({
        statusLine: "@mail · mailpit · worktree · in mend.toml · differs from settings",
        add: denied,
      });
      expect(await add("carol", { kind: "definition", spec: carols.spec })).toEqual({
        status: 403,
        body: { _tag: "ResourceDenied", message: denied.message },
      });
      const alices = await tableOf("alice");
      expect(alices.add).toEqual({ kind: "ready" });
      expect((await add("alice", { kind: "definition", spec: alices.spec })).status).toBe(200);
      expect((await tableOf("carol")).add).toEqual({ kind: "added" });
    });

    it("offers no table whose export sets an env name another definition sets, and says why", async () => {
      await start();
      await add("alice", {
        kind: "definition",
        spec: { ...mailpit("db", "project"), exports: { MAIN_URL: "smtp://{host}" } },
      });
      file = {
        text: [
          "[resource.db-main]",
          'image = "axllent/mailpit:v1.21"',
          'scope = "project"',
          "ports = { smtp = 1025 }",
          'exports = { URL = "smtp://{host}" }',
        ].join("\n"),
        stamp: WORKTREE_STAMP,
      };
      const table = await tableOf("carol");
      const refusals = [
        { key: "exports.URL", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
      ];
      expect(table.add).toEqual({ kind: "rejected", refusals });
      resolved.length = 0;
      expect(await add("carol", { kind: "definition", spec: table.spec })).toMatchObject({
        status: 422,
        body: { _tag: "ResourceRejected", refusals },
      });
      expect(resolved).toEqual([]);
    });

    it("reads the selected worktree's tables, with the keys it ignores", async () => {
      await start();
      const page = await list("carol", `&worktreeId=${shared.worktree}`);
      expect(page.body.file).toMatchObject({
        kind: "read",
        worktreeId: shared.worktree,
        observed: "observed on the worktree",
        tables: [{ statusLine: "@mail · mailpit · worktree · in mend.toml · not in settings" }],
        refused: [],
        ignored: [{ key: "resource.mail.device" }],
      });
      expect((await list("carol", `&worktreeId=${ids("shared-b").worktree}`)).status).toBe(404);
    });

    it("keeps where a file that does not parse was read, beside why", async () => {
      await start();
      file = {
        text: "[resource.mail\nimage = 1",
        stamp: { ...WORKTREE_STAMP, source: "capture", captureN: 12, seq: "4180" },
      };
      expect((await list("carol", `&worktreeId=${shared.worktree}`)).body.file).toEqual({
        kind: "unparsed",
        worktreeId: shared.worktree,
        observed: "observed at capture 12 · seq 4180",
        message:
          "mend.toml is not valid TOML: line 1, column 2 · incomplete key-value: cannot find end of key",
      });
    });

    it("says where a file does not parse and why, and quotes none of its lines to a person either", async () => {
      await start();
      file = {
        text: [
          "[resource.mail]",
          'image = "axllent/mailpit:v1.21"',
          "ports = { smtp = 1025 }",
          'env = { MP_UI_AUTH = "fake-value-gate1201" BAD }',
          'device = "/dev/null"',
        ].join("\n"),
        stamp: { ...WORKTREE_STAMP, source: "capture", captureN: 2, seq: "1", partial: true },
      };
      const page = await list("carol", `&worktreeId=${shared.worktree}`);
      expect(page.body.file).toEqual({
        kind: "unparsed",
        worktreeId: shared.worktree,
        observed: "observed at capture 2 · seq 1 · partial",
        message:
          "mend.toml is not valid TOML: line 4, column 44 · unexpected character encountered",
      });
      const wire = JSON.stringify(page.body);
      for (const excerpt of ["fake-value-gate1201", "MP_UI_AUTH", "BAD", "smtp", "/dev/null"]) {
        expect(wire).not.toContain(excerpt);
      }
    });
  });

  it("names every person on the page with one read of the accounts", async () => {
    await start();
    await addPreset("alice", "17");
    await add("carol", { kind: "definition", spec: mailpit("mail", "project") });
    const before = harness().world.calls.length;
    expect((await list("carol")).status).toBe(200);
    expect(
      harness()
        .world.calls.slice(before)
        .filter((call) => call.startsWith("users.")),
    ).toEqual(["users.byIds"]);
  });

  describe("choosing", () => {
    it("stores a change owner's choice and answers the row it wrote", async () => {
      await start();
      const db = (await addPreset("alice", "17")).body.definition;
      expect(await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "own")).toEqual({
        status: 200,
        body: {
          definitionId: db.id,
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
          mode: "own",
          revision: 0,
          chosenBy: "carol",
          statusLine:
            "@db · postgres 17 · project · added by Alice · its own database · not started",
        },
      });
      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "shared")).body).toMatchObject({
        mode: "shared",
        revision: 1,
      });
      expect((await use("alice", CAROL_WORKTREE_IN_SHARED_A, db.id, "off")).body).toEqual({
        _tag: "ResourceDenied",
        message:
          "choosing how this worktree uses a resource is its change owner's: the owner of its first session",
      });
    });

    it("reads a worktree's stored choice back on its line, and the read writes none", async () => {
      await start();
      const db = (await addPreset("alice", "17")).body.definition;
      const settingsLines = async (query: string) =>
        lines((await list("carol", query)).body.settings);
      expect(await settingsLines(forCarol)).toEqual([
        "@db · postgres 17 · project · added by Alice · not started",
      ]);
      expect((await list("carol", forCarol)).body.settings).toMatchObject([
        { choice: null, canChoose: true },
      ]);
      expect((await list("alice", forCarol)).body.settings).toMatchObject([
        { choice: null, canChoose: false },
      ]);
      await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "own");
      expect(await settingsLines(forCarol)).toEqual([
        "@db · postgres 17 · project · added by Alice · its own database · not started",
      ]);
      expect(await settingsLines("")).toEqual([
        "@db · postgres 17 · project · added by Alice · not started",
      ]);
      // The reads took no revision: the next choice is the first one after "own".
      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "off")).body).toMatchObject({
        revision: 1,
      });
    });

    it("names the resource a refused choice is of, and says each refusal as a clause", async () => {
      await start();
      const cache = (
        await add("carol", {
          kind: "preset",
          name: "cache",
          preset: "redis",
          version: "8",
          scope: "project",
        })
      ).body.definition;
      expect(await use("carol", CAROL_WORKTREE_IN_SHARED_A, cache.id, "own")).toEqual({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          name: "cache",
          refusals: [{ key: "mode", message: "is own, and @cache offers shared, off" }],
          message: "@cache · mode is own, and @cache offers shared, off",
        },
      });
    });

    it("answers another project's definition as not found, and never says its name", async () => {
      await start();
      const elsewhere = ProjectId.make("p_resources_elsewhere");
      await runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
            VALUES (${elsewhere}, 'elsewhere', '/store/elsewhere', 'main', 'org-a')
            ON CONFLICT (id) DO NOTHING`,
        ),
      );
      const hidden = await runtime.runPromise(
        Effect.flatMap(repoNow, (repo) =>
          repo.declare(
            elsewhere,
            {
              spec: mailpit("secret-mail", "project"),
              imageDigest: ImageDigest.make(`sha256:${"f".repeat(64)}`),
            },
            "bob",
          ),
        ),
      );
      const chosen = await use("carol", CAROL_WORKTREE_IN_SHARED_A, hidden.id, "off");
      expect(chosen.status).toBe(404);
      expect(JSON.stringify(chosen.body)).not.toContain("secret-mail");
    });
  });

  it("refuses every start in the words a recipe's depends says", async () => {
    await start();
    const refused = await harness()
      .request("carol", "POST", `/api/projects/${shared.project}/resources/db/start`)
      .then(json);
    expect(refused).toEqual({
      status: 409,
      body: {
        _tag: "ResourceRuntimeUnavailable",
        message: resourceRuntimeRefusal("db"),
      },
    });
    expect(refused.body.message).toBe(
      "@db · resources need a newer Sealant on this runtime · this session can run its own [service.db]",
    );
    expect(
      (await harness().request("bob", "POST", `/api/projects/${shared.project}/resources/db/start`))
        .status,
    ).toBe(404);
  });
});
