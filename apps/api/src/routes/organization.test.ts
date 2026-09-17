import { invitationsGroup, organizationGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AuditEventsRepo,
  InstanceRolesRepo,
  InvitationUnknownError,
  LastOwnerError,
  OrganizationsRepo,
  ProjectNotFoundError,
  ProjectsRepo,
  UserFacts,
  UsersRepo,
  type NewAuditEvent,
  type OrganizationMembership,
} from "@mend/db";
import { InvitationId, OrganizationId, ProjectId } from "@mend/domain";
import { Invitation, Organization, OrganizationMember, type Project } from "@mend/domain/workbench";
import { SessionEngine } from "@mend/sessions";
import { DeploymentConfig } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeProject } from "../../test/support/tenancy-harness.ts";
import { MemberRemoval, type RemoveMemberInput } from "../member-removal.ts";
import { TenancyConfig } from "../tenancy.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import {
  InvitationsGroupLive,
  OrganizationGroupLive,
  auditPage,
  invitationDays,
  invitationEmail,
} from "./organization.ts";

const NOW = new Date("2026-09-17T10:00:00.000Z");
const acme = new Organization({
  id: OrganizationId.make("org-acme"),
  name: "Acme",
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const roles: Record<string, OrganizationMembership["role"] | undefined> = {
  alice: "owner",
  carol: "member",
  // The operator, demoted to member by an owner: still never theirs to reset.
  olivia: "member",
};
const writes: Array<string> = [];
const audited: Array<NewAuditEvent> = [];
const removals: Array<RemoveMemberInput> = [];
/** Whose projects exist: bob left Acme, so his private project is orphaned. */
const projectRows = new Map<
  string,
  { organizationId: OrganizationId; createdByUserId: string | null }
>([
  ["p-bob", { organizationId: OrganizationId.make("org-acme"), createdByUserId: "bob" }],
  ["p-carol", { organizationId: OrganizationId.make("org-acme"), createdByUserId: "carol" }],
  ["p-elsewhere", { organizationId: OrganizationId.make("org-other"), createdByUserId: "zed" }],
]);
const minted: Array<{ readonly email: string | null; readonly expiresAt: Date }> = [];

const invitation = (email: string | null, expiresAt: Date) =>
  new Invitation({
    id: InvitationId.make("inv-1"),
    organizationId: acme.id,
    role: "member",
    email,
    createdByUserId: "alice",
    createdAt: NOW,
    expiresAt,
    acceptedByUserId: null,
    acceptedAt: null,
    revokedAt: null,
  });

const organizationsLayer = Layer.mock(OrganizationsRepo, {
  membershipOf: (userId) => {
    const role = roles[userId];
    return Effect.succeed(role === undefined ? null : { organization: acme, role, joinedAt: NOW });
  },
  memberCount: () => Effect.succeed(2),
  roleOf: (_organizationId, userId) => Effect.succeed(roles[userId] ?? null),
  members: () =>
    Effect.succeed(
      Object.entries(roles).flatMap(([userId, role]) =>
        role === undefined
          ? []
          : [
              new OrganizationMember({
                organizationId: acme.id,
                userId,
                name: userId,
                email: `${userId}@example.invalid`,
                role,
                joinedAt: NOW,
              }),
            ],
      ),
    ),
  setRole: (_organizationId, userId, role) =>
    userId === "alice" && role === "member"
      ? Effect.fail(new LastOwnerError({ organizationId: acme.id }))
      : Effect.sync(() => {
          writes.push(`setRole:${userId}:${role}`);
          return new OrganizationMember({
            organizationId: acme.id,
            userId,
            name: userId,
            email: `${userId}@example.invalid`,
            role,
            joinedAt: NOW,
          });
        }),
  listInvitations: () => Effect.sync(() => (writes.push("listInvitations"), [])),
  createInvitation: (input) =>
    Effect.sync(() => {
      writes.push("createInvitation");
      minted.push({ email: input.email, expiresAt: input.expiresAt });
      return { invitation: invitation(input.email, input.expiresAt), token: "tok-secret" };
    }),
  revokeInvitation: () =>
    Effect.sync(() => (writes.push("revokeInvitation"), invitation(null, NOW))),
  invitationByToken: (token) =>
    token === "tok-open"
      ? Effect.succeed({
          invitation: invitation("bound@example.invalid", new Date("2026-09-24T10:00:00Z")),
          organization: acme,
          state: "open",
        })
      : Effect.fail(new InvitationUnknownError()),
});

const resets: Array<string> = [];

const authLayer = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
  issuePasswordReset: (userId) =>
    Effect.sync(() => {
      resets.push(userId);
      return { token: `reset-${userId}`, expiresAt: new Date("2026-09-18T10:00:00Z") };
    }),
  getSession: (headers) => {
    const user = headers.get("authorization")?.replace("Bearer ", "") ?? "";
    return Effect.succeed(
      user === ""
        ? Option.none()
        : Option.some({
            user: { id: user, email: `${user}@example.invalid`, name: user },
            expiresAt: new Date("2026-09-18T10:00:00Z"),
          }),
    );
  },
});

