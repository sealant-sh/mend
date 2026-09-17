import { invitationsGroup, organizationGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  InstanceRolesRepo,
  InvitationUnknownError,
  OrganizationsRepo,
  type OrganizationMembership,
} from "@mend/db";
import { InvitationId, OrganizationId } from "@mend/domain";
import { Invitation, Organization, OrganizationMember } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { AuthMiddlewareLive } from "./api-live.ts";
import {
  InvitationsGroupLive,
  OrganizationGroupLive,
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
};
const writes: Array<string> = [];
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
  members: () =>
    Effect.succeed([
      new OrganizationMember({
        organizationId: acme.id,
        userId: "alice",
        name: "Alice",
        email: "alice@example.invalid",
        role: "owner",
        joinedAt: NOW,
      }),
    ]),
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

const authLayer = Layer.succeed(Auth, {
  handler: () => Effect.succeed(new Response(null, { status: 404 })),
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

const dependencies = Layer.mergeAll(
  authLayer,
  organizationsLayer,
  Layer.mock(InstanceRolesRepo, { isOperator: (userId) => Effect.succeed(userId === "alice") }),
);
const api = HttpApi.make("mend").add(organizationGroup).add(invitationsGroup).prefix("/api");
const apiLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(Layer.mergeAll(OrganizationGroupLive, InvitationsGroupLive)),
  Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
  Layer.provide(HttpServer.layerServices),
);
const runtime = ManagedRuntime.make(dependencies);
const context = await runtime.runPromise(
  Effect.context<Auth | OrganizationsRepo | InstanceRolesRepo>(),
);
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
    const response = await call(null, "/api/invitations/tok-open");
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ organizationName: "Acme", role: "member", state: "open" });
    expect(JSON.stringify(body)).not.toContain("bound@example.invalid");
    const unknown = await call(null, "/api/invitations/nope");
    expect(unknown.status).toBe(404);
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
