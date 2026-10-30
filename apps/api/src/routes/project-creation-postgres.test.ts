import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { PgClient } from "@effect/sql-pg";
import { projectsGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AuditEventsRepo,
  HotWorkspacesRepo,
  InstanceRolesRepoLive,
  MendDBLive,
  migrations,
  OrganizationsRepo,
  OrganizationsRepoLive,
  ProjectsRepo,
  ProjectsRepoLive,
  ResourcesRepo,
  ServiceForwardsRepo,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionRepositoriesRepo,
  SessionsRepoLive,
  UserGitAccessRepoLive,
  UserGitAuthorRepo,
  UserGitAuthorRepoLive,
  WorktreeChangesRepoLive,
  WorktreesRepoLive,
} from "@mend/db";
import { postgresTestConfig } from "@mend/db/testing";
import { type OrganizationId, ProjectId } from "@mend/domain";
import { JobRunner } from "@mend/jobs";
import { SealantClient } from "@mend/sealant";
import { SessionEngine, WorktreeReads } from "@mend/sessions";
import {
  AgentBridge,
  DeploymentConfig,
  MendKeys,
  makeSourcePolicy,
  SourcePolicy,
  Store,
  StoreConfig,
  UNSETTLED_REPOSITORY_MARKER,
} from "@mend/store";
import { Effect, Layer, ManagedRuntime, Option, Redacted, Schema, String as Str } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectAccessLive } from "../access.ts";
import { errorBoundary } from "../error-boundary.ts";
import { GithubIdentity } from "../github-identity.ts";
import { ProjectCreationLive } from "../project-creation.ts";
import { Removal } from "../removal.ts";
import { TenancyConfig } from "../tenancy.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { Gh } from "./github.ts";
import { ProjectsGroupLive } from "./workbench.ts";

/**
 * `POST /api/projects/new` and `POST /api/projects/scratch` as a client calls them: real
 * PostgreSQL (the keys that make names and scratch projects unique), real git in a throwaway
 * store, and the real project access rules for what another person can see.
 */

const postgres = postgresTestConfig();
const database = `mend_project_creation_${process.pid}_${Date.now()}`;
const databaseUrl = new URL(postgres.adminUrl);
databaseUrl.pathname = `/${database}`;

interface Person {
  readonly id: string;
  name: string;
  readonly email: string;
}
const people: Record<string, Person> = {
  anna: { id: "anna", name: "Anna Example", email: "anna@example.com" },
  ben: { id: "ben", name: "Ben Other", email: "ben@example.com" },
  cleo: { id: "cleo", name: "", email: "Cleo.Q+mend@example.com" },
  dora: { id: "dora", name: "Dora Elsewhere", email: "dora@example.com" },
  nobody: { id: "nobody", name: "No Org", email: "nobody@example.com" },
};

const authLayer: Layer.Layer<Auth> = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  issuePasswordReset: () => Effect.die("unused"),
  getSession: (headers) => {
    const person = people[(headers.get("authorization") ?? "").replace(/^Bearer /, "")];
    return Effect.succeed(
      person === undefined
        ? Option.none()
        : Option.some({
            user: { id: person.id, name: person.name, email: person.email },
            expiresAt: new Date("2030-01-01T00:00:00.000Z"),
          }),
    );
  },
});

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mend-project-creation-"));

const databaseLayer = (startupParameters?: Readonly<Record<string, string>>) =>
  MendDBLive.pipe(
    Layer.provideMerge(
      PgClient.layer({
        url: Redacted.make(databaseUrl.toString()),
        transformResultNames: Str.snakeToCamel,
        maxConnections: 8,
        startupParameters,
      }),
    ),
  );