const projectOf = (id: string): Project | null => {
  const row = projectRows.get(id);
  if (row === undefined) return null;
  return makeProject({
    id: ProjectId.make(id),
    organizationId: row.organizationId,
    visibility: "private",
    createdByUserId: row.createdByUserId,
    storePath: `/store/${id}/repo.git`,
  });
};

const dependencies = Layer.mergeAll(
  authLayer,
  organizationsLayer,
  Layer.mock(InstanceRolesRepo, {
    isOperator: (userId) => Effect.succeed(userId === "alice" || userId === "olivia"),
  }),
  Layer.mock(AuditEventsRepo, {
    record: (event) => Effect.sync(() => void audited.push(event)),
    listForOrganization: () => Effect.sync(() => (writes.push("audit"), [])),
  }),
  Layer.mock(MemberRemoval, {
    remove: (input) =>
      input.userId === "alice"
        ? Effect.fail(new LastOwnerError({ organizationId: acme.id }))
        : Effect.sync(() => void removals.push(input)),
  }),
  Layer.mock(ProjectsRepo, {
    listForOrganization: (organizationId) =>
      Effect.succeed(
        [...projectRows.keys()]
          .map(projectOf)
          .filter((project): project is Project => project?.organizationId === organizationId),
      ),
    byId: (id) => {
      const project = projectOf(id);
      return project === null
        ? Effect.fail(new ProjectNotFoundError({ projectId: id }))
        : Effect.succeed(project);
    },
    setCreatedBy: (id, userId) =>
      Effect.sync(() => {
        writes.push(`setCreatedBy:${id}:${userId}`);
        const project = projectOf(id);
        if (project === null) throw new Error("no project");
        return project;
      }),
  }),
  Layer.mock(SessionEngine, { reconcileHotSessions: () => Effect.void }),
  Layer.mock(UsersRepo, {
    byId: (id) =>
      Effect.succeed(
        roles[id] === undefined && id !== "bob"
          ? null
          : new UserFacts({ id, name: id === "bob" ? "Bob" : id, email: `${id}@example.invalid` }),
      ),
  }),
  Layer.succeed(TenancyConfig, { mode: "single", gate: [] }),
  Layer.succeed(DeploymentConfig, {
    mode: "local",
    sessionEndpoint: undefined,
    sessionStore: "captured",
  }),
);
const api = HttpApi.make("mend").add(organizationGroup).add(invitationsGroup).prefix("/api");
const apiLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(Layer.mergeAll(OrganizationGroupLive, InvitationsGroupLive)),
  Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
  Layer.provide(HttpServer.layerServices),
);
const runtime = ManagedRuntime.make(dependencies);
const context = await runtime.runPromise(Effect.context<Layer.Success<typeof dependencies>>());
const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });

const call = (user: string | null, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  if (user !== null) headers.set("authorization", `Bearer ${user}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return handler(new Request(`http://api.internal${path}`, { ...init, headers }), context);
};

afterAll(async () => {
  await dispose();
  await runtime.dispose();
});

beforeEach(() => {
  writes.splice(0, writes.length);
  minted.splice(0, minted.length);
  audited.splice(0, audited.length);
  removals.splice(0, removals.length);
  resets.splice(0, resets.length);
});

describe("organization routes (docs/adr/0003)", () => {
  it("shows a member their organization and role", async () => {
    const response = await call("carol", "/api/organization");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organization: { name: "Acme" },
      role: "member",
      memberCount: 2,
      operator: false,
      userId: "carol",
      tenancy: "single",
      mountDelivery: "sources",
    });
  });

  it("answers 404 to an account in no organization", async () => {
    const response = await call("dave", "/api/organization/members");
    expect(response.status).toBe(404);
  });

  it("refuses owner actions to a member as 404, before any write", async () => {
    const create = await call("carol", "/api/organization/invitations", {
      method: "POST",
      body: JSON.stringify({ role: "owner" }),
    });
    const list = await call("carol", "/api/organization/invitations");
    const revoke = await call("carol", "/api/organization/invitations/inv-1", {
      method: "DELETE",
    });
    expect([create.status, list.status, revoke.status]).toEqual([404, 404, 404]);
    await expect(revoke.json()).resolves.toMatchObject({ _tag: "NotFound", id: "inv-1" });
    expect(writes).toEqual([]);
  });

  it("lets an owner mint a link, returning the token once with its join path", async () => {
    const response = await call("alice", "/api/organization/invitations", {
      method: "POST",
      body: JSON.stringify({ role: "member", email: " Carol@Example.invalid ", expiresInDays: 90 }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      token: "tok-secret",
      path: "/join/tok-secret",
    });
    expect(minted[0]?.email).toBe("carol@example.invalid");
  });

  it("rejects a malformed email without minting", async () => {
    const response = await call("alice", "/api/organization/invitations", {
      method: "POST",
      body: JSON.stringify({ role: "member", email: "not an address" }),
    });
    expect(response.status).toBe(422);
    expect(writes).toEqual([]);
  });

  it("previews a link without signing in, and without the bound email", async () => {
    const preview = (token: string) =>
      call(null, "/api/invitations/preview", { method: "POST", body: JSON.stringify({ token }) });
    const response = await preview("tok-open");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ organizationName: "Acme", role: "member", state: "open" });
    expect(JSON.stringify(body)).not.toContain("bound@example.invalid");
    const unknown = await preview("nope");
    expect(unknown.status).toBe(404);
  });
});

