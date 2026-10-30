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
  type ResourceApprovalOffer,
  type ResourceApprovalRequest,
  ResourceDefinitionInput,
  ResourceName,
  type ResourceProposalEntry,
  resourceRuntimeRefusal,
  type ResourceSettingEntry,
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
type Listed = Pick<ResourceSettingEntry, "spec" | "digest" | "approvals" | "approve"> &
  Partial<Pick<ResourceSettingEntry, "id" | "choice" | "canChoose">> &
  Partial<Pick<ResourceProposalEntry, "mine">>;
/** Each entry's name, who approved it for which target, the targets it offers, and its flags. */
const flagsOf = (entries: ReadonlyArray<Listed>) =>
  entries.map(({ spec, approvals, approve, choice, canChoose, mine }) => ({
    name: spec.name,
    approved: [
      ...(approvals.project === null ? [] : [`project:${approvals.project.by}`]),
      ...(approvals.worktree === null ? [] : [`worktree:${approvals.worktree.by}`]),
    ],
    offers: (["project", "worktree"] as const).filter(
      (target) => approve[target]?.kind === "ready",
    ),
    ...(choice === undefined ? {} : { choice, canChoose }),
    ...(mine === undefined ? {} : { mine }),
  }));
/** The request a target offers, failing the test when it offers none. */
const ready = (offer: ResourceApprovalOffer | null) => {
  if (offer?.kind !== "ready") throw new Error(`no request offered: ${JSON.stringify(offer)}`);
  return offer.request;
};
type Source = "settings" | "proposal" | "file";
const entryOf = (page: ResourcesPage, source: Source, name: string): Listed => {
  const entries: ReadonlyArray<Listed> =
    source === "settings"
      ? page.settings
      : source === "proposal"
        ? page.proposals
        : page.file.kind === "read"
          ? page.file.proposals
          : [];
  const entry = entries.find((each) => each.spec.name === name);
  if (entry === undefined) throw new Error(`no ${source} entry @${name} on the page`);
  return entry;
};
/**
 * The request a client builds for an entry by itself, as `mend resource approve` does,
 * whatever the page offers: the source as read, and what settings held under its name.
 */
