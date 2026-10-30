import { PgClient } from "@effect/sql-pg";
import {
  MendDBLive,
  migrations,
  ResourcesRepo,
  ResourcesRepoLive,
  type StoredResourceDefinition,
  UserFacts,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  presetDefinition,
  PresetVersion,
  ResourceDefinitionInput,
  ResourceName,
} from "@mend/domain/workbench";
import { WORKTREE_STAMP } from "@mend/sessions";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { type HarnessUser, ids } from "../../test/support/tenancy-harness.ts";

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
      }),
    );
  });

  afterEach(async () => {
    await api?.dispose();
    api = undefined;
    file = { text: MEND_TOML, stamp: WORKTREE_STAMP };
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM resource_proposals`;
        yield* sql`DELETE FROM resource_definitions`;
        yield* sql`DELETE FROM resource_approvals`;
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
  const list = (as: HarnessUser, query = "") =>
    harness()
      .request(as, "GET", `/api/projects/${shared.project}/resources?${zone}${query}`)
      .then(json);
  const propose = (as: HarnessUser, version: string) =>
    harness()
      .request(as, "POST", `/api/projects/${shared.project}/resource-proposals?${zone}`, {
        kind: "preset",
        name: "db",
        preset: "postgres",
        version,
        scope: "project",
      })
      .then(json);
  const declare = (): Promise<StoredResourceDefinition> =>
    runtime.runPromise(
      Effect.flatMap(repoNow, (repo) =>
        repo.declare(
          shared.project,
          presetDefinition({
            name: ResourceName.make("db"),
            preset: "postgres",
            version: PresetVersion.make("17"),
            scope: "project",
          }),
          "alice",
        ),
      ),
    );

  const declareSpec = (spec: ResourceDefinitionInput) =>
    runtime.runPromise(
      Effect.flatMap(repoNow, (repo) => repo.declare(shared.project, spec, "alice")),
    );
  const approve = (
    definition: StoredResourceDefinition,
    approvedBy: HarnessUser,
    worktreeId: WorktreeId | null,
  ) =>
    runtime.runPromise(
      Effect.flatMap(repoNow, (repo) =>
        repo.approve({
          definitionId: definition.id,
          digest: definition.specDigest,
          imageDigest: ImageDigest.make(`sha256:${"a".repeat(64)}`),
          worktreeId,
          approvedBy,
        }),
      ),
    );
  const mailpit = (name: string, scope: "project" | "worktree") =>
    decodeSpec({
      name,
      scope,
      preset: null,
      image: "axllent/mailpit:v1.21",
      command: null,
      ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
      env: {},
      volumes: [],
      ready: { kind: "tcp" },
      exports: {},
    });

  it("keeps two members' proposals of one name, and neither changes settings", async () => {
    await start();
    expect((await propose("carol", "17")).body).toMatchObject({
      proposedBy: "carol",
      canRemove: true,
      statusLine: "@db · postgres 17 · project · proposed by Carol · waiting for approval",
    });
    expect((await propose("alice", "18")).status).toBe(200);

    const page = await list("carol");
    expect(page.status).toBe(200);
    expect(page.body.settings).toEqual([]);
    expect(
      page.body.proposals.map((each: { statusLine: string; canRemove: boolean }) => [
        each.statusLine,
        each.canRemove,
      ]),
    ).toEqual([
      ["@db · postgres 17 · project · proposed by Carol · waiting for approval", true],
      ["@db · postgres 18 · project · proposed by Alice · waiting for approval", false],
    ]);
    expect(page.body.canPropose).toBe(true);
    expect(page.body.file).toEqual({ kind: "not-selected" });
  });

  it("lets a member remove only their own proposal", async () => {
    await start();
    const mine = (await propose("carol", "17")).body;
    const alices = (await propose("alice", "18")).body;
    const withdraw = (as: HarnessUser, id: string) =>
      harness()
        .request(as, "DELETE", `/api/projects/${shared.project}/resource-proposals/${id}`)
        .then(json);

    expect(await withdraw("carol", alices.id)).toEqual({
      status: 403,
      body: {
        _tag: "ResourceDenied",
        message:
          "removing another person's proposal is theirs or a manager's: the project's creator or an organization owner",
      },
    });
    expect(await withdraw("carol", mine.id)).toEqual({
      status: 200,
      body: { statusLine: "@db · proposal removed" },
    });
    expect((await list("carol")).body.proposals).toHaveLength(1);
  });

  it("lets a manager remove a definition as they read it, and nobody else", async () => {
    await start();
    const db = await declare();
    const remove = (as: HarnessUser, digest: string) =>
      harness()
        .request(as, "DELETE", `/api/projects/${shared.project}/resources/${db.id}`, {
          expectedDigest: digest,
        })
        .then(json);

    const page = await list("carol");
    expect(page.body.settings).toMatchObject([
      {
        id: db.id,
        canRemove: false,
        statusLine: "@db · postgres 17 · project · waiting for approval",
      },
    ]);
    expect((await remove("carol", db.specDigest)).body).toEqual({
      _tag: "ResourceDenied",
      message:
        "removing a definition is a manager's: the project's creator or an organization owner",
    });
    expect((await remove("alice", "0".repeat(64))).status).toBe(409);
    expect(await remove("alice", db.specDigest)).toEqual({
      status: 200,
      body: { statusLine: "@db · definition removed" },
    });
    expect((await list("alice")).body.settings).toEqual([]);
  });

  it("refuses a proposal the definition rules refuse, a line per field", async () => {
    await start();
    const refused = await harness()
      .request("carol", "POST", `/api/projects/${shared.project}/resource-proposals?${zone}`, {
        kind: "definition",
        spec: {
          name: "mail",
          scope: "worktree",
          preset: null,
          image: "axllent/mailpit:v1.21",
          command: null,
          ports: [],
          env: {},
          volumes: [],
          ready: { kind: "none" },
          exports: {},
        },
      })
      .then(json);
    expect(refused).toMatchObject({
      status: 422,
      body: {
        _tag: "ResourceRejected",
        message: "@mail · ports names no port, and a resource is reached on one",
      },
    });
  });

  it("refuses a preset version that names no major, keyed by version, and stores nothing", async () => {
    await start();
    expect(await propose("carol", "latest")).toEqual({
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
    expect((await list("carol")).body.proposals).toEqual([]);
  });

  it("refuses an image that is no reference, a terminal escape in it, and stores nothing", async () => {
    await start();
    const refused = await harness().request(
      "carol",
      "POST",
      `/api/projects/${shared.project}/resource-proposals?${zone}`,
      {
        kind: "definition",
        spec: {
          name: "mail",
          scope: "project",
          preset: null,
          image: "mail\u001b[2J\u001b[H:1",
          command: null,
          ports: [{ name: "smtp", port: 1025, protocol: "tcp" }],
          env: {},
          volumes: [],
          ready: { kind: "tcp" },
          exports: {},
        },
      },
    );
    expect(refused.status).toBe(400);
    expect((await list("carol")).body.proposals).toEqual([]);
  });

  it("answers 404 for a project the caller cannot see, before reading or writing anything", async () => {
    await start();
    expect((await list("bob")).status).toBe(404);
    expect((await propose("bob", "17")).status).toBe(404);
    expect((await propose("dave", "17")).status).toBe(404);
    expect(harness().world.calls.filter((call) => call.startsWith("resources."))).toEqual([]);
  });

  it("reads a worktree's own approval for that worktree, apart from a manager's for the project", async () => {
    await start();
    const mail = await declareSpec(mailpit("mail", "project"));
    const box = await declareSpec(mailpit("box", "worktree"));
    await approve(mail, "alice", null);
    await approve(box, "carol", shared.worktree);

    expect(lines((await list("carol")).body.settings)).toEqual([
      "@box · mailpit · worktree · waiting for approval",
      "@mail · mailpit · project · approved by Alice · not started",
    ]);
    expect(lines((await list("carol", `&worktreeId=${shared.worktree}`)).body.settings)).toEqual([
      "@box · mailpit · worktree · approved by Carol for this worktree · not started",
      "@mail · mailpit · project · approved by Alice · not started",
    ]);
  });

  it("says a proposal or a file table identical to settings is the same, not waiting", async () => {
    await start();
    await declare();
    await declareSpec(mailpit("mail", "worktree"));
    expect((await propose("carol", "17")).body.statusLine).toBe(
      "@db · postgres 17 · project · proposed by Carol · same as settings",
    );
    const page = await list("carol", `&worktreeId=${shared.worktree}`);
    expect(lines(page.body.proposals)).toEqual([
      "@db · postgres 17 · project · proposed by Carol · same as settings",
    ]);
    expect(lines(page.body.file.proposals)).toEqual([
      "@mail · mailpit · worktree · proposed in mend.toml · same as settings",
    ]);
  });

  it("names every person on the page with one read of the accounts", async () => {
    await start();
    await approve(await declare(), "alice", null);
    await propose("carol", "18");
    await propose("alice", "16");
    const before = harness().world.calls.length;
    expect((await list("carol")).status).toBe(200);
    expect(
      harness()
        .world.calls.slice(before)
        .filter((call) => call.startsWith("users.")),
    ).toEqual(["users.byIds"]);
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
      message: "mend.toml is not valid TOML: line 4, column 44 · unexpected character encountered",
    });
    const wire = JSON.stringify(page.body);
    for (const excerpt of ["fake-value-gate1201", "MP_UI_AUTH", "BAD", "smtp", "/dev/null"]) {
      expect(wire).not.toContain(excerpt);
    }
  });

  it("answers a proposal another removal took first as not found, not removed", async () => {
    await start((repo) => ({ ...repo, withdrawProposal: () => Effect.succeed(false) }));
    const mine = (await propose("carol", "17")).body;
    const withdrawn = await harness()
      .request("carol", "DELETE", `/api/projects/${shared.project}/resource-proposals/${mine.id}`)
      .then(json);
    expect(withdrawn.status).toBe(404);
  });

  it("reads the selected worktree's mend.toml proposals, with the keys it ignores", async () => {
    await start();
    const page = await list("carol", `&worktreeId=${shared.worktree}`);
    expect(page.body.file).toMatchObject({
      kind: "read",
      worktreeId: shared.worktree,
      observed: "observed on the worktree",
      proposals: [
        { statusLine: "@mail · mailpit · worktree · proposed in mend.toml · waiting for approval" },
      ],
      refused: [],
      ignored: [{ key: "resource.mail.device" }],
    });
    expect((await list("carol", `&worktreeId=${ids("shared-b").worktree}`)).status).toBe(404);
  });
});