const repos = Layer.mergeAll(
  ProjectsRepoLive,
  OrganizationsRepoLive,
  UserGitAuthorRepoLive,
  UserGitAccessRepoLive,
  InstanceRolesRepoLive,
  SessionsRepoLive,
  WorktreesRepoLive,
  WorktreeChangesRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
);
const unused = Layer.mergeAll(
  Layer.mock(AuditEventsRepo, { record: () => Effect.void }),
  Layer.succeed(
    SourcePolicy,
    makeSourcePolicy({ profile: "operator", allowedHosts: [], resolve: async () => [] }),
  ),
  Layer.mock(AgentBridge, { socketPath: () => "/unused/agent.sock" }),
  Layer.mock(MendKeys, {}),
  Layer.mock(ServiceForwardsRepo, {}),
  Layer.mock(ResourcesRepo, {}),
  Layer.mock(SessionEngine, {
    launchUnderWay: () => false,
    personLayoutPossible: () => Effect.succeed(false),
    reconcileHotSessions: () => Effect.void,
  }),
  Layer.mock(HotWorkspacesRepo, {}),
  Layer.mock(SealantClient, {}),
  Layer.mock(JobRunner, {}),
  Layer.mock(WorktreeReads, {}),
  Layer.mock(Gh, {}),
  Layer.mock(GithubIdentity, {}),
  Layer.mock(SessionRepositoriesRepo, { listForProject: () => Effect.succeed([]) }),
  Layer.mock(Removal, {}),
  Layer.succeed(DeploymentConfig, {
    mode: "local",
    sessionEndpoint: undefined,
    sessionStore: "captured",
  }),
  Layer.succeed(TenancyConfig, { mode: "single", gate: Effect.succeed([]) }),
);
const dependencies = (startupParameters?: Readonly<Record<string, string>>) =>
  Layer.mergeAll(ProjectAccessLive, ProjectCreationLive).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        repos,
        unused,
        Store.layer.pipe(Layer.provide(StoreConfig.layerFor(storeRoot))),
      ),
    ),
    Layer.provideMerge(databaseLayer(startupParameters)),
  );
type Services = Layer.Success<ReturnType<typeof dependencies>>;
const runtime = ManagedRuntime.make(dependencies());
/** Its connections resolve an unqualified pg_notify to the test's refusing one in public. */
const notifyRefusingRuntime = ManagedRuntime.make(
  dependencies({ search_path: "public, pg_catalog" }),
);

const api = Layer.mergeAll(
  HttpApiBuilder.layer(HttpApi.make("mend").add(projectsGroup).prefix("/api")).pipe(
    Layer.provide(ProjectsGroupLive),
    Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
  ),
  errorBoundary({ mode: "redacted" }),
).pipe(Layer.provide(HttpServer.layerServices));
const { handler, dispose: disposeHandler } = HttpRouter.toWebHandler(api, { disableLogger: true });

const admin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(PgClient.layer({ url: Redacted.make(postgres.adminUrl) })),
      Effect.scoped,
    ),
  );
const inWorld = <A, E>(effect: Effect.Effect<A, E, Services>) => runtime.runPromise(effect);

/** The fields of a Project on the wire these tests read. */
const WireProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  organizationId: Schema.String,
  visibility: Schema.String,
  createdByUserId: Schema.NullOr(Schema.String),
  originUrl: Schema.NullOr(Schema.String),
  storePath: Schema.String,
  defaultBranch: Schema.String,
  adoptedSha: Schema.NullOr(Schema.String),
  scratchOwnerUserId: Schema.NullOr(Schema.String),
});
type WireProject = typeof WireProject.Type;
const decodeProject = Schema.decodeUnknownSync(WireProject);
const decodeProjects = Schema.decodeUnknownSync(Schema.Array(WireProject));

