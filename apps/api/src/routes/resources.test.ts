import { createHash } from "node:crypto";

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
import { ProjectId, WorktreeId } from "@mend/domain";
import {
  ImageDigest,
  presetDefinition,
  PresetVersion,
  ResourceDefinitionInput,
  ResourceName,
  resourceRuntimeRefusal,
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
/** Each entry's name, its approval and choice when it is a definition, and its flags. */
type Flags = {
  readonly spec: { readonly name: string };
  readonly approval?: unknown;
  readonly choice?: unknown;
  readonly canApprove: boolean;
  readonly canChoose?: boolean;
};
const flagsOf = (entries: ReadonlyArray<Flags>) =>
  entries.map(({ spec, approval, choice, canApprove, canChoose }) => ({
    name: spec.name,
    ...(approval === undefined ? {} : { approval, choice, canChoose }),
    canApprove,
  }));
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
        yield* sql`DELETE FROM resource_proposals`;
        yield* sql`DELETE FROM resource_definitions`;
        yield* sql`DELETE FROM resource_approvals`;
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

  it("gives a whole preset definition with no command its engine settings, the same as settings", async () => {
    await start();
    await declare();
    const spec = presetDefinition({
      name: ResourceName.make("db"),
      preset: "postgres",
      version: PresetVersion.make("17"),
      scope: "project",
    });
    const proposed = await harness()
      .request("carol", "POST", `/api/projects/${shared.project}/resource-proposals?${zone}`, {
        kind: "definition",
        spec: { ...spec, command: null },
      })
      .then(json);
    expect(proposed.body).toMatchObject({
      spec: { command: spec.command },
      statusLine: "@db · postgres 17 · project · proposed by Carol · same as settings",
    });
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

  describe("approving and choosing", () => {
    const approveVia = (as: HarnessUser, body: unknown) =>
      harness()
        .request(as, "POST", `/api/projects/${shared.project}/resources/approvals?${zone}`, body)
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
    const approvals = () =>
      runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) =>
            sql<{ readonly worktreeId: string | null; readonly approvedBy: string }>`
            SELECT worktree_id AS "worktreeId", approved_by AS "approvedBy"
            FROM resource_approvals ORDER BY revision`,
        ),
      );
    /** `spec` adopted and approved in a project of the organization nobody here can see. */
    const approvedElsewhere = async (spec: ResourceDefinitionInput) => {
      const elsewhere = ProjectId.make("p_resources_elsewhere");
      await runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`INSERT INTO projects (id, name, store_path, default_branch, organization_id)
            VALUES (${elsewhere}, 'elsewhere', '/store/elsewhere', 'main', 'org-a')
            ON CONFLICT (id) DO NOTHING`,
        ),
      );
      return runtime.runPromise(
        Effect.flatMap(repoNow, (repo) =>
          repo.adoptAndApprove({
            projectId: elsewhere,
            spec,
            settings: null,
            imageDigest: ImageDigest.make(`sha256:${"f".repeat(64)}`),
            worktreeId: null,
            approvedBy: "bob",
          }),
        ),
      );
    };
    const fileTable = async (as: HarnessUser, worktree: WorktreeId) => {
      const read = (await list(as, `&worktreeId=${worktree}`)).body.file;
      return read.proposals[0];
    };

    it("adopts a member's proposal, pins its image, and approving again asks no registry", async () => {
      await start();
      const proposal = (await propose("carol", "17")).body;
      const first = await approveVia("alice", {
        source: { kind: "proposal", id: proposal.id, digest: proposal.digest, settings: null },
        worktreeId: null,
      });
      expect(first).toMatchObject({
        status: 200,
        body: {
          image: `postgres:17@${digestFor("postgres:17")}`,
          resolvedBy: "docker-mirror:5000",
          definition: {
            digest: proposal.digest,
            approval: { by: "alice", for: "project" },
            choice: null,
            canApprove: true,
            canChoose: false,
            statusLine: "@db · postgres 17 · project · approved by Alice · not started",
          },
        },
      });
      const again = await approveVia("alice", {
        source: { kind: "settings", id: first.body.definition.id, digest: proposal.digest },
        worktreeId: null,
      });
      expect(again.body).toEqual({ ...first.body, resolvedBy: null });
      expect(resolved).toEqual(["postgres:17"]);
      expect(await approvals()).toEqual([{ worktreeId: null, approvedBy: "alice" }]);
    });

    it("names no registry for an approval another made while the image resolved", async () => {
      const read = await declare();
      const made = await approve(read, "alice", null);
      // The lookup ran before that approval landed; the adoption finds it under its lock.
      await start((repo) => ({ ...repo, approvalAsRead: () => Effect.succeed(null) }));
      const answered = await approveVia("alice", {
        source: { kind: "settings", id: read.id, digest: read.specDigest },
        worktreeId: null,
      });
      expect(answered).toMatchObject({
        status: 200,
        body: { image: made.spec.image, resolvedBy: null },
      });
      expect(resolved).toEqual(["postgres:17"]);
    });

    it("refuses a read settings moved on from with 409, and writes nothing", async () => {
      await start();
      const read = await declare();
      const proposal = (await propose("carol", "18")).body;
      await declareSpec({ ...read.spec, image: "postgres:17.6" });
      expect(
        await approveVia("alice", {
          source: { kind: "settings", id: read.id, digest: read.specDigest },
          worktreeId: null,
        }),
      ).toEqual({
        status: 409,
        body: {
          _tag: "ResourceStale",
          message: "@db · the definition changed since you read it · nothing was approved",
        },
      });
      expect(
        await approveVia("alice", {
          source: {
            kind: "proposal",
            id: proposal.id,
            digest: proposal.digest,
            settings: { id: read.id, digest: read.specDigest },
          },
          worktreeId: null,
        }),
      ).toEqual({
        status: 409,
        body: {
          _tag: "ResourceStale",
          message: "@db · settings changed since you read it · nothing was approved",
        },
      });
      expect(await approvals()).toEqual([]);
    });

    it("answers no approval of a definition settings moved on from, or of another project's", async () => {
      await start();
      const read = await declare();
      const first = await approveVia("alice", {
        source: { kind: "settings", id: read.id, digest: read.specDigest },
        worktreeId: null,
      });
      expect(first.status).toBe(200);
      const proposal = (await propose("carol", "17")).body;
      const sameAsRead = {
        source: {
          kind: "proposal",
          id: proposal.id,
          digest: proposal.digest,
          settings: { id: read.id, digest: read.specDigest },
        },
        worktreeId: null,
      };
      await declareSpec({ ...read.spec, image: "postgres:17.6" });
      expect(await approveVia("alice", sameAsRead)).toEqual({
        status: 409,
        body: {
          _tag: "ResourceStale",
          message: "@db · settings changed since you read it · nothing was approved",
        },
      });

      const foreign = await approvedElsewhere(read.spec);
      const viaForeign = await approveVia("alice", {
        source: {
          ...sameAsRead.source,
          settings: { id: foreign.definition.id, digest: read.specDigest },
        },
        worktreeId: null,
      });
      expect(viaForeign.status).toBe(409);
      expect(JSON.stringify(viaForeign.body)).not.toContain("f".repeat(64));
      expect(resolved).toEqual(["postgres:17"]);
    });

    it("lets a change owner approve a worktree resource only once a manager approved its image", async () => {
      await start();
      const table = await fileTable("carol", CAROL_WORKTREE_IN_SHARED_A);
      const mine = {
        source: {
          kind: "file",
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
          name: "mail",
          digest: table.digest,
          settings: null,
        },
        worktreeId: CAROL_WORKTREE_IN_SHARED_A,
      };
      expect(await approveVia("carol", mine)).toMatchObject({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          message: `@mail · image is ${digestFor("axllent/mailpit:v1.21")}, which no manager approved for this project`,
        },
      });
      expect((await list("carol")).body.settings).toEqual([]);

      // The manager approves the image for the project, adopting the same table.
      expect((await approveVia("alice", { ...mine, worktreeId: null })).status).toBe(200);
      const approved = await approveVia("carol", mine);
      expect(approved).toMatchObject({
        status: 200,
        body: {
          definition: {
            statusLine:
              "@mail · mailpit · worktree · approved by Carol for this worktree · not started",
          },
        },
      });
      expect(await approvals()).toEqual([
        { worktreeId: null, approvedBy: "alice" },
        { worktreeId: CAROL_WORKTREE_IN_SHARED_A, approvedBy: "carol" },
      ]);
    });

    it("refuses a project resource for one worktree before it asks a registry", async () => {
      await start();
      const db = await declare();
      expect(
        await approveVia("carol", {
          source: { kind: "settings", id: db.id, digest: db.specDigest },
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
        }),
      ).toMatchObject({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          message:
            "@db · worktree is one worktree, and @db is a project resource, approved for the project",
        },
      });
      expect(resolved).toEqual([]);
    });

    it("refuses a manager another person's worktree, and a member the project", async () => {
      await start();
      const table = await fileTable("alice", CAROL_WORKTREE_IN_SHARED_A);
      const source = {
        kind: "file",
        worktreeId: CAROL_WORKTREE_IN_SHARED_A,
        name: "mail",
        digest: table.digest,
        settings: null,
      };
      expect(await approveVia("alice", { source, worktreeId: CAROL_WORKTREE_IN_SHARED_A })).toEqual(
        {
          status: 403,
          body: {
            _tag: "ResourceDenied",
            message:
              "approving a worktree resource for this worktree is its change owner's: the owner of its first session",
          },
        },
      );
      expect((await approveVia("carol", { source, worktreeId: null })).body).toEqual({
        _tag: "ResourceDenied",
        message:
          "approving a resource for the project is a manager's: the project's creator or an organization owner",
      });
      expect(resolved).toEqual([]);
    });

    it("says a registry that cannot pin the image, and approves nothing", async () => {
      await start();
      const db = await declare();
      const body = {
        source: { kind: "settings", id: db.id, digest: db.specDigest },
        worktreeId: null,
      };
      resolveImage = (image) =>
        Effect.fail(new ImageResolutionError({ image, reason: "unavailable" }));
      expect(await approveVia("alice", body)).toEqual({
        status: 503,
        body: {
          _tag: "ResourceRegistryUnavailable",
          message:
            "@db · image postgres:17 · registry did not answer · try approval again · not approved",
        },
      });
      resolveImage = (image) =>
        Effect.fail(new ImageResolutionError({ image, reason: "not-found" }));
      expect(await approveVia("alice", body)).toEqual({
        status: 422,
        body: {
          _tag: "ResourceRejected",
          name: "db",
          refusals: [
            { key: "image", message: "postgres:17 · not found in the registry · not approved" },
          ],
          message: "@db · image postgres:17 · not found in the registry · not approved",
        },
      });
      expect(await approvals()).toEqual([]);
    });

    it("stores a change owner's choice and answers the row it wrote", async () => {
      await start();
      const db = await declare();
      expect(await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "own")).toEqual({
        status: 200,
        body: {
          definitionId: db.id,
          worktreeId: CAROL_WORKTREE_IN_SHARED_A,
          mode: "own",
          revision: 0,
          chosenBy: "carol",
          statusLine: "@db · postgres 17 · project · waiting for approval · its own database",
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
      const db = await declare();
      const forWorktree = `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`;
      const settingsLines = async (query: string) =>
        lines((await list("carol", query)).body.settings);
      expect(await settingsLines(forWorktree)).toEqual([
        "@db · postgres 17 · project · waiting for approval",
      ]);
      await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "own");
      expect(await settingsLines(forWorktree)).toEqual([
        "@db · postgres 17 · project · waiting for approval · its own database",
      ]);
      expect(await settingsLines("")).toEqual([
        "@db · postgres 17 · project · waiting for approval",
      ]);
      // The reads took no revision: the next choice is the first one after "own".
      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "off")).body).toMatchObject({
        revision: 1,
      });
    });

    it("carries each definition's approval and stored choice, and each reader's flags", async () => {
      await start();
      const db = await declare();
      await approve(db, "alice", null);
      await declareSpec(mailpit("box", "worktree"));
      await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "shared");
      await propose("carol", "18");
      const flags = async (as: HarnessUser, worktree: WorktreeId | null) => {
        const { body } = await list(as, worktree === null ? "" : `&worktreeId=${worktree}`);
        return {
          settings: flagsOf(body.settings),
          proposals: flagsOf(body.proposals),
          file: body.file.kind === "read" ? flagsOf(body.file.proposals) : body.file.kind,
        };
      };
      const approved = { by: "alice", for: "project" };

      // A manager approves for the project; a worktree's own acts stay its change owner's.
      expect(await flags("alice", CAROL_WORKTREE_IN_SHARED_A)).toEqual({
        settings: [
          { name: "box", approval: null, choice: null, canChoose: false, canApprove: false },
          { name: "db", approval: approved, choice: "shared", canChoose: false, canApprove: true },
        ],
        proposals: [{ name: "db", canApprove: true }],
        file: [{ name: "mail", canApprove: false }],
      });
      // The change owner chooses for their worktree and approves its worktree resources.
      expect(await flags("carol", CAROL_WORKTREE_IN_SHARED_A)).toEqual({
        settings: [
          { name: "box", approval: null, choice: null, canChoose: false, canApprove: true },
          { name: "db", approval: approved, choice: "shared", canChoose: true, canApprove: false },
        ],
        proposals: [{ name: "db", canApprove: false }],
        file: [{ name: "mail", canApprove: true }],
      });
      // With no worktree read there is no choice, and every approval is the project's.
      expect(await flags("carol", null)).toEqual({
        settings: [
          { name: "box", approval: null, choice: null, canChoose: false, canApprove: false },
          { name: "db", approval: approved, choice: null, canChoose: false, canApprove: false },
        ],
        proposals: [{ name: "db", canApprove: false }],
        file: "not-selected",
      });
      expect((await flags("alice", null)).settings).toEqual([
        { name: "box", approval: null, choice: null, canChoose: false, canApprove: true },
        { name: "db", approval: approved, choice: null, canChoose: false, canApprove: true },
      ]);
    });

    it("names the resource a refused choice is of, and says each refusal as a clause", async () => {
      await start();
      const cache = await declareSpec(
        presetDefinition({
          name: ResourceName.make("cache"),
          preset: "redis",
          version: PresetVersion.make("8"),
          scope: "project",
        }),
      );
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
      const hidden = await approvedElsewhere(mailpit("secret-mail", "project"));
      const chosen = await use("carol", CAROL_WORKTREE_IN_SHARED_A, hidden.definition.id, "off");
      expect(chosen.status).toBe(404);
      expect(JSON.stringify(chosen.body)).not.toContain("secret-mail");
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
        (
          await harness().request(
            "bob",
            "POST",
            `/api/projects/${shared.project}/resources/db/start`,
          )
        ).status,
      ).toBe(404);
    });
  });
});
