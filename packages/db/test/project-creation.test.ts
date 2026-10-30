import { randomUUID } from "node:crypto";

import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId } from "@mend/domain";
import { Effect, Layer, Redacted, Result, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ProjectsRepo, ProjectsRepoLive, type InitializedProject } from "../src/repos/projects.ts";
import { uniqueViolationConstraint } from "../src/repos/unique-violation.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_project_creation_${process.pid}_${Date.now()}`;
const scratchUrl = new URL(postgres.adminUrl);
scratchUrl.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pool = PgClient.layer({
  url: Redacted.make(scratchUrl.toString()),
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
  maxConnections: 8,
});
const repos = ProjectsRepoLive.pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pool))));
const run = <A, E>(effect: Effect.Effect<A, E, ProjectsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repos), Effect.scoped));
const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));
const organizationId = OrganizationId.make("creation-org");
const input = (name: string, purpose: "named" | "scratch", user = "anna"): InitializedProject => {
  const id = ProjectId.make(randomUUID());
  return {
    id,
    organizationId,
    createdByUserId: user,
    name,
    purpose,
    storePath: `/store/${id}/repo.git`,
    gitAuthMode: "mend-key",
  };
};

describe.skipIf(postgres.skip)("initialized project publication in Postgres", () => {
  let created = false;
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
        created = true;
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const [name, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          if (name >= "0140") break;
          yield* migration;
        }
        for (const user of ["anna", "bea", "policy", "former"]) {
          yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES (${user}, ${user}, ${`${user}@example.com`}, now())`;
        }
        yield* sql`INSERT INTO organizations (id, name, created_by_user_id) VALUES (${organizationId}, 'Creation', 'anna')`;
        yield* sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${organizationId}, 'anna', 'owner'), (${organizationId}, 'bea', 'member'), (${organizationId}, 'policy', 'member')`;
        yield* sql`INSERT INTO projects (id, organization_id, created_by_user_id, name, store_path, default_branch) VALUES ('legacy-scratch', ${organizationId}, 'anna', 'scratch-anna', '/store/legacy/repo.git', 'main')`;
        for (const [name, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          if (name >= "0140") yield* migration;
        }
      }),
    );
  });
  afterAll(async () => {
    if (created)
      await withAdmin(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient).unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
        }),
      );
  });

  it("keeps existing scratch-prefixed projects ordinary and publishes a ready private project", async () => {
    await run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        expect(
          (yield* projects.byId(ProjectId.make("legacy-scratch"))).scratchOwnerUserId,
        ).toBeNull();
        const named = yield* projects.publishInitialized(input("notes", "named"));
        expect(named).toMatchObject({
          name: "notes",
          visibility: "private",
          createdByUserId: "anna",
          originUrl: null,
          adoptedSha: null,
          defaultBranch: "main",
          scratchOwnerUserId: null,
        });
        expect(yield* projects.byId(named.id)).toEqual(named);
        const conflict = yield* projects
          .publishInitialized(input("notes", "named"))
          .pipe(Effect.result);
        expect(Result.isFailure(conflict) && conflict.failure._tag).toBe("ProjectNameTakenError");
        const unrelated = yield* projects
          .publishInitialized({ ...input("other", "named"), id: named.id })
          .pipe(Effect.result);
        expect(Result.isFailure(unrelated) && unrelated.failure._tag).toBe(
          "ProjectPublicationUnconfirmed",
        );
        expect(yield* projects.byId(named.id)).toEqual(named);
      }),
    );
  });

  it("arbitrates simultaneous scratch publications on the person's key across independent connections", async () => {
    const attempts = [input("scratch-race-a", "scratch"), input("scratch-race-b", "scratch")];
    const results = await Promise.all(
      attempts.map((attempt) =>
        run(
          Effect.gen(function* () {
            return yield* (yield* ProjectsRepo).publishInitialized(attempt).pipe(Effect.result);
          }),
        ),
      ),
    );
    expect(results.filter(Result.isSuccess)).toHaveLength(1);
    expect(results.filter(Result.isFailure).map((r) => r.failure._tag)).toEqual([
      "ScratchProjectExistsError",
    ]);
    await run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const winner = yield* projects.byScratchOwner("anna");
        expect(winner?.scratchOwnerUserId).toBe("anna");
        expect(
          (yield* projects.listForOrganization(organizationId)).filter(
            (p) => p.scratchOwnerUserId === "anna",
          ),
        ).toHaveLength(1);
        const other = yield* projects.publishInitialized(input("scratch-bea", "scratch", "bea"));
        expect(other.id).not.toBe(winner?.id);
      }),
    );
  });

  it("enforces private creator ownership in SQL and refuses sharing through the repository", async () => {
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectsRepo;
        const scratch = yield* projects.publishInitialized(
          input("scratch-policy", "scratch", "policy"),
        );
        const shared = yield* projects.setVisibility(scratch.id, "shared").pipe(Effect.result);
        expect(Result.isFailure(shared) && shared.failure._tag).toBe("ScratchProjectPrivate");
        expect((yield* projects.setVisibility(scratch.id, "private")).visibility).toBe("private");
        for (const update of [
          sql`UPDATE projects SET visibility = 'shared' WHERE id = ${scratch.id}`,
          sql`UPDATE projects SET created_by_user_id = 'bea' WHERE id = ${scratch.id}`,
          sql`UPDATE projects SET created_by_user_id = NULL WHERE id = ${scratch.id}`,
        ])
          expect(Result.isFailure(yield* update.pipe(Effect.result))).toBe(true);
        const duplicate =
          yield* sql`INSERT INTO projects (id, organization_id, created_by_user_id, scratch_owner_user_id, name, store_path, default_branch) VALUES ('duplicate-owner', ${organizationId}, 'policy', 'policy', 'duplicate-owner', '/store/duplicate-owner/repo.git', 'main')`.pipe(
            Effect.result,
          );
        expect(Result.isFailure(duplicate) && uniqueViolationConstraint(duplicate.failure)).toBe(
          "projects_scratch_owner_key",
        );
        const recovered = yield* projects.setCreatedBy(scratch.id, "bea");
        expect(recovered).toMatchObject({
          createdByUserId: "bea",
          scratchOwnerUserId: null,
          visibility: "private",
        });
        expect(yield* projects.byScratchOwner("policy")).toBeNull();
      }),
    );
  });

  it("refuses publication after membership is removed and leaves no registered project", async () => {
    const attempt = input("departed", "named", "former");
    await run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const result = yield* projects.publishInitialized(attempt).pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure._tag).toBe("ProjectMembershipChanged");
        expect(yield* projects.byName(organizationId, attempt.name)).toBeNull();
      }),
    );
  });
});
