import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId } from "@mend/domain";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { InstanceRolesRepo, InstanceRolesRepoLive } from "../src/repos/instance-roles.ts";
import { OrganizationsRepo, OrganizationsRepoLive } from "../src/repos/organizations.ts";
import { ProjectsRepo, ProjectsRepoLive } from "../src/repos/projects.ts";
import { PushDevicesRepo, PushDevicesRepoLive } from "../src/repos/push-devices.ts";

/**
 * Organizations against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database.
 * Without one reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_organizations_test_${process.pid}_${Date.now()}`;

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
const reposLayer = Layer.mergeAll(
  OrganizationsRepoLive,
  InstanceRolesRepoLive,
  ProjectsRepoLive,
  PushDevicesRepoLive,
).pipe(Layer.provideMerge(scratchDatabaseLayer));

type Services =
  | OrganizationsRepo
  | InstanceRolesRepo
  | ProjectsRepo
  | PushDevicesRepo
  | SqlClient.SqlClient
  | PgClient.PgClient;

const run = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  Effect.runPromise(effect.pipe(Effect.provide(reposLayer), Effect.scoped));

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
const inAWeek = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

describe.skipIf(!reachable)("organizations", () => {
  let acme = OrganizationId.make("");

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    acme = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
            ('carol', 'Carol', 'carol@example.com', '2026-01-02T00:00:00Z'),
            ('bob', 'Bob', 'bob@example.com', '2026-01-03T00:00:00Z'),
            ('dave', 'Dave', 'dave@example.com', '2026-01-04T00:00:00Z'),
            ('erin', 'Erin', 'erin@example.com', '2026-01-05T00:00:00Z')`;
        const organizations = yield* OrganizationsRepo;
        return (yield* organizations.sole()).id;
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

  it("bootstraps the first account once, even when two registrations race", async () => {
    const result = await run(
      Effect.gen(function* () {
        const organizations = yield* OrganizationsRepo;
        const roles = yield* InstanceRolesRepo;
        const outcomes = yield* Effect.all(
          [
            organizations.bootstrapFirstAccount("alice"),
            organizations.bootstrapFirstAccount("dave"),
          ],
          { concurrency: 2 },
        );
        const again = yield* organizations.bootstrapFirstAccount("alice");
        const operators = yield* roles.operators();
        const winner = operators[0] ?? "";
        const membership = yield* organizations.membershipOf(winner);
        return { outcomes, again, operators, role: membership?.role };
      }),
    );
    expect(result.outcomes.filter(Boolean)).toHaveLength(1);
    expect(result.again).toBe(false);
    expect(result.operators).toHaveLength(1);
    expect(result.role).toBe("owner");
  });

  it("an owner can hand over ownership but never leave the organization without one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const organizations = yield* OrganizationsRepo;
        // Reset to a known roster whatever the bootstrap race picked.
        yield* sql`DELETE FROM instance_roles`;
        yield* sql`DELETE FROM organization_members`;
        yield* organizations.addMember(acme, "alice", "owner", null);
        yield* organizations.addMember(acme, "carol", "member", "alice");
        const demoteLast = yield* organizations.setRole(acme, "alice", "member").pipe(Effect.flip);
        const removeLast = yield* organizations.removeMember(acme, "alice").pipe(Effect.flip);
        yield* organizations.setRole(acme, "carol", "owner");
        const concurrent = yield* Effect.all(
          [
            organizations.setRole(acme, "alice", "member").pipe(Effect.result),
            organizations.setRole(acme, "carol", "member").pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        const owners = (yield* organizations.members(acme)).filter(
          (member) => member.role === "owner",
        );
        const notMember = yield* organizations.setRole(acme, "bob", "owner").pipe(Effect.flip);
        return {
          demoteLast: demoteLast._tag,
          removeLast: removeLast._tag,
          demotions: concurrent.filter((outcome) => outcome._tag === "Success").length,
          owners: owners.length,
          notMember: notMember._tag,
        };
      }),
    );
    expect(result.demoteLast).toBe("LastOwnerError");
    expect(result.removeLast).toBe("LastOwnerError");
    expect(result.demotions).toBe(1);
    expect(result.owners).toBe(1);
    expect(result.notMember).toBe("MemberNotFoundError");
  });

  it("an account belongs to exactly one organization", async () => {
    const result = await run(
      Effect.gen(function* () {
        const organizations = yield* OrganizationsRepo;
        const globex = yield* organizations.create("Globex", null);
        yield* organizations.addMember(globex.id, "bob", "owner", null);
        const second = yield* organizations
          .addMember(acme, "bob", "member", null)
          .pipe(Effect.flip);
        const duplicateName = yield* organizations.create("  globex ", null).pipe(Effect.flip);
        const membership = yield* organizations.membershipOf("bob");
        return {
          second: second._tag,
          secondOrganization:
            second._tag === "AlreadyInOrganizationError" ? second.organizationId : null,
          duplicateName: duplicateName._tag,
          organization: membership?.organization.name,
          globex: globex.id,
        };
      }),
    );
    expect(result.second).toBe("AlreadyInOrganizationError");
    expect(result.secondOrganization).toBe(result.globex);
    expect(result.duplicateName).toBe("OrganizationNameTakenError");
    expect(result.organization).toBe("Globex");
  });

  it("an invitation is spent exactly once, even when two accounts race for it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const organizations = yield* OrganizationsRepo;
        const minted = yield* organizations.createInvitation({
          organizationId: acme,
          role: "member",
          email: null,
          createdByUserId: "alice",
          expiresAt: inAWeek(),
        });
        const outcomes = yield* Effect.all(
          [
            organizations
              .acceptInvitation(minted.token, { id: "dave", email: "dave@example.com" })
              .pipe(Effect.result),
            organizations
              .acceptInvitation(minted.token, { id: "erin", email: "erin@example.com" })
              .pipe(Effect.result),
          ],
          { concurrency: 2 },
        );
        const resolved = yield* organizations.invitationByToken(minted.token);
        const unknown = yield* organizations.invitationByToken("not-a-token").pipe(Effect.flip);
        return {
          successes: outcomes.filter((outcome) => outcome._tag === "Success").length,
          state: resolved.state,
          unknown: unknown._tag,
        };
      }),
    );
    expect(result.successes).toBe(1);
    expect(result.state).toBe("accepted");
    expect(result.unknown).toBe("InvitationUnknownError");
  });

  it("an email-bound invitation refuses other accounts without naming the address", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const organizations = yield* OrganizationsRepo;
        yield* sql`DELETE FROM organization_members WHERE user_id IN ('dave', 'erin')`;
        const minted = yield* organizations.createInvitation({
          organizationId: acme,
          role: "member",
          email: "  Erin@Example.com ",
          createdByUserId: "alice",
          expiresAt: inAWeek(),
        });
        const wrong = yield* organizations
          .acceptInvitation(minted.token, { id: "dave", email: "dave@example.com" })
          .pipe(Effect.flip);
        const right = yield* organizations.acceptInvitation(minted.token, {
          id: "erin",
          email: "ERIN@example.com",
        });
        return {
          stored: minted.invitation.email,
          wrong: wrong._tag,
          wrongKeys: Object.keys(wrong).filter((key) => key !== "_tag"),
          joined: right.member.role,
        };
      }),
    );
    expect(result.stored).toBe("erin@example.com");
    expect(result.wrong).toBe("InvitationNotForYouError");
    expect(result.wrongKeys).not.toContain("email");
    expect(result.joined).toBe("member");
  });

  it("revoked, expired and cross-organization acceptances are refused", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const organizations = yield* OrganizationsRepo;
        const revoked = yield* organizations.createInvitation({
          organizationId: acme,
          role: "member",
          email: null,
          createdByUserId: "alice",
          expiresAt: inAWeek(),
        });
        yield* organizations.revokeInvitation(acme, revoked.invitation.id);
        const revokedAccept = yield* organizations
          .acceptInvitation(revoked.token, { id: "dave", email: "dave@example.com" })
          .pipe(Effect.flip);

        const expiring = yield* organizations.createInvitation({
          organizationId: acme,
          role: "member",
          email: null,
          createdByUserId: "alice",
          expiresAt: new Date(Date.now() + 60_000),
        });
        yield* sql`
          UPDATE organization_invitations
          SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
          WHERE id = ${expiring.invitation.id}`;
        const expiredAccept = yield* organizations
          .acceptInvitation(expiring.token, { id: "dave", email: "dave@example.com" })
          .pipe(Effect.flip);

        const open = yield* organizations.createInvitation({
          organizationId: acme,
          role: "member",
          email: null,
          createdByUserId: "alice",
          expiresAt: inAWeek(),
        });
        const crossOrganization = yield* organizations
          .acceptInvitation(open.token, { id: "bob", email: "bob@example.com" })
          .pipe(Effect.flip);
        const stillOpen = yield* organizations.invitationByToken(open.token);
        const revokeOtherOrganization = yield* organizations
          .revokeInvitation(OrganizationId.make("org-nope"), open.invitation.id)
          .pipe(Effect.flip);
        return {
          revoked: revokedAccept._tag === "InvitationSpentError" ? revokedAccept.state : null,
          expired: expiredAccept._tag === "InvitationSpentError" ? expiredAccept.state : null,
          crossOrganization: crossOrganization._tag,
          stillOpen: stillOpen.state,
          revokeOtherOrganization: revokeOtherOrganization._tag,
        };
      }),
    );
    expect(result.revoked).toBe("revoked");
    expect(result.expired).toBe("expired");
    expect(result.crossOrganization).toBe("AlreadyInOrganizationError");
    expect(result.stillOpen).toBe("open");
    expect(result.revokeOtherOrganization).toBe("InvitationUnknownError");
  });

  it("an owner invitation promotes a member of the same organization", async () => {
    const role = await run(
      Effect.gen(function* () {
        const organizations = yield* OrganizationsRepo;
        const minted = yield* organizations.createInvitation({
          organizationId: acme,
          role: "owner",
          email: null,
          createdByUserId: "alice",
          expiresAt: inAWeek(),
        });
        const accepted = yield* organizations.acceptInvitation(minted.token, {
          id: "erin",
          email: "erin@example.com",
        });
        return accepted.member.role;
      }),
    );
    expect(role).toBe("owner");
  });

  it("project names are unique within an organization, not across the instance", async () => {
    const result = await run(
      Effect.gen(function* () {
        const organizations = yield* OrganizationsRepo;
        const projects = yield* ProjectsRepo;
        const globex = yield* organizations.membershipOf("bob");
        const base = {
          originUrl: null,
          defaultBranch: "main",
          adoptedSha: null,
          gitAuthMode: "ambient" as const,
        };
        const first = yield* projects.create({
          ...base,
          id: ProjectId.make("p-acme-api"),
          organizationId: acme,
          visibility: "private",
          createdByUserId: "alice",
          name: "api",
          storePath: "/store/p-acme-api/repo.git",
        });
        const elsewhere = yield* projects.create({
          ...base,
          id: ProjectId.make("p-globex-api"),
          organizationId: globex?.organization.id ?? acme,
          visibility: "shared",
          createdByUserId: "bob",
          name: "api",
          storePath: "/store/p-globex-api/repo.git",
        });
        const clash = yield* projects
          .create({
            ...base,
            id: ProjectId.make("p-acme-api-2"),
            organizationId: acme,
            visibility: "shared",
            createdByUserId: "carol",
            name: "api",
            storePath: "/store/p-acme-api-2/repo.git",
          })
          .pipe(Effect.flip);
        const shared = yield* projects.setVisibility(first.id, "shared");
        const acmeProjects = yield* projects.listForOrganization(acme);
        const byName = yield* projects.byName(acme, "api");
        return {
          clash: clash._tag,
          visibility: shared.visibility,
          acmeProjects: acmeProjects.map((project) => project.id),
          byName: byName?.id,
          elsewhere: elsewhere.organizationId !== first.organizationId,
        };
      }),
    );
    expect(result.clash).toBe("ProjectNameTakenError");
    expect(result.visibility).toBe("shared");
    expect(result.acmeProjects).toEqual(["p-acme-api"]);
    expect(result.byName).toBe("p-acme-api");
    expect(result.elsewhere).toBe(true);
  });

  it("the last operator cannot be revoked", async () => {
    const result = await run(
      Effect.gen(function* () {
        const roles = yield* InstanceRolesRepo;
        yield* roles.grantOperator("alice", null);
        const last = yield* roles.revokeOperator("alice").pipe(Effect.flip);
        yield* roles.grantOperator("carol", "alice");
        yield* roles.revokeOperator("alice");
        return { last: last._tag, operators: yield* roles.operators() };
      }),
    );
    expect(result.last).toBe("LastOperatorError");
    expect(result.operators).toEqual(["carol"]);
  });

  it("push devices belong to an account: listing is per account and unregistering touches only your own", async () => {
    const result = await run(
      Effect.gen(function* () {
        const devices = yield* PushDevicesRepo;
        yield* devices.register("bob", "tok-bob", "ios");
        yield* devices.register("carol", "tok-carol", "android");
        yield* devices.removeOwned("carol", "tok-bob");
        const afterForeignRemove = yield* devices.listForUsers(["bob"]);
        // The phone signs in as someone else: it moves to whoever registered it last.
        yield* devices.register("alice", "tok-carol", "android");
        return {
          bob: afterForeignRemove.map((device) => device.token),
          alice: (yield* devices.listForUsers(["alice"])).map((device) => device.token),
          carol: (yield* devices.listForUsers(["carol"])).map((device) => device.token),
          nobody: yield* devices.listForUsers([]),
        };
      }),
    );
    expect(result).toEqual({ bob: ["tok-bob"], alice: ["tok-carol"], carol: [], nobody: [] });
  });
});