const call = async (
  as: string,
  method: "GET" | "POST" | "PUT",
  route: string,
  body?: unknown,
  world: typeof runtime = runtime,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const context = await world.runPromise(Effect.context<Services>());
  const response = await handler(
    new Request(`http://api.internal${route}`, {
      method,
      headers: { authorization: `Bearer ${as}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  );
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : JSON.parse(text) };
};

const projectOf = (answer: { readonly status: number; readonly body: unknown }): WireProject => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return decodeProject(answer.body);
};
const create = async (as: string, name: string) =>
  projectOf(await call(as, "POST", "/api/projects/new", { name }));
const ensureScratch = async (as: string) =>
  projectOf(await call(as, "POST", "/api/projects/scratch", {}));
const listedIds = async (as: string): Promise<ReadonlyArray<string>> => {
  const answer = await call(as, "GET", "/api/projects");
  expect(answer.status).toBe(200);
  return decodeProjects(answer.body).map((project) => project.id);
};
const storeDirectories = () => fs.readdirSync(storeRoot).filter((entry) => !entry.startsWith("_"));
const gitIn = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim();
/** A row that holds a name, with no repository behind it: a name another project has. */
const holdName = (organizationId: OrganizationId, name: string, createdByUserId = "ben") =>
  inWorld(
    Effect.gen(function* () {
      const id = ProjectId.make(crypto.randomUUID());
      yield* (yield* ProjectsRepo).create({
        id,
        organizationId,
        visibility: "private",
        createdByUserId,
        name,
        originUrl: "https://example.invalid/held.git",
        storePath: `/elsewhere/${id}/repo.git`,
        defaultBranch: "main",
        adoptedSha: null,
        gitAuthMode: "mend-key",
      });
    }),
  );

let acme: OrganizationId;

describe.skipIf(postgres.skip)("project creation, against PostgreSQL and git", () => {
  beforeAll(async () => {
    await admin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
      }),
    );
    acme = await inWorld(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        for (const person of Object.values(people)) {
          yield* sql`INSERT INTO "user" ("id", "name", "email", "createdAt")
            VALUES (${person.id}, ${person.name}, ${person.email}, now())`;
        }
        const organizations = yield* OrganizationsRepo;
        const home = yield* organizations.create("Acme", null);
        const elsewhere = yield* organizations.create("Elsewhere", null);
        yield* organizations.addMember(home.id, "anna", "owner", null);
        yield* organizations.addMember(home.id, "ben", "member", null);
        yield* organizations.addMember(home.id, "cleo", "member", null);
        yield* organizations.addMember(elsewhere.id, "dora", "owner", null);
        yield* sql.unsafe(`CREATE FUNCTION public.pg_notify(text, text) RETURNS void
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'notification refused'; END $$`);
        return home.id;
      }),
    );
  });

  afterAll(async () => {
    await disposeHandler();
    await runtime.dispose();
    await notifyRefusingRuntime.dispose();
    await admin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(
          `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
        );
      }),
    );
    fs.rmSync(storeRoot, { recursive: true, force: true });
  });

  describe("POST /api/projects/new", () => {
    it("answers a private project with no origin, one Initial commit by the caller on main", async () => {
      const project = await create("anna", "my-app");
      expect(project).toMatchObject({
        name: "my-app",
        organizationId: acme,
        visibility: "private",
        createdByUserId: "anna",
        originUrl: null,
        defaultBranch: "main",
        scratchOwnerUserId: null,
      });
      expect(project.storePath).toBe(path.join(storeRoot, project.id, "repo.git"));
      expect(project.adoptedSha).toBe(gitIn(project.storePath, "rev-parse", "main"));
      expect(
        fs.existsSync(path.join(path.dirname(project.storePath), UNSETTLED_REPOSITORY_MARKER)),
      ).toBe(false);
      expect(gitIn(project.storePath, "log", "--all", "--format=%an|%ae|%cn|%ce|%s|%P")).toBe(
        "Anna Example|anna@example.com|Anna Example|anna@example.com|Initial commit|",
      );
      expect(gitIn(project.storePath, "show", "main:README.md")).toBe("# my-app");
      expect(gitIn(project.storePath, "remote")).toBe("");
      expect(await listedIds("anna")).toContain(project.id);

      const branches = await call("anna", "GET", `/api/projects/${project.id}/branches`);
      expect(branches.body).toMatchObject([{ name: "main", isDefault: true }]);
    });

    it("commits as the caller's git author setting when they saved one", async () => {
      await inWorld(
        Effect.gen(function* () {
          yield* (yield* UserGitAuthorRepo).set("ben", {
            name: "Ben At Work",
            email: "ben@work.example",
          });
        }),
      );
      const project = await create("ben", "bens-notes");
      expect(gitIn(project.storePath, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe(
        "Ben At Work|ben@work.example|Ben At Work|ben@work.example",
      );
    });

    it("takes the first free name from name-2, counting projects the caller cannot see", async () => {
      await holdName(acme, "notes", "ben");
      await holdName(acme, "notes-2", "ben");
      await holdName(acme, "notes-4", "anna");
      const third = await create("anna", "notes");
      expect(third.name).toBe("notes-3");
      expect(gitIn(third.storePath, "show", "main:README.md")).toBe("# notes-3");
      expect(JSON.stringify(third)).not.toContain("/elsewhere/");
      expect((await create("anna", "notes")).name).toBe("notes-5");

      expect((await create("dora", "notes")).name).toBe("notes");
    });

    it("gives concurrent creations of one name each their own name and repository", async () => {
      const before = storeDirectories().length;
      const made = await Promise.all(Array.from({ length: 5 }, () => create("anna", "race")));
      expect(made.map((project) => project.name).toSorted()).toEqual([
        "race",
        "race-2",
        "race-3",
        "race-4",
        "race-5",
      ]);
      expect(storeDirectories().length).toBe(before + 5);
      for (const project of made) {
        expect(gitIn(project.storePath, "show", "main:README.md")).toBe(`# ${project.name}`);
      }
    });

    it("removes the repository and registers nothing when the event notification fails", async () => {
      const before = storeDirectories();
      const answer = await call(
        "anna",
        "POST",
        "/api/projects/new",
        { name: "unannounced" },
        notifyRefusingRuntime,
      );
      expect(answer.status, JSON.stringify(answer.body)).toBe(422);
      expect(storeDirectories()).toEqual(before);
      const rows = await inWorld(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql`SELECT id FROM projects WHERE name = 'unannounced'`;
        }),
      );
      expect(rows).toEqual([]);
      expect((await create("anna", "unannounced")).name).toBe("unannounced");
    });
  });

  describe("POST /api/projects/scratch", () => {
    it("makes the caller's scratch project on first use, then answers it again", async () => {
      const before = storeDirectories().length;
      const scratch = await ensureScratch("anna");
      expect(scratch).toMatchObject({
        name: "scratch-anna-example",
        visibility: "private",
        createdByUserId: "anna",
        scratchOwnerUserId: "anna",
        originUrl: null,
        defaultBranch: "main",
      });
      expect(gitIn(scratch.storePath, "log", "--all", "--format=%an|%s|%P")).toBe(
        "Anna Example|Initial commit|",
      );
      const again = await ensureScratch("anna");
      expect(again.id).toBe(scratch.id);
      expect(storeDirectories().length).toBe(before + 1);
    });

    it("keeps its name and identity when the account is renamed", async () => {
      const first = await ensureScratch("anna");
      people["anna"] = { id: "anna", email: "anna@example.com", name: "Anna Renamed" };
      try {
        const after = await ensureScratch("anna");
        expect(after).toMatchObject({ id: first.id, name: "scratch-anna-example" });
      } finally {
        people["anna"] = { id: "anna", email: "anna@example.com", name: "Anna Example" };
      }
    });

    it("names it from the email and commits as the email's local part when the account has no name", async () => {
      const scratch = await ensureScratch("cleo");
      expect(scratch.name).toBe("scratch-cleo-q-mend");
      expect(gitIn(scratch.storePath, "log", "--all", "--format=%an|%ae|%cn|%ce|%s")).toBe(
        "Cleo.Q+mend|Cleo.Q+mend@example.com|Cleo.Q+mend|Cleo.Q+mend@example.com|Initial commit",
      );
      const named = await create("cleo", "cleos-notes");
      expect(gitIn(named.storePath, "log", "-1", "--format=%an|%ae")).toBe(
        "Cleo.Q+mend|Cleo.Q+mend@example.com",
      );
    });

    it("converges concurrent first uses on one project and removes every losing repository", async () => {
      const before = storeDirectories().length;
      const answers = await Promise.all(Array.from({ length: 10 }, () => ensureScratch("ben")));
      expect(new Set(answers.map((project) => project.id)).size).toBe(1);
      expect(storeDirectories().length).toBe(before + 1);
      const marked = await inWorld(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly id: string }>`
            SELECT id FROM projects WHERE scratch_owner_user_id = 'ben'`;
        }),
      );
      expect(marked.map((row) => row.id)).toEqual([answers[0]?.id]);
    });

    it("refuses a caller in no organization and makes nothing", async () => {
      const before = storeDirectories();
      const answer = await call("nobody", "POST", "/api/projects/scratch", {});
      expect(answer.status).toBe(422);
      expect(answer.body).toMatchObject({
        message: "This account belongs to no organization, so it cannot create projects.",
      });
      expect(storeDirectories()).toEqual(before);
    });

    it("leaves an ordinary scratch-named project alone and makes its own beside it", async () => {
      await holdName(acme, "scratch-eve");
      await inWorld(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO "user" ("id", "name", "email", "createdAt")
            VALUES ('eve', 'Eve', 'eve@example.com', now())`;
          yield* (yield* OrganizationsRepo).addMember(acme, "eve", "member", null);
        }),
      );
      people["eve"] = { id: "eve", name: "Eve", email: "eve@example.com" };
      const scratch = await ensureScratch("eve");
      expect(scratch).toMatchObject({ name: "scratch-eve-2", scratchOwnerUserId: "eve" });
      expect((await ensureScratch("eve")).id).toBe(scratch.id);
    });
  });

  describe("what another person sees", () => {
    it("shows neither a created project nor a scratch project to another member", async () => {
      const created = await create("anna", "private-one");
      const scratch = await ensureScratch("anna");
      const bens = await listedIds("ben");
      expect(bens).not.toContain(created.id);
      expect(bens).not.toContain(scratch.id);
      for (const id of [created.id, scratch.id]) {
        expect((await call("ben", "GET", `/api/projects/${id}/branches`)).status).toBe(404);
      }
      expect((await ensureScratch("ben")).id).not.toBe(scratch.id);
    });

    it("refuses to share a scratch project, and shares a created one", async () => {
      const scratch = await ensureScratch("anna");
      const refused = await call("anna", "PUT", `/api/projects/${scratch.id}/visibility`, {
        visibility: "shared",
      });
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ message: "Scratch projects are private." });
      const created = await create("anna", "to-share");
      const shared = await call("anna", "PUT", `/api/projects/${created.id}/visibility`, {
        visibility: "shared",
      });
      expect(projectOf(shared).visibility).toBe("shared");
    });
  });
});
