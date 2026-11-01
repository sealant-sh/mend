import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId, SealantWorkspaceId, SessionId, WorktreeId } from "@mend/domain";
import { Cause, Effect, Exit, Layer, Redacted, String as Str } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { AuditEventsRepo, AuditEventsRepoLive } from "../src/repos/audit-events.ts";
import { CaptureStoreRepo, CaptureStoreRepoLive } from "../src/repos/capture-store.ts";
import { HarnessLayoutsRepo, HarnessLayoutsRepoLive } from "../src/repos/harness-layouts.ts";
import { HotWorkspacesRepo, HotWorkspacesRepoLive } from "../src/repos/hot-workspaces.ts";
import { ProjectLinksRepo, ProjectLinksRepoLive } from "../src/repos/project-links.ts";
import {
  ProjectServiceRecipesRepo,
  ProjectServiceRecipesRepoLive,
} from "../src/repos/project-service-recipes.ts";
import { ProjectsRepo, ProjectsRepoLive } from "../src/repos/projects.ts";
import {
  RemovalFencesRepo,
  RemovalFencesRepoLive,
  isRemovedProject,
} from "../src/repos/removal-fences.ts";
import { ScreensRepo, ScreensRepoLive } from "../src/repos/screens.ts";
import { ServicesRepo, ServicesRepoLive } from "../src/repos/services.ts";
import { SessionProcessesRepo, SessionProcessesRepoLive } from "../src/repos/session-processes.ts";
import { SessionRunsRepo, SessionRunsRepoLive } from "../src/repos/session-runs.ts";
import {
  UpgradeTicketsRepo,
  UpgradeTicketsRepoLive,
  upgradeTicketScope,
} from "../src/repos/upgrade-tickets.ts";
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
const repos = Layer.mergeAll(
  AuditEventsRepoLive,
  ProjectsRepoLive,
  RemovalFencesRepoLive,
  CaptureStoreRepoLive,
  ProjectServiceRecipesRepoLive,
  UpgradeTicketsRepoLive,
  HotWorkspacesRepoLive,
  SessionsRepoLive,
  HarnessLayoutsRepoLive,
  ScreensRepoLive,
  ServicesRepoLive,
  SessionProcessesRepoLive,
  SessionRunsRepoLive,
  ProjectLinksRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(pool))));
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | AuditEventsRepo
    | ProjectsRepo
    | RemovalFencesRepo
    | CaptureStoreRepo
    | ProjectServiceRecipesRepo
    | UpgradeTicketsRepo
    | HotWorkspacesRepo
    | SessionsRepo
    | HarnessLayoutsRepo
    | ScreensRepo
    | ServicesRepo
    | SessionProcessesRepo
    | SessionRunsRepo
    | ProjectLinksRepo
    | SqlClient.SqlClient
  >,
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
    expect(yield* fences.keep(id, mark.id, "anna")).toBe("kept");
  });

/** Takes the mark and keeps the project as `by`, answering what keep answered. */
const removeAs = (id: ProjectId, by: string) =>
  Effect.gen(function* () {
    const fences = yield* RemovalFencesRepo;
    const mark = yield* fences.take({ kind: "project", id });
    if (mark._tag !== "held") return yield* Effect.die("expected removal mark");
    return yield* fences.keep(id, mark.id, by);
  });
/** Takes the purge as `by`, confirming the removal as the purge request read it. */
const takePurgeAs = (id: ProjectId, by: string) =>
  Effect.gen(function* () {
    const kept = yield* (yield* ProjectsRepo).removedById(id);
    if (kept === null) return yield* Effect.die("expected a removed project");
    return yield* (yield* RemovalFencesRepo).takePurge(id, by, {
      name: kept.project.name,
      removedAt: kept.removedAt,
    });
  });
/** Whether `effect` was refused as a write into a removed project. */
const refusedLate = (effect: Effect.Effect<unknown, unknown>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => Exit.isFailure(exit) && isRemovedProject(Cause.squash(exit.cause))),
  );
