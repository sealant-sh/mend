import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId } from "@mend/domain";
import { Effect, Exit, Layer, Redacted, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ProjectsRepo, ProjectsRepoLive } from "../src/repos/projects.ts";
import {
  RemovalFencesRepo,
  RemovalFencesRepoLive,
  isRemovedProject,
} from "../src/repos/removal-fences.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const database = `mend_project_retention_${process.pid}_${Date.now()}`;
const url = new URL(postgres.adminUrl);
url.pathname = `/${database}`;
const admin = PgClient.layer({ url: Redacted.make(postgres.adminUrl) });
const pool = PgClient.layer({
  url: Redacted.make(url.toString()),
  transformResultNames: Str.snakeToCamel,
  transformQueryNames: Str.camelToSnake,
});
const repos = Layer.merge(ProjectsRepoLive, RemovalFencesRepoLive).pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pool))),
);
const run = <A, E>(
  effect: Effect.Effect<A, E, ProjectsRepo | RemovalFencesRepo | SqlClient.SqlClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(repos), Effect.scoped));
const manage = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(admin), Effect.scoped));
const org = OrganizationId.make("retention-org");
const seed = (name: string, scratch = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ProjectId.make(name);
    yield* sql`INSERT INTO projects (id, name, organization_id, created_by_user_id, visibility, store_path, default_branch, scratch_owner_user_id)
    VALUES (${id}, ${name}, ${org}, 'anna', 'private', ${`/store/${id}/repo.git`}, 'main', ${scratch ? "anna" : null})`;
    return id;
  });
const keep = (id: ProjectId) =>
  Effect.gen(function* () {
    const fences = yield* RemovalFencesRepo;
    const mark = yield* fences.take({ kind: "project", id });
    if (mark._tag !== "held") return yield* Effect.die("expected removal mark");
    expect(yield* fences.keep(id, mark.id, "anna")).toBe(true);
  });

describe.skipIf(postgres.skip)("project retention on a populated database (0167)", () => {
  let created = false;
  beforeAll(async () => {
    await manage(
      Effect.gen(function* () {
        yield* (yield* SqlClient.SqlClient).unsafe(`CREATE DATABASE ${database}`);
        created = true;
      }),
    );
    await run(
      Effect.gen(function* () {
        for (const [name, migration] of Object.entries(migrations).toSorted(([a], [b]) =>
          a.localeCompare(b),
        )) {
          if (name === "0167_project_retention") break;
          yield* migration;
        }
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES ('anna', 'Anna', 'anna@example.invalid', now())`;
        yield* sql`INSERT INTO organizations (id, name) VALUES (${org}, 'Retention')`;
        yield* sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${org}, 'anna', 'owner')`;
        yield* seed("legacy");
        yield* sql`UPDATE projects SET removal_phase = 'deleting', removal_id = 'old', removal_since = now() WHERE id = 'legacy'`;
        yield* migrations["0167_project_retention"];
      }),
    );
  }, 60_000);
  afterAll(async () => {
    if (created)
      await manage(
        Effect.gen(function* () {
          yield* (yield* SqlClient.SqlClient).unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
        }),
      );
  });

  it("hides a pre-upgrade deletion and refuses unproved Restore without restarting deletion", async () =>
    run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const fences = yield* RemovalFencesRepo;
        expect(yield* projects.listAll()).toEqual([]);
        expect((yield* projects.removedById(ProjectId.make("legacy")))?.state).toBe(
          "recovery-required",
        );
        expect(yield* projects.storeClaimed("/store/legacy/repo.git")).toBe(true);
        expect(yield* fences.restore(ProjectId.make("legacy"), "anna")).toBe("legacy");
        expect((yield* fences.takePurge(ProjectId.make("legacy")))._tag).toBe("finish");
      }),
    ));

  it("keeps rows and settings, frees listed names, and fences new work with Restore's SQLSTATE", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectsRepo;
        const fences = yield* RemovalFencesRepo;
        const id = yield* seed("retained");
        yield* sql`UPDATE projects SET install_command = 'echo kept' WHERE id = ${id}`;
        const before = yield* projects.byId(id);
        yield* keep(id);
        expect(yield* projects.byName(org, "retained")).toBeNull();
        expect(Exit.isFailure(yield* Effect.exit(projects.byId(id)))).toBe(true);
        expect(yield* projects.storeClaimed(before.storePath)).toBe(true);
        const start = yield* Effect.exit(
          sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES ('refused', ${id}, 'refused', 'refused', 'refused', 'abc')`,
        );
        expect(Exit.isFailure(start) && isRemovedProject(start.cause)).toBe(true);
        yield* sql`INSERT INTO projects (id, name, organization_id, store_path, default_branch) VALUES ('replacement', 'retained', ${org}, '/other/repo.git', 'main')`;
        expect((yield* Effect.flip(fences.restore(id, "anna")))._tag).toBe("ProjectNameTakenError");
        expect(yield* fences.restore(id, "anna", "restored")).toBe("restored");
        expect(yield* projects.byId(id)).toEqual({
          ...before,
          name: "restored",
          updatedAt: expect.any(Date),
        });
        expect(yield* fences.restore(id, "anna")).toBe("listed");
      }),
    ));

  it("frees the scratch slot and restores a former scratch as a plain private project", async () =>
    run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const old = yield* seed("old-scratch", true);
        yield* keep(old);
        expect(yield* projects.byScratchOwner("anna")).toBeNull();
        const replacement = yield* seed("new-scratch", true);
        yield* (yield* RemovalFencesRepo).restore(old, "anna");
        expect((yield* projects.byId(old)).scratchOwnerUserId).toBeNull();
        expect((yield* projects.byScratchOwner("anna"))?.id).toBe(replacement);
      }),
    ));

  it("purges exclusive context by inverse reference and preserves a shared snapshot", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectsRepo;
        const id = yield* seed("purged");
        const other = yield* seed("kept");
        for (const p of [id, other])
          yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES (${`w-${p}`}, ${p}, 'work', 'work', 'work', 'abc')`;
        yield* sql`INSERT INTO context_snapshots (id, items) VALUES ('exclusive', '[]'), ('shared', '[]'), ('unrelated', '[]')`;
        for (const [sid, pid, snapshot] of [
          ["own", id, "exclusive"],
          ["own-shared", id, "shared"],
          ["other", other, "shared"],
        ]) {
          yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id, context_snapshot_id)
        VALUES (${sid}, ${pid}, ${`w-${pid}`}, 'claude', 'work', 'work', 'abc', 'anna', ${snapshot})`;
        }
        yield* keep(id);
        yield* (yield* RemovalFencesRepo).takePurge(id);
        yield* projects.remove(id);
        expect(yield* projects.removedById(id)).toBeNull();
        expect(yield* sql`SELECT id FROM agent_sessions WHERE project_id = ${id}`).toEqual([]);
        expect(yield* sql`SELECT id FROM context_snapshots ORDER BY id`).toEqual([
          { id: "shared" },
          { id: "unrelated" },
        ]);
      }),
    ));
});