const requestFor = (
  page: ResourcesPage,
  source: Source,
  name: string,
  worktreeId: WorktreeId | null,
): ResourceApprovalRequest => {
  const held = page.settings.find((each) => each.spec.name === name);
  const settings = held === undefined ? null : { id: held.id, digest: held.digest };
  if (source === "settings") {
    if (held === undefined) throw new Error(`settings hold no @${name}`);
    return { source: { kind: "settings", id: held.id, digest: held.digest }, worktreeId };
  }
  if (source === "proposal") {
    const proposal = page.proposals.find((each) => each.spec.name === name);
    if (proposal === undefined) throw new Error(`no proposal @${name}`);
    return {
      source: { kind: "proposal", id: proposal.id, digest: proposal.digest, settings },
      worktreeId,
    };
  }
  if (page.file.kind !== "read") throw new Error(`no mend.toml read: ${page.file.kind}`);
  const table = page.file.proposals.find((each) => each.spec.name === name);
  if (table === undefined) throw new Error(`no mend.toml table @${name}`);
  return {
    source: {
      kind: "file",
      worktreeId: page.file.worktreeId,
      name: table.spec.name,
      digest: table.digest,
      settings,
    },
    worktreeId,
  };
};
/** The refusal of a worktree approval before a manager approved the spec (decision G4). */
const G4 = (name: string) => [
  {
    key: "image",
    message: `is not one a manager approved for this project · a manager approves @${name} for the project first`,
  },
];
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
          target:
            worktreeId === null
              ? { kind: "project", imageDigest: ImageDigest.make(`sha256:${"a".repeat(64)}`) }
              : { kind: "worktree", worktreeId },
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
    await approve(box, "alice", null);
    await approve(box, "carol", shared.worktree);

    expect(lines((await list("carol")).body.settings)).toEqual([
      "@box · mailpit · worktree · approved by Alice · not started",
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
            target: { kind: "project", imageDigest: ImageDigest.make(`sha256:${"f".repeat(64)}`) },
            approvedBy: "bob",
          }),
        ),
      );
    };
    const fileTable = async (as: HarnessUser, worktree: WorktreeId) => {
      const read = (await list(as, `&worktreeId=${worktree}`)).body.file;
      return read.proposals[0];
    };
    /**
     * Posts the request a client would build for a target, and expects the answer the page's
     * offer said: a ready request is that very request and approves; an approval already made is
     * answered with nothing new; a withheld one is refused in the offer's own words.
     */
    const answersAsOffered = async (
      as: HarnessUser,
      offer: ResourceApprovalOffer,
      request: ResourceApprovalRequest,
    ) => {
      const before = await approvals();
      const answer = await approveVia(as, request);
      switch (offer.kind) {
        case "ready":
          expect(offer.request).toEqual(request);
          expect(answer.status).toBe(200);
          return;
        case "approved":
          expect(answer).toMatchObject({ status: 200, body: { resolvedBy: null } });
          expect(await approvals()).toEqual(before);
          return;
        case "denied":
          expect(answer).toEqual({
            status: 403,
            body: { _tag: "ResourceDenied", message: offer.message },
          });
          return;
        case "rejected":
          expect(answer.status).toBe(422);
          expect(answer.body).toMatchObject({ _tag: "ResourceRejected" });
          expect(answer.body.refusals).toEqual(offer.refusals);
          expect(await approvals()).toEqual(before);
          return;
      }
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
            approvals: { project: { by: "alice" }, worktree: null },
            approve: { project: { kind: "approved" }, worktree: null },
            choice: null,
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

    it("offers a change owner the worktree's approval once a manager approved that spec, and says why before (G4)", async () => {
      await start();
      const read = async (as: HarnessUser): Promise<ResourcesPage> =>
        (await list(as, `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`)).body;
      const before = await read("carol");
      const table = entryOf(before, "file", "mail");
      expect(table.approve.worktree).toEqual({ kind: "rejected", refusals: G4("mail") });
      await answersAsOffered(
        "carol",
        table.approve.worktree ?? { kind: "approved" },
        requestFor(before, "file", "mail", CAROL_WORKTREE_IN_SHARED_A),
      );
      expect((await list("carol")).body.settings).toEqual([]);
      expect(resolved).toEqual([]);

      // The manager approves the image for the project, adopting the same table.
      const managers = entryOf(await read("alice"), "file", "mail");
      expect((await approveVia("alice", ready(managers.approve.project))).status).toBe(200);
      const after = await read("carol");
      const offer = entryOf(after, "settings", "mail").approve.worktree;
      expect(offer?.kind).toBe("ready");
      await answersAsOffered(
        "carol",
        offer ?? { kind: "approved" },
        requestFor(after, "settings", "mail", CAROL_WORKTREE_IN_SHARED_A),
      );
      expect(lines((await read("carol")).settings)).toEqual([
        "@mail · mailpit · worktree · approved by Carol for this worktree · not started",
      ]);
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
      const alices = ["project:alice"];

      // A manager approves for the project, a worktree-scoped mend.toml table included; a
      // worktree's own approval and its choice stay its change owner's.
      expect(await flags("alice", CAROL_WORKTREE_IN_SHARED_A)).toEqual({
        settings: [
          { name: "box", approved: [], offers: ["project"], choice: null, canChoose: false },
          { name: "db", approved: alices, offers: [], choice: "shared", canChoose: false },
        ],
        proposals: [{ name: "db", approved: [], offers: ["project"], mine: false }],
        file: [{ name: "mail", approved: [], offers: ["project"] }],
      });
      expect(await flags("carol", CAROL_WORKTREE_IN_SHARED_A)).toEqual({
        settings: [
          // No manager approved either for the project, so neither may be approved for the worktree.
          { name: "box", approved: [], offers: [], choice: null, canChoose: false },
          { name: "db", approved: alices, offers: [], choice: "shared", canChoose: true },
        ],
        proposals: [{ name: "db", approved: [], offers: [], mine: true }],
        file: [{ name: "mail", approved: [], offers: [] }],
      });
      // With no worktree read there is no choice and no worktree's approval.
      expect(await flags("carol", null)).toEqual({
        settings: [
          { name: "box", approved: [], offers: [], choice: null, canChoose: false },
          { name: "db", approved: alices, offers: [], choice: null, canChoose: false },
        ],
        proposals: [{ name: "db", approved: [], offers: [], mine: true }],
        file: "not-selected",
      });
      expect((await flags("alice", null)).settings).toEqual([
        { name: "box", approved: [], offers: ["project"], choice: null, canChoose: false },
        { name: "db", approved: alices, offers: [], choice: null, canChoose: false },
      ]);
    });

    it("approves a worktree for the image the manager approved, whatever its tag resolves to now", async () => {
      await start();
      const table = await fileTable("alice", CAROL_WORKTREE_IN_SHARED_A);
      expect((await approveVia("alice", ready(table.approve.project))).status).toBe(200);
      // The tag moves in the registry after the manager approved it, before anyone reads again.
      resolveImage = () =>
        Effect.succeed({ digest: digestFor("a tag moved since"), resolvedBy: "fake-registry" });
      resolved.length = 0;
      const page = (await list("carol", `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`)).body;
      const offered = ready(entryOf(page, "settings", "mail").approve.worktree);
      expect(await approveVia("carol", offered)).toMatchObject({
        status: 200,
        body: {
          image: `axllent/mailpit:v1.21@${digestFor("axllent/mailpit:v1.21")}`,
          resolvedBy: null,
          definition: { approvals: { worktree: { by: "carol" } } },
        },
      });
      expect(resolved).toEqual([]);
    });

    it("offers no replacement that changes what own is while a worktree holds it as own, and says why", async () => {
      await start();
      const db = await declare();
      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "own")).status).toBe(200);
      await runtime.runPromise(
        Effect.flatMap(repoNow, (repo) =>
          repo.propose(shared.project, { ...db.spec, scope: "worktree" }, "carol"),
        ),
      );
      const read = async (): Promise<ResourcesPage> =>
        (await list("alice", `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`)).body;
      const held = await read();
      const offer = entryOf(held, "proposal", "db").approve.project;
      expect(offer).toEqual({
        kind: "rejected",
        refusals: [
          {
            key: "scope",
            message:
              "changes what own is, and 1 worktree holds @db as own, with data of its own · switch it to shared or off first",
          },
        ],
      });
      await answersAsOffered("alice", offer, requestFor(held, "proposal", "db", null));

      expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, db.id, "shared")).status).toBe(200);
      const switched = await read();
      await answersAsOffered(
        "alice",
        entryOf(switched, "proposal", "db").approve.project,
        requestFor(switched, "proposal", "db", null),
      );
    });

    for (const source of ["proposal", "file"] as const) {
      it(`offers no ${source} whose export sets an env name another definition sets, and says why`, async () => {
        await start();
        await declareSpec({ ...mailpit("db", "project"), exports: { MAIN_URL: "smtp://{host}" } });
        const spec = { ...mailpit("db-main", "project"), exports: { URL: "smtp://{host}" } };
        if (source === "proposal") {
          await runtime.runPromise(
            Effect.flatMap(repoNow, (repo) => repo.propose(shared.project, spec, "carol")),
          );
        }
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
        const page: ResourcesPage = (
          await list("alice", `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`)
        ).body;
        const offer = entryOf(page, source, "db-main").approve.project;
        expect(offer).toEqual({
          kind: "rejected",
          refusals: [
            { key: "exports.URL", message: "sets MEND_RESOURCE_DB_MAIN_URL, as db does too" },
          ],
        });
        await answersAsOffered("alice", offer, requestFor(page, source, "db-main", null));
        expect(resolved).toEqual([]);
      });
    }

    it("approves a worktree's mend.toml table for the project, then for the worktree, as the page offers", async () => {
      await start();
      const read = (as: HarnessUser): Promise<ResourcesPage> =>
        list(as, `&worktreeId=${CAROL_WORKTREE_IN_SHARED_A}`).then(({ body }) => body);
      const table = entryOf(await read("alice"), "file", "mail");
      const notTheOwners = {
        kind: "denied",
        message:
          "approving a worktree resource for this worktree is its change owner's: the owner of its first session",
      };
      expect(table.approve.worktree).toEqual(notTheOwners);
      // Before a manager approves it for the project, its change owner is offered nothing to post.
      expect(entryOf(await read("carol"), "file", "mail").approve).toEqual({
        project: {
          kind: "denied",
          message:
            "approving a resource for the project is a manager's: the project's creator or an organization owner",
        },
        worktree: { kind: "rejected", refusals: G4("mail") },
      });
      const forProject = await approveVia("alice", ready(table.approve.project));
      expect(forProject).toMatchObject({
        status: 200,
        body: {
          definition: {
            statusLine: "@mail · mailpit · worktree · approved by Alice · not started",
          },
        },
      });

      const owners = await read("carol");
      const mail = entryOf(owners, "settings", "mail");
      expect(mail.approvals).toEqual({ project: { by: "alice" }, worktree: null });
      expect(mail.approve.project.kind).toBe("denied");
      const approved = { kind: "approved" };
      expect(await approveVia("carol", ready(mail.approve.worktree))).toMatchObject({
        status: 200,
        body: {
          definition: {
            approvals: { project: { by: "alice" }, worktree: { by: "carol" } },
            approve: { project: { kind: "denied" }, worktree: approved },
            statusLine:
              "@mail · mailpit · worktree · approved by Carol for this worktree · not started",
          },
        },
      });
      // Each target's approval stays listed, so neither offer comes back.
      const after = entryOf(await read("carol"), "settings", "mail");
      expect(after).toMatchObject({
        approvals: { project: { by: "alice" }, worktree: { by: "carol" } },
        approve: { project: { kind: "denied" }, worktree: approved },
      });
      expect(entryOf(await read("alice"), "settings", "mail").approve).toEqual({
        project: approved,
        worktree: notTheOwners,
      });
    });

    describe("every target's offer answers as it says, whatever the source, reader and settings", () => {
      const NAME = "mail-main";
      const specOf = (scope: "project" | "worktree", image = "axllent/mailpit:v1.21") => ({
        ...mailpit(NAME, scope),
        image,
        exports: { URL: "smtp://{host}" },
      });
      const tomlOf = (scope: "project" | "worktree") =>
        [
          `[resource.${NAME}]`,
          'image = "axllent/mailpit:v1.21"',
          `scope = "${scope}"`,
          "ports = { smtp = 1025 }",
          'exports = { URL = "smtp://{host}" }',
        ].join("\n");
      /** What settings hold before the page is read, beside the spec the entry is of. */
      const STATES = {
        "nothing under its name": async () => {},
        "this spec": async (scope: "project" | "worktree") => {
          await declareSpec(specOf(scope));
        },
        "this spec, approved for the project": async (scope: "project" | "worktree") => {
          await approve(await declareSpec(specOf(scope)), "alice", null);
        },
        "an older spec, approved for the project": async (scope: "project" | "worktree") => {
          await approve(await declareSpec(specOf(scope, "axllent/mailpit:v1.20")), "alice", null);
        },
        "an older project spec a worktree holds as own": async () => {
          const held = await declareSpec(specOf("project", "axllent/mailpit:v1.20"));
          expect((await use("carol", CAROL_WORKTREE_IN_SHARED_A, held.id, "own")).status).toBe(200);
        },
        "another definition setting the same env name": async () => {
          await declareSpec({ ...mailpit("mail", "project"), exports: { MAIN_URL: "{host}" } });
        },
      } as const;
      const READERS = [
        { reader: "a manager", as: "alice", worktree: CAROL_WORKTREE_IN_SHARED_A },
        { reader: "the change owner", as: "carol", worktree: CAROL_WORKTREE_IN_SHARED_A },
        { reader: "a member", as: "carol", worktree: shared.worktree },
        { reader: "a manager who owns the change", as: "alice", worktree: shared.worktree },
      ] as const;
      const SOURCES = ["settings", "proposal", "file"] as const;
      /** Each kind of offer the cases met, a refusal by its keys, so none passes by meeting none. */
      const met = new Set<string>();

      for (const scope of ["project", "worktree"] as const) {
        for (const [state, arrange] of Object.entries(STATES)) {
          for (const source of SOURCES) {
            // Settings hold the very spec of a settings entry.
            if (source === "settings" && !state.startsWith("this spec")) continue;
            for (const { reader, as, worktree } of READERS) {
              it(`${scope} · ${source} · ${state} · ${reader}`, async () => {
                await start();
                file = { text: tomlOf(scope), stamp: WORKTREE_STAMP };
                await arrange(scope);
                if (source === "proposal") {
                  await runtime.runPromise(
                    Effect.flatMap(repoNow, (repo) =>
                      repo.propose(shared.project, specOf(scope), "carol"),
                    ),
                  );
                }
                const read = async (): Promise<ResourcesPage> =>
                  (await list(as, `&worktreeId=${worktree}`)).body;
                const page = await read();
                const entry = entryOf(page, source, NAME);
                expect(entry.digest).toBe(entryOf(page, "file", NAME).digest);
                const targets = (["project", "worktree"] as const).flatMap((target) => {
                  const offer = entry.approve[target];
                  return offer === null ? [] : [{ target, offer }];
                });
                expect(targets.map(({ target }) => target)).toEqual(
                  scope === "worktree" ? ["project", "worktree"] : ["project"],
                );
                // A ready request writes, so it posts after every withheld one has answered.
                const ordered = targets.toSorted(
                  (a, b) => Number(a.offer.kind === "ready") - Number(b.offer.kind === "ready"),
                );
                for (const { target, offer } of ordered) {
                  met.add(
                    offer.kind === "rejected"
                      ? `rejected ${offer.refusals.map(({ key }) => key).join(" ")}`
                      : offer.kind,
                  );
                  const forWorktree = target === "project" ? null : worktree;
                  await answersAsOffered(as, offer, requestFor(page, source, NAME, forWorktree));
                  if (offer.kind === "ready") {
                    const after = entryOf(await read(), "settings", NAME).approve[target];
                    expect(after).toEqual({ kind: "approved" });
                  }
                }
              });
            }
          }
        }
      }

      it("met every kind of offer, and each rule's refusal", () => {
        expect([...met].toSorted()).toEqual([
          "approved",
          "denied",
          "ready",
          "rejected exports.URL",
          "rejected image",
          "rejected image exports.URL",
          "rejected image scope",
          "rejected scope",
        ]);
      });
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
