import { PgClient } from "@effect/sql-pg";
import { TeamInviteId } from "@mend/domain";
import { canViewProject } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ProjectsRepo, ProjectsRepoLive } from "../src/repos/projects.ts";
import { TeamsRepo, TeamsRepoLive } from "../src/repos/teams.ts";

/**
 * Teams, seats, invites, and project scope (docs/adr/0002) against the dev Postgres
 * (`compose.dev.yaml`, :5434) in a throwaway database. Skips when nothing listens.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_teams_test_${process.pid}_${Date.now()}`;

const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));

const scratchDatabaseLayer = MendDBLive.pipe(Layer.provideMerge(scratchLayer));
const reposLayer = Layer.mergeAll(TeamsRepoLive, ProjectsRepoLive).pipe(
  Layer.provideMerge(scratchDatabaseLayer),
);

const withRepos = <A, E>(
  effect: Effect.Effect<A, E, TeamsRepo | ProjectsRepo | SqlClient.SqlClient | PgClient.PgClient>,
) => Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

const reachable = await withAdmin(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`SELECT 1`;
    return true;
  }).pipe(Effect.timeout("2 seconds")),
).then(
  () => true,
  () => false,
);

const ORDERED = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));

const project = (name: string) => ({
  name,
  originUrl: null,
  storePath: `/store/${name}/repo.git`,
  defaultBranch: "main",
  adoptedSha: null,
  gitAuthMode: "ambient" as const,
  teamId: null,
  ownerUserId: null,
});

describe.skipIf(!reachable)("teams", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await withRepos(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email")
          VALUES ('ann', 'Ann', 'ann@example.com'),
                 ('bob', 'Bob', 'Bob@Example.com'),
                 ('cid', 'Cid', 'cid@example.com')`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("the creator owns the team; names are unique; the last owner cannot step down", async () => {
    const result = await withRepos(
      Effect.gen(function* () {
        const teams = yield* TeamsRepo;
        const platform = yield* teams.create("Platform", "ann");
        const duplicate = yield* teams.create(" platform ", "bob").pipe(Effect.result);
        const duplicateExact = yield* teams.create("Platform", "bob").pipe(Effect.result);
        const listed = yield* teams.listForUser("ann");
        const demote = yield* teams.setRole(platform.id, "ann", "member").pipe(Effect.result);
        const leave = yield* teams.removeMember(platform.id, "ann").pipe(Effect.result);
        return { platform, duplicate, duplicateExact, listed, demote, leave };
      }),
    );
    expect(result.listed.map((entry) => [entry.team.name, entry.role, entry.memberCount])).toEqual([
      ["Platform", "owner", 1],
    ]);
    // Uniqueness is exact after trimming; a differently-cased name is a different team.
    expect(result.duplicate._tag).toBe("Success");
    expect(result.duplicateExact._tag).toBe("Failure");
    expect(result.demote._tag).toBe("Failure");
    expect(result.leave._tag).toBe("Failure");
  });

  it("seats: add by id, promote, then the former owner may leave; a stranger has no seat", async () => {
    const result = await withRepos(
      Effect.gen(function* () {
        const teams = yield* TeamsRepo;
        const design = yield* teams.create("Design", "ann");
        yield* teams.addMember(design.id, "bob", "member", "ann");
        const again = yield* teams.addMember(design.id, "bob", "member", "ann").pipe(Effect.result);
        yield* teams.setRole(design.id, "bob", "owner");
        yield* teams.removeMember(design.id, "ann");
        const stranger = yield* teams.removeMember(design.id, "cid").pipe(Effect.result);
        const members = yield* teams.members(design.id);
        const standing = yield* teams.standing("bob");
        return { design, again, stranger, members, standing };
      }),
    );
    expect(result.again._tag).toBe("Failure");
    expect(result.stranger._tag).toBe("Failure");
    expect(result.members.map((member) => [member.userId, member.role, member.email])).toEqual([
      ["bob", "owner", "Bob@Example.com"],
    ]);
    expect(result.standing.ownerOf.has(result.design.id)).toBe(true);
  });

  it("an invite is single-use, email-bound when asked, and never re-readable", async () => {
    const result = await withRepos(
      Effect.gen(function* () {
        const teams = yield* TeamsRepo;
        const sql = yield* SqlClient.SqlClient;
        const team = yield* teams.create("Invites", "ann");
        const open = yield* teams.createInvite({
          teamId: team.id,
          role: "member",
          email: null,
          createdBy: "ann",
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        const bound = yield* teams.createInvite({
          teamId: team.id,
          role: "owner",
          email: "Bob@Example.com",
          createdBy: "ann",
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        const stored = yield* sql<{ readonly token_hash: string; readonly email: string | null }>`
          SELECT token_hash, email FROM team_invites WHERE id = ${bound.invite.id}`;
        const wrongPerson = yield* teams
          .acceptInvite(bound.token, { id: "cid", email: "cid@example.com" })
          .pipe(Effect.result);
        const accepted = yield* teams.acceptInvite(open.token, {
          id: "cid",
          email: "cid@example.com",
        });
        const twice = yield* teams
          .acceptInvite(open.token, { id: "bob", email: "bob@example.com" })
          .pipe(Effect.result);
        const promoted = yield* teams.acceptInvite(bound.token, {
          id: "bob",
          email: "bob@example.com",
        });
        const unknown = yield* teams.inviteByToken("nope").pipe(Effect.result);
        const revoked = yield* teams.createInvite({
          teamId: team.id,
          role: "member",
          email: null,
          createdBy: "ann",
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        yield* teams.revokeInvite(team.id, revoked.invite.id);
        const afterRevoke = yield* teams.inviteByToken(revoked.token);
        const bogusRevoke = yield* teams
          .revokeInvite(team.id, TeamInviteId.make("missing"))
          .pipe(Effect.result);
        return {
          stored,
          wrongPerson,
          accepted,
          twice,
          promoted,
          unknown,
          afterRevoke,
          bogusRevoke,
          openToken: open.token,
        };
      }),
    );
    // Only the hash lands; the email is stored normalized.
    expect(result.stored[0]?.token_hash).not.toContain(result.openToken);
    expect(result.stored[0]?.email).toBe("bob@example.com");
    expect(result.wrongPerson._tag).toBe("Failure");
    expect(result.accepted.member.role).toBe("member");
    expect(result.twice._tag).toBe("Failure");
    expect(result.promoted.member.role).toBe("owner");
    expect(result.unknown._tag).toBe("Failure");
    expect(result.afterRevoke.state).toBe("revoked");
    expect(result.bogusRevoke._tag).toBe("Failure");
  });

  it("project scope: personal, team, instance — and a team with projects cannot be deleted", async () => {
    const result = await withRepos(
      Effect.gen(function* () {
        const teams = yield* TeamsRepo;
        const projects = yield* ProjectsRepo;
        const team = yield* teams.create("Scoped", "ann");
        yield* teams.addMember(team.id, "bob", "member", "ann");
        const shared = yield* projects.create({ ...project("shared"), teamId: team.id });
        const mine = yield* projects.create({ ...project("mine"), ownerUserId: "ann" });
        const everyone = yield* projects.create(project("everyone"));
        const forTeam = yield* projects.listForTeam(team.id);
        const blocked = yield* teams.remove(team.id).pipe(Effect.result);
        const standing = {
          ann: yield* teams.standing("ann"),
          bob: yield* teams.standing("bob"),
          cid: yield* teams.standing("cid"),
        };
        const moved = yield* projects.setScope(shared.id, { kind: "instance" });
        const removed = yield* teams.remove(team.id).pipe(Effect.result);
        return { shared, mine, everyone, forTeam, blocked, standing, moved, removed };
      }),
    );
    expect(result.forTeam.map((row) => row.name)).toEqual(["shared"]);
    expect(result.blocked._tag).toBe("Failure");
    const { ann, bob, cid } = result.standing;
    expect(canViewProject(result.shared, "bob", bob)).toBe(true);
    expect(canViewProject(result.shared, "cid", cid)).toBe(false);
    expect(canViewProject(result.mine, "ann", ann)).toBe(true);
    expect(canViewProject(result.mine, "bob", bob)).toBe(false);
    expect(canViewProject(result.everyone, "cid", cid)).toBe(true);
    expect(result.moved.teamId).toBeNull();
    expect(result.moved.ownerUserId).toBeNull();
    expect(result.removed._tag).toBe("Success");
  });
});