/** The sweep test's sessions among what a sweep read. */
const sessionsOf = (rows: ReadonlyArray<{ readonly sessionId: string }>) =>
  rows.map((row) => row.sessionId).filter((id) => id.startsWith("s-sweep-"));
const member = (user: string, role: "owner" | "member") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO "user" (id, name, email, "createdAt") VALUES (${user}, ${user}, ${`${user}@example.invalid`}, now()) ON CONFLICT DO NOTHING`;
    yield* sql`INSERT INTO organization_members (organization_id, user_id, role) VALUES (${org}, ${user}, ${role})
      ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`;
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
        yield* sql`ALTER TABLE projects ADD COLUMN new_worktrees_use_project_resources boolean NOT NULL DEFAULT true`;
        yield* sql`ALTER TABLE worktrees ADD COLUMN uses_project_resources boolean NOT NULL DEFAULT true`;
        yield* migrations["0184_session_purpose"];
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
        expect((yield* takePurgeAs(ProjectId.make("legacy"), "anna"))._tag).toBe("finish");
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

  it("keeps a link to a removed project holding its name, listed as such, and deletable", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const links = yield* ProjectLinksRepo;
        const holder = yield* seed("link-holder");
        const target = yield* seed("link-target");
        const link = yield* links.create({
          projectId: holder,
          linkedProjectId: target,
          name: "lib",
          worktreeName: "main",
        });
        yield* keep(target);
        const before = {
          listed: yield* links.listForProject(holder),
          all: (yield* links.listAllForProject(holder)).map((row) => [
            row.link.name,
            row.targetListed,
          ]),
          byId: (yield* links.byId(link.id)).name,
        };
        yield* links.remove(link.id);
        expect({
          ...before,
          after: yield* sql`SELECT id FROM project_links WHERE project_id = ${holder}`,
        }).toEqual({ listed: [], all: [["lib", false]], byId: "lib", after: [] });
      }),
    ));

  it("lets an owner take over a departed member's removed project, which then is theirs to Restore", async () =>
    run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const id = yield* seed("departed-removed");
        yield* keep(id);
        yield* member("owen", "owner");
        const taken = yield* projects.setCreatedBy(id, "owen");
        expect({
          creator: taken.createdByUserId,
          kept: (yield* projects.removedById(id))?.project.createdByUserId,
          restored: yield* (yield* RemovalFencesRepo).restore(id, "owen"),
        }).toEqual({ creator: "owen", kept: "owen", restored: "restored" });
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
        const fences = yield* RemovalFencesRepo;
        const purge = yield* takePurgeAs(id, "anna");
        if (purge._tag !== "finish") return yield* Effect.die("expected purge mark");
        expect(yield* fences.finishPurge(id, purge.id, "anna")).toBe(true);
        expect(yield* projects.removedById(id)).toBeNull();
        expect(yield* sql`SELECT id FROM agent_sessions WHERE project_id = ${id}`).toEqual([]);
        expect(yield* sql`SELECT id FROM context_snapshots ORDER BY id`).toEqual([
          { id: "shared" },
          { id: "unrelated" },
        ]);
      }),
    ));

  it("keeps registering captures in a project that inherited objects from one since removed", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const capture = yield* CaptureStoreRepo;
        const owner = yield* seed("shared-owner");
        const consumer = yield* seed("consumer");
        const [ownerTree, consumerTree] = [
          WorktreeId.make("w-owner"),
          WorktreeId.make("w-consumer"),
        ];
        for (const [tree, project] of [
          [ownerTree, owner],
          [consumerTree, consumer],
        ] as const) {
          yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES (${tree}, ${project}, ${tree}, ${tree}, ${tree}, ${"a".repeat(40)})`;
          yield* capture.init(tree);
        }
        const inherited = `captures/${ownerTree}/1/packs/${"c".repeat(64)}`;
        const base = `projects/${owner}/packs/${"d".repeat(64)}`;
        const { epoch } = yield* capture.claim(consumerTree, "exec", 3600);
        const register = (n: number, parent: string | null) =>
          Effect.gen(function* () {
            const state = yield* capture.referenceState([ownerTree, consumerTree], [inherited]);
            const id = `cap-consumer-${n}`;
            yield* capture.register({
              worktreeId: consumerTree,
              id,
              n,
              parent,
              epoch,
              seq: BigInt(n),
              kind: n === 0 ? "checkpoint" : "auto",
              manifestKey: `captures/${consumerTree}/${epoch}/manifests/${id}`,
              sections: { git: { packs: [inherited, base] } },
              gitFsck: "verified",
              guards: [ownerTree, consumerTree].map((worktreeId) => ({
                worktreeId,
                guard: state.guards.get(worktreeId) ?? -1,
              })),
              names: [inherited, base],
            });
            return id;
          });
        const first = yield* register(0, null);
        yield* keep(owner);
        const next = yield* Effect.exit(register(1, first));
        expect(Exit.isFailure(next) ? Cause.pretty(next.cause) : "registered").toBe("registered");
        const ownWrite = yield* Effect.exit(
          sql`INSERT INTO captures (id, worktree_id, n, parent, epoch, seq, kind, manifest_key, sections, git_fsck)
            VALUES ('cap-owner', ${ownerTree}, 0, NULL, 0, 0, 'checkpoint', 'm', '{}'::jsonb, 'verified')`,
        );
        expect(Exit.isFailure(ownWrite) && isRemovedProject(Cause.squash(ownWrite.cause))).toBe(
          true,
        );
        expect(
          yield* sql`SELECT n FROM captures WHERE worktree_id = ${consumerTree} ORDER BY n`,
        ).toEqual([{ n: 0 }, { n: 1 }]);
        // What a purge of the owner keeps: what the consumer names, and nothing else of the owner's.
        const unnamed = `captures/${ownerTree}/1/packs/${"e".repeat(64)}`;
        const kept = yield* capture.referencedElsewhere({
          projectId: owner,
          own: [ownerTree],
          keys: [inherited, `${inherited}.idx`, base, unnamed, `${unnamed}.idx`],
        });
        expect([...kept].toSorted()).toEqual([inherited, `${inherited}.idx`, base].toSorted());
      }),
    ));

  it("refuses a project setting written after the project was removed", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const recipes = yield* ProjectServiceRecipesRepo;
        const id = yield* seed("recipes");
        // A request that read the project listed, then wrote after the removal committed.
        yield* keep(id);
        const late = yield* Effect.exit(
          recipes.create({
            projectId: id,
            name: "web",
            command: "pnpm dev",
            port: 3000,
            protocol: "tcp",
            browserScheme: "http",
          }),
        );
        expect(Exit.isFailure(late) && isRemovedProject(Cause.squash(late.cause))).toBe(true);
        expect(
          yield* sql`SELECT name FROM project_service_recipes WHERE project_id = ${id}`,
        ).toEqual([]);
      }),
    ));

  it("keeps a removed project's sessions, names, recipes and review comments from a late delete", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* SessionsRepo;
        const recipes = yield* ProjectServiceRecipesRepo;
        const id = yield* seed("late-delete");
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES ('w-late', ${id}, 'work', 'work', 'work', 'abc')`;
        yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id, label)
          VALUES ('s-late', ${id}, 'w-late', 'claude', 'work', 'work', 'abc', 'anna', 'kept name')`;
        yield* sql`INSERT INTO worktree_changes (id, project_id, worktree_id, session_id, branch, base_sha)
          VALUES ('c-late', ${id}, 'w-late', 's-late', 'work', 'abc')`;
        yield* sql`INSERT INTO review_comments (id, change_id, author_kind, author_name, body)
          VALUES ('rc-late', 'c-late', 'human', 'Anna', 'kept words')`;
        yield* recipes.create({
          projectId: id,
          name: "web",
          command: "pnpm dev",
          port: 3000,
          protocol: "tcp",
          browserScheme: "http",
        });
        // Each request read the project listed, then acted after the removal committed.
        yield* keep(id);
        expect(yield* refusedLate(sessions.remove(SessionId.make("s-late")))).toBe(true);
        expect(yield* refusedLate(recipes.remove(id, "web"))).toBe(true);
        expect(
          yield* refusedLate(sql`UPDATE agent_sessions SET label = 'renamed' WHERE id = 's-late'`),
        ).toBe(true);
        expect(yield* refusedLate(sql`DELETE FROM review_comments WHERE id = 'rc-late'`)).toBe(
          true,
        );
        expect(
          yield* refusedLate(sql`UPDATE review_comments SET body = 'changed' WHERE id = 'rc-late'`),
        ).toBe(true);
        expect(yield* sql`SELECT label FROM agent_sessions WHERE id = 's-late'`).toEqual([
          { label: "kept name" },
        ]);
        expect(yield* sql`SELECT body FROM review_comments WHERE id = 'rc-late'`).toEqual([
          { body: "kept words" },
        ]);
        expect(
          yield* sql`SELECT name FROM project_service_recipes WHERE project_id = ${id}`,
        ).toEqual([{ name: "web" }]);
        const fences = yield* RemovalFencesRepo;
        const purge = yield* takePurgeAs(id, "anna");
        if (purge._tag !== "finish") return yield* Effect.die("expected purge mark");
        expect(yield* fences.finishPurge(id, purge.id, "anna")).toBe(true);
        expect(yield* sql`SELECT id FROM review_comments WHERE id = 'rc-late'`).toEqual([]);
      }),
    ));

  it("fences every table that holds a project's content, or names why it need not", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Written only by a session's work or by a removal itself; their own fences refuse it.
        // A session's name and deletion are fenced by the same function (asserted below).
        const fencedElsewhere = new Set([
          "agent_sessions",
          "worktrees",
          "hot_workspaces",
          "session_repositories",
          "project_links",
          "change_landings",
          "session_git_ops",
          "session_changes",
          "worktree_changes",
          "store_refs",
        ]);
        // tgtype bits: 4 INSERT, 8 DELETE, 16 UPDATE. A fence that misses one lets it through.
        const rows = yield* sql<{ readonly table: string; readonly fenced: boolean }>`
          SELECT c.table_name AS table,
                 EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
                          WHERE t.tgrelid = (quote_ident(c.table_name))::regclass
                            AND f.proname = 'project_retention_admit_content'
                            AND t.tgtype & 28 = 28) AS fenced
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_name = c.table_name AND t.table_schema = c.table_schema
           WHERE c.table_schema = current_schema() AND c.column_name = 'project_id'
             AND t.table_type = 'BASE TABLE'
           ORDER BY c.table_name`;
        expect(
          rows
            .filter((row) => !row.fenced && !fencedElsewhere.has(row.table))
            .map((row) => row.table),
        ).toEqual([]);
        const deletes = yield* sql<{ readonly table: string }>`
          SELECT t.tgrelid::regclass::text AS table FROM pg_trigger t JOIN pg_proc f ON f.oid = t.tgfoid
           WHERE f.proname = 'project_retention_admit_content' AND t.tgtype & 8 = 8
             AND t.tgrelid IN ('agent_sessions'::regclass, 'review_comments'::regclass)
           ORDER BY 1`;
        expect(deletes.map((row) => row.table)).toEqual(["agent_sessions", "review_comments"]);
      }),
    ));

  it("revokes every ticket that opens a terminal, Service or preview of the project's sessions", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tickets = yield* UpgradeTicketsRepo;
        const id = yield* seed("tickets");
        const other = yield* seed("tickets-other");
        for (const project of [id, other]) {
          yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES (${`w-${project}`}, ${project}, 'work', 'work', 'work', 'abc')`;
          yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id)
            VALUES (${`s-${project}`}, ${project}, ${`w-${project}`}, 'claude', 'work', 'work', 'abc', 'anna')`;
        }
        yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind, exited_at)
          VALUES ('p-tickets', ${`s-${id}`}, 'ws', 'shell', now())`;
        yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port)
          VALUES ('svc-tickets', ${`s-${id}`}, 'web', 'explicit-run', 3000)`;
        const minted = yield* Effect.forEach(
          [
            ["tty-renew", upgradeTicketScope({ session: `s-${id}` })],
            ["tty-embed", upgradeTicketScope({ process: "p-tickets" })],
            ["service-tunnel", upgradeTicketScope({ service: "svc-tickets" })],
            ["tty-renew", upgradeTicketScope({ session: `s-${other}` })],
          ] as const,
          ([target, scope]) =>
            Effect.map(
              tickets.mint({ userId: "anna", credential: null, target, scope }),
              ({ ticket }) => ({ ticket, target, scope }),
            ),
        );
        yield* keep(id);
        const open = yield* Effect.forEach(minted, (ticket) =>
          Effect.map(tickets.consume({ ...ticket, keep: true }), (spent) => spent !== null),
        );
        expect(open).toEqual([false, false, false, true]);
        // An exchange that read the project listed before the removal mints after it: refused.
        const late = yield* Effect.forEach(minted, ({ target, scope }) =>
          Effect.exit(tickets.mint({ userId: "anna", credential: null, target, scope })).pipe(
            Effect.map((exit) =>
              Exit.isFailure(exit) ? isRemovedProject(Cause.squash(exit.cause)) : "minted",
            ),
          ),
        );
        expect(late).toEqual([true, true, true, "minted"]);
      }),
    ));

  it(
    "removes a project with more sessions than a statement takes parameters",
    async () =>
      run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const id = yield* seed("long-history");
          yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES ('w-long', ${id}, 'work', 'work', 'work', 'abc')`;
          // One more session than a statement takes parameters (65,535). The per-row session
          // triggers only cost time here, so the seed pauses them inside its own transaction.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`ALTER TABLE agent_sessions DISABLE TRIGGER USER`;
              yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id, status)
              SELECT 's-long-' || n, ${id}, 'w-long', 'claude', 'work', 'work', 'abc', 'anna', 'stopped'
              FROM generate_series(1, 65536) n`;
              yield* sql`ALTER TABLE agent_sessions ENABLE TRIGGER USER`;
            }),
          );
          expect(
            yield* sql`SELECT count(*)::int AS n FROM agent_sessions WHERE project_id = ${id}`,
          ).toEqual([{ n: 65536 }]);
          expect(yield* removeAs(id, "anna")).toBe("kept");
        }),
      ),
    30_000,
  );

  it("answers Restore, purge and removal by what the person may do when they commit", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        yield* member("olga", "owner");
        const shared = yield* seed("authority-shared");
        yield* sql`UPDATE projects SET visibility = 'shared', created_by_user_id = 'anna' WHERE id = ${shared}`;
        expect(yield* removeAs(shared, "olga")).toBe("kept");
        // Authorized as an owner, demoted before the change commits.
        yield* member("olga", "member");
        const restored = yield* fences.restore(shared, "olga");
        const purge = yield* takePurgeAs(shared, "olga");
        const other = yield* seed("authority-listed");
        yield* sql`UPDATE projects SET visibility = 'shared' WHERE id = ${other}`;
        const removed = yield* removeAs(other, "olga");
        yield* member("pia", "member");
        const own = ProjectId.make("authority-private");
        yield* sql`INSERT INTO projects (id, name, organization_id, created_by_user_id, visibility, store_path, default_branch)
          VALUES (${own}, ${own}, ${org}, 'pia', 'private', ${`/store/${own}/repo.git`}, 'main')`;
        expect(yield* removeAs(own, "pia")).toBe("kept");
        yield* sql`DELETE FROM organization_members WHERE user_id = 'pia'`;
        expect({
          restored,
          purge: purge._tag,
          removed,
          formerMember: yield* fences.restore(own, "pia"),
          state: yield* sql`SELECT id, removal_phase AS phase FROM projects
            WHERE id IN (${shared}, ${other}, ${own}) ORDER BY id`,
        }).toEqual({
          restored: "forbidden",
          purge: "forbidden",
          removed: "forbidden",
          formerMember: "forbidden",
          state: [
            { id: other, phase: "checking" },
            { id: own, phase: "removed" },
            { id: shared, phase: "removed" },
          ],
        });
      }),
    ));

  it("commits each lifecycle change with its audit entry, and a purge deletes the row only under its own mark", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const id = yield* seed("audited");
        const actions = sql<{
          readonly action: string;
          readonly data: unknown;
        }>`SELECT action, data FROM audit_events
          WHERE subject_id = ${id} ORDER BY created_at, action`;
        const named = { name: "audited", visibility: "private" };
        yield* removeAs(id, "anna");
        const afterRemove = yield* actions;
        yield* fences.restore(id, "anna");
        const afterRestore = yield* actions;
        yield* removeAs(id, "anna");
        const first = yield* takePurgeAs(id, "anna");
        if (first._tag !== "finish") return yield* Effect.die("expected purge mark");
        yield* sql`UPDATE projects SET removal_since = now() - interval '10 minutes' WHERE id = ${id}`;
        const second = yield* takePurgeAs(id, "anna");
        if (second._tag !== "finish") return yield* Effect.die("expected purge takeover");
        const stale = yield* fences.finishPurge(id, first.id, "anna");
        const rowAfterStale = (yield* sql`SELECT id FROM projects WHERE id = ${id}`).length;
        const finished = yield* fences.finishPurge(id, second.id, "anna");
        const audit = yield* AuditEventsRepo;
        const latestPurge = (organizationId: OrganizationId) =>
          audit
            .latest({ organizationId, action: "project.purged", subjectId: id })
            .pipe(
              Effect.map((event) =>
                event === null ? null : { actor: event.actorUserId, data: event.data },
              ),
            );
        expect({
          purgedHere: yield* latestPurge(org),
          purgedElsewhere: yield* latestPurge(OrganizationId.make("org-elsewhere")),
        }).toEqual({ purgedHere: { actor: "anna", data: named }, purgedElsewhere: null });
        expect({
          afterRemove,
          afterRestore,
          stale,
          rowAfterStale,
          finished,
          rowAfter: (yield* sql`SELECT id FROM projects WHERE id = ${id}`).length,
          actions: yield* actions,
        }).toEqual({
          afterRemove: [{ action: "project.removed", data: named }],
          afterRestore: [
            { action: "project.removed", data: named },
            { action: "project.restored", data: named },
          ],
          stale: false,
          rowAfterStale: 1,
          finished: true,
          rowAfter: 0,
          // Each purge that took the mark said so before it deleted anything.
          actions: [
            { action: "project.removed", data: named },
            { action: "project.restored", data: named },
            { action: "project.removed", data: named },
            { action: "project.purge_started", data: named },
            { action: "project.purge_started", data: named },
            { action: "project.purged", data: named },
          ],
        });
      }),
    ));

  it("keeps a project whose purge began on its way out: only another purge takes its mark", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const fences = yield* RemovalFencesRepo;
        const id = yield* seed("purge-begun");
        yield* keep(id);
        const first = yield* takePurgeAs(id, "anna");
        if (first._tag !== "finish") return yield* Effect.die("expected purge mark");
        // Its holder stops renewing: the mark lapses, and the project is still being purged.
        yield* sql`UPDATE projects SET removal_since = now() - interval '10 minutes' WHERE id = ${id}`;
        yield* fences.release({ kind: "project", id }, first.id);
        expect({
          restore: yield* fences.restore(id, "anna"),
          removal: (yield* fences.take({ kind: "project", id }))._tag,
          phase: yield* sql`SELECT removal_phase FROM projects WHERE id = ${id}`,
          next: (yield* takePurgeAs(id, "anna"))._tag,
        }).toEqual({
          restore: "purging",
          removal: "gone",
          phase: [{ removalPhase: "deleting" }],
          next: "finish",
        });
      }),
    ));

  it("purges only the removal the person confirmed, not one made since under another name", async () =>
    run(
      Effect.gen(function* () {
        const projects = yield* ProjectsRepo;
        const fences = yield* RemovalFencesRepo;
        const id = yield* seed("confirmed-api");
        yield* keep(id);
        const confirmedThen = yield* projects.removedById(id);
        if (confirmedThen === null) return yield* Effect.die("expected a removed project");
        // Between the purge request's read and its mark: restored as another name, removed again.
        expect(yield* fences.restore(id, "anna", "confirmed-renamed")).toBe("restored");
        yield* (yield* SqlClient.SqlClient)`SELECT pg_sleep(0.005)`;
        yield* keep(id);
        const stale = yield* fences.takePurge(id, "anna", {
          name: confirmedThen.project.name,
          removedAt: confirmedThen.removedAt,
        });
        const sameNameLater = yield* fences.takePurge(id, "anna", {
          name: "confirmed-renamed",
          removedAt: confirmedThen.removedAt,
        });
        expect({
          stale: stale._tag,
          sameNameLater: sameNameLater._tag,
          state: (yield* projects.removedById(id))?.state,
          current: (yield* takePurgeAs(id, "anna"))._tag,
        }).toEqual({
          stale: "changed",
          sameNameLater: "changed",
          state: "removed",
          current: "finish",
        });
      }),
    ));

  it("issues no upload URL once removed, and lets only the purge's own mark condemn its objects", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const capture = yield* CaptureStoreRepo;
        const id = yield* seed("condemned");
        const tree = WorktreeId.make("w-condemned");
        yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha) VALUES (${tree}, ${id}, ${tree}, ${tree}, ${tree}, ${"a".repeat(40)})`;
        yield* capture.init(tree);
        const boundUntil = new Date(Date.now() + 300_000);
        const boundBefore = yield* capture.recordUploadWindow(tree, boundUntil);
        yield* keep(id);
        const authority = yield* capture.recordPutAuthority(
          tree,
          1,
          new Date(Date.now() + 600_000),
        );
        const boundAfter = yield* capture.recordUploadWindow(tree, new Date(Date.now() + 600_000));
        const purge = yield* takePurgeAs(id, "anna");
        if (purge._tag !== "finish") return yield* Effect.die("expected purge mark");
        const guardOf = Effect.map(
          capture.listChains(),
          (chains) => chains.find((chain) => chain.worktreeId === tree)?.guard ?? -1,
        );
        const key = `captures/${tree}/1/packs/${"e".repeat(64)}`;
        const claim = { token: "purge-test", ttlSeconds: 3600 };
        const byRetention = yield* capture.condemn(tree, yield* guardOf, [key], claim);
        const input = { worktreeId: tree, keys: [key], claim, projectId: id };
        const byStaleMark = yield* capture.condemnForPurge({
          ...input,
          guard: yield* guardOf,
          fenceId: "rmv_stale",
        });
        const byPurge = yield* capture.condemnForPurge({
          ...input,
          guard: yield* guardOf,
          fenceId: purge.id,
        });
        expect({
          boundBefore,
          boundAfter,
          authority: authority.recorded,
          until: yield* capture.putAuthorityUntilFor([tree]),
          byRetention,
          byStaleMark,
          byPurge,
          tombstoned: (yield* capture.referenceState([tree], [key])).tombstones.map((t) => t.key),
        }).toEqual({
          boundBefore: true,
          boundAfter: false,
          authority: false,
          until: boundUntil,
          byRetention: false,
          byStaleMark: false,
          byPurge: true,
          tombstoned: [key],
        });
      }),
    ));

  it("leaves a removed project's sessions, processes, Services, runs, screens and migrations out of every boot sweep", async () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const listed = yield* seed("sweep-listed");
        const removed = yield* seed("sweep-removed");
        for (const project of [listed, removed]) {
          yield* sql`INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha, harness_layout)
            VALUES (${`w-${project}`}, ${project}, 'work', 'work', 'work', 'abc', 'person')`;
          yield* sql`INSERT INTO agent_sessions (id, project_id, worktree_id, harness, worktree, branch, base_sha, owner_user_id, status)
            VALUES (${`s-${project}`}, ${project}, ${`w-${project}`}, 'claude', 'work', 'work', 'abc', 'anna', 'running')`;
          yield* sql`INSERT INTO session_processes (id, session_id, sealant_workspace_id, kind)
            VALUES (${`p-${project}`}, ${`s-${project}`}, ${`ws-${project}`}, 'shell')`;
          yield* sql`INSERT INTO services (id, session_id, name, declaration_source, workspace_port)
            VALUES (${`svc-${project}`}, ${`s-${project}`}, 'web', 'explicit-run', 3000)`;
          yield* sql`INSERT INTO session_runs (sealant_run_id, session_id, ordinal, harness, sealant_workspace_id, status)
            VALUES (${`run-${project}`}, ${`s-${project}`}, 1, 'claude', ${`ws-${project}`}, 'running')`;
          yield* (yield* ScreensRepo).reserve({
            sessionId: SessionId.make(`s-${project}`),
            workspaceId: SealantWorkspaceId.make(`ws-${project}`),
          });
        }
        yield* keep(removed);
        const sessions = yield* SessionsRepo;
        expect({
          active: (yield* sessions.listActive())
            .map((session) => session.id)
            .filter((id) => id.startsWith("s-sweep-")),
          unsettled: (yield* sessions.listUnsettled())
            .map((session) => session.id)
            .filter((id) => id.startsWith("s-sweep-")),
          processes: sessionsOf(yield* (yield* SessionProcessesRepo).listLive()),
          services: sessionsOf(yield* (yield* ServicesRepo).listAll()),
          runs: sessionsOf(yield* (yield* SessionRunsRepo).listActive()),
          screens: sessionsOf(yield* (yield* ScreensRepo).listHeld()),
          migrations: (yield* (yield* HarnessLayoutsRepo).worktreesAwaitingMigration()).filter(
            (id) => id.startsWith("w-sweep-"),
          ),
        }).toEqual({
          active: [`s-${listed}`],
          unsettled: [`s-${listed}`],
          processes: [`s-${listed}`],
          services: [`s-${listed}`],
          runs: [`s-${listed}`],
          screens: [`s-${listed}`],
          migrations: [`w-${listed}`],
        });
      }),
    ));

  it("keeps a removed project's standby in the pool's sweep until it is drained", async () =>
    run(
      Effect.gen(function* () {
        const standbys = yield* HotWorkspacesRepo;
        const id = yield* seed("standby");
        const standby = SessionId.make("hot-standby");
        yield* standbys.create({
          id: standby,
          projectId: id,
          worktreeId: null,
          ownerUserId: "anna",
          fingerprint: "f",
          harnessLayout: "shared",
          worktree: null,
          branch: null,
          baseSha: null,
        });
        yield* keep(id);
        expect((yield* standbys.listAll()).map((entry) => entry.id)).toContain(standby);
      }),
    ));
});