describe("removing members, roles and departed members' projects (docs/adr/0003)", () => {
  it("refuses every owner action to a member as 404, before anything moves", async () => {
    const statuses = [
      (await call("carol", "/api/organization/members/alice", { method: "DELETE" })).status,
      (
        await call("carol", "/api/organization/members/carol/role", {
          method: "PUT",
          body: JSON.stringify({ role: "owner" }),
        })
      ).status,
      (await call("carol", "/api/organization/orphaned-projects")).status,
      (await call("carol", "/api/organization/projects/p-bob/takeover", { method: "POST" })).status,
      (await call("carol", "/api/organization/audit")).status,
    ];
    expect({ statuses, writes, removals, audited }).toEqual({
      statuses: [404, 404, 404, 404, 404],
      writes: [],
      removals: [],
      audited: [],
    });
  });

  it("an owner removes a member as themselves; the last owner cannot go", async () => {
    const removed = await call("alice", "/api/organization/members/carol", { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect(removals).toEqual([{ organizationId: acme.id, userId: "carol", actorUserId: "alice" }]);
    const stranger = await call("alice", "/api/organization/members/zed", { method: "DELETE" });
    expect(stranger.status).toBe(404);
    expect(removals).toHaveLength(1);
    const last = await call("alice", "/api/organization/members/alice", { method: "DELETE" });
    expect(last.status).toBe(422);
    await expect(last.json()).resolves.toMatchObject({ _tag: "OrganizationRejected" });
  });

  it("a role change is recorded, and demoting the last owner is refused without a record", async () => {
    const promoted = await call("alice", "/api/organization/members/carol/role", {
      method: "PUT",
      body: JSON.stringify({ role: "owner" }),
    });
    expect(promoted.status).toBe(200);
    const demoted = await call("alice", "/api/organization/members/alice/role", {
      method: "PUT",
      body: JSON.stringify({ role: "member" }),
    });
    expect(demoted.status).toBe(422);
    expect(audited.map((event) => [event.action, event.subjectId, event.data])).toEqual([
      ["member.role_changed", "carol", { role: "owner" }],
    ]);
  });

  it("lists and takes over only a departed member's project in the owner's organization", async () => {
    const orphaned = await call("alice", "/api/organization/orphaned-projects");
    const listed: unknown = await orphaned.json();
    expect(JSON.stringify(listed)).toContain("p-bob");
    expect(JSON.stringify(listed)).not.toContain("p-carol");
    expect(JSON.stringify(listed)).not.toContain("p-elsewhere");

    const stillHere = await call("alice", "/api/organization/projects/p-carol/takeover", {
      method: "POST",
    });
    const elsewhere = await call("alice", "/api/organization/projects/p-elsewhere/takeover", {
      method: "POST",
    });
    expect([stillHere.status, elsewhere.status]).toEqual([422, 404]);
    expect(writes).toEqual([]);

    const taken = await call("alice", "/api/organization/projects/p-bob/takeover", {
      method: "POST",
    });
    expect(taken.status).toBe(200);
    expect(writes).toEqual(["setCreatedBy:p-bob:alice"]);
    expect(audited.map((event) => [event.action, event.subjectId, event.data])).toEqual([
      ["project.taken_over", "p-bob", { fromUserId: "bob" }],
    ]);
  });

  it("an owner hands a member a reset link; owners and other callers get none", async () => {
    const byMember = await call("carol", "/api/organization/members/carol/password-reset", {
      method: "POST",
    });
    const forOwner = await call("alice", "/api/organization/members/alice/password-reset", {
      method: "POST",
    });
    const forOperator = await call("alice", "/api/organization/members/olivia/password-reset", {
      method: "POST",
    });
    expect([byMember.status, forOwner.status, forOperator.status]).toEqual([404, 422, 422]);
    expect(resets).toEqual([]);

    const issued = await call("alice", "/api/organization/members/carol/password-reset", {
      method: "POST",
    });
    expect(issued.status).toBe(200);
    await expect(issued.json()).resolves.toMatchObject({ path: "/reset/reset-carol" });
    expect(resets).toEqual(["carol"]);
    expect(audited.map((event) => [event.action, event.subjectId])).toEqual([
      ["member.password_reset_issued", "carol"],
    ]);
  });

  it("reads audit pages with a bounded limit after the previous page's last event", () => {
    expect(auditPage(undefined, undefined)).toEqual({ beforeId: null, limit: 50 });
    expect(auditPage("  ", "5000")).toEqual({ beforeId: null, limit: 200 });
    expect(auditPage("event-9", "0")).toEqual({ beforeId: "event-9", limit: 1 });
  });
});

describe("invitation limits", () => {
  it("clamps expiry between one day and the maximum", () => {
    expect(invitationDays(undefined)).toBe(7);
    expect(invitationDays(0)).toBe(1);
    expect(invitationDays(90)).toBe(30);
  });

  it("normalizes an email or names the problem", () => {
    expect(invitationEmail(undefined)).toEqual({ email: null });
    expect(invitationEmail("  ")).toEqual({ email: null });
    expect(invitationEmail(" A@B.io ")).toEqual({ email: "a@b.io" });
    expect(invitationEmail("nope")).toEqual({ issue: "That does not look like an email address." });
  });
});
