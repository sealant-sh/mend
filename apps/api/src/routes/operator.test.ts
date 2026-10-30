import { CurrentUser, NotFound, operatorGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AuditEventsRepo,
  OrganizationsRepo,
  OrganizationNotFoundError,
  OrganizationNameTakenError,
  UserFacts,
  UsersRepo,
  type NewAuditEvent,
} from "@mend/db";
import { InvitationId, OrganizationId } from "@mend/domain";
import { Invitation, Organization, OrganizationMember } from "@mend/domain/workbench";
import { it, TestClock } from "@mend/test-ci/effect-vitest";
import { Clock, Context, Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { afterAll, beforeEach, describe, expect } from "vitest";

import { ProjectAccess } from "../access.ts";
import { ExposureConfig, type ExposureOutcome } from "../exposure.ts";
import { TenancyConfig } from "../tenancy.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { OperatorGroupLive } from "./operator.ts";

const NOW = new Date("2026-09-17T10:00:00.000Z");
const ACME = OrganizationId.make("org-acme");
const acme = new Organization({
  id: ACME,
  name: "Acme",
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

const globex = new Organization({ ...acme, id: OrganizationId.make("org-globex"), name: "Globex" });
const organizationRows = new Map<OrganizationId, Organization>();
const roleChanges: Array<Parameters<OrganizationsRepo["Service"]["setRole"]>> = [];
const minted: Array<Parameters<OrganizationsRepo["Service"]["createInvitation"]>[0]> = [];

/** alice operates the instance; sam is a member of Acme; everyone else is nobody. */
const accounts = new Map([
  [
    "alice@example.invalid",
    new UserFacts({ id: "alice", name: "Alice", email: "alice@example.invalid" }),
  ],
  ["sam@example.invalid", new UserFacts({ id: "sam", name: "Sam", email: "sam@example.invalid" })],
]);
const writes: Array<string> = [];
const audited: Array<NewAuditEvent> = [];

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
  issuePasswordReset: (userId) =>
    Effect.sync(() => {
      writes.push(`reset:${userId}`);
      return { token: `token-for-${userId}`, expiresAt: new Date("2026-09-18T10:00:00Z") };
    }),
});

/** What this instance's exposure gate leaves open, as the operator report reads it. */
const OPEN_ITEMS: ReadonlyArray<ExposureOutcome> = [
  {
    id: "https-origin",
    established: "open",
    detail: "plain http origin(s): http://10.0.0.216:3105",
    fix: "set APP_URL and every MEND_ALLOWED_ORIGINS entry to https",
    blocksStart: true,
    observable: true,
  },
  {
    id: "reassessment",
    established: "open",
    detail: "no independent reassessment of dev is recorded",
    fix: "after an independent security reassessment of this exact release, set MEND_EXPOSURE_REASSESSED=dev",
    blocksStart: false,
    observable: false,
  },
];

const dependencies = Layer.mergeAll(
  authLayer,
  Layer.mock(OrganizationsRepo, {
    byId: (id) =>
      Effect.suspend(() => {
        const row = organizationRows.get(id);
        return row === undefined
          ? Effect.fail(new OrganizationNotFoundError({ organizationId: id }))
          : Effect.succeed(row);
      }),
    rename: (id, name) =>
      Effect.gen(function* () {
        const row = organizationRows.get(id);
        if (row === undefined) return yield* new OrganizationNotFoundError({ organizationId: id });
        if ([...organizationRows.values()].some((other) => other.id !== id && other.name === name))
          return yield* new OrganizationNameTakenError({ name });
        const renamed = new Organization({ ...row, name });
        writes.push(`rename:${id}:${name}`);
        organizationRows.set(id, renamed);
        return renamed;
      }),
    createInvitation: (input) =>
      Effect.sync(() => {
        minted.push(input);
        return {
          token: "operator-invite-token",
          invitation: new Invitation({
            ...input,
            id: InvitationId.make("operator-invitation"),
            createdAt: NOW,
            acceptedByUserId: null,
            acceptedAt: null,
            revokedAt: null,
          }),
        };
      }),
    roleOf: (organizationId, userId) =>
      Effect.succeed(organizationId === ACME && userId === "sam" ? "member" : null),
    membershipOf: (userId) =>
      Effect.succeed(
        userId === "sam" ? { organization: acme, role: "member", joinedAt: NOW } : null,
      ),
    setRole: (organizationId, userId, role) =>
      Effect.sync(() => {
        roleChanges.push([organizationId, userId, role]);
        writes.push(`setRole:${userId}:${role}`);
        return new OrganizationMember({
          organizationId,
          userId,
          name: userId,
          email: `${userId}@example.invalid`,
          role,
          joinedAt: NOW,
        });
      }),
    create: () => Effect.sync(() => (writes.push("create"), acme)),
  }),
  Layer.mock(UsersRepo, { byEmail: (email) => Effect.succeed(accounts.get(email) ?? null) }),
  Layer.mock(AuditEventsRepo, { record: (event) => Effect.sync(() => void audited.push(event)) }),
  Layer.succeed(TenancyConfig, { mode: "single", gate: Effect.succeed([]) }),
  Layer.succeed(ExposureConfig, {
    exposure: "private",
    gate: Effect.succeed(OPEN_ITEMS),
    gateWith: () => OPEN_ITEMS,
    t3Gateway: undefined,
  }),
);

// Only alice operates: everyone else is refused the way ProjectAccess refuses them.
const operatorOnly = Layer.mock(ProjectAccess, {
  requireOperator: (id) =>
    Effect.gen(function* () {
      const caller = yield* CurrentUser;
      if (caller.user.id !== "alice") return yield* new NotFound({ id });
    }),
});

const api = HttpApi.make("mend").add(operatorGroup).prefix("/api");
const apiLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(OperatorGroupLive),
  Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(authLayer))),
  Layer.provide(HttpServer.layerServices),
);
const all = Layer.merge(dependencies, operatorOnly);
const runtime = ManagedRuntime.make(all);
const context = await runtime.runPromise(Effect.context<Layer.Success<typeof all>>());
const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });

const call = (user: string, method: string, path: string, body?: unknown, clock?: Clock.Clock) =>
  handler(
    new Request(`http://api.internal/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${user}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    clock === undefined ? context : Context.add(context, Clock.Clock, clock),
  );

afterAll(async () => {
  await dispose();
  await runtime.dispose();
});

beforeEach(() => {
  organizationRows.clear();
  organizationRows.set(acme.id, acme);
  organizationRows.set(globex.id, globex);
  roleChanges.length = 0;
  minted.length = 0;
  writes.splice(0, writes.length);
  audited.splice(0, audited.length);
});

describe("operator recovery (docs/adr/0003)", () => {
  it("answers 404 to anyone but the operator, before anything moves", async () => {
    const statuses = [
      (await call("sam", "GET", "/operator/organizations")).status,
      (await call("sam", "POST", "/operator/organizations", { name: "Globex" })).status,
      (await call("sam", "PUT", `/operator/organizations/${ACME}/name`, { name: "X" })).status,
      (await call("sam", "POST", `/operator/organizations/${ACME}/invitations`, {})).status,
      (
        await call("sam", "POST", `/operator/organizations/${ACME}/owners`, {
          email: "sam@example.invalid",
        })
      ).status,
      (await call("sam", "POST", "/operator/password-resets", { email: "sam@example.invalid" }))
        .status,
    ];
    expect({ statuses, writes, audited }).toEqual({
      statuses: [404, 404, 404, 404, 404, 404],
      writes: [],
      audited: [],
    });
  });

  it("keeps one organization in single tenancy", async () => {
    const response = await call("alice", "POST", "/operator/organizations", { name: "Globex" });
    expect(response.status).toBe(422);
    expect(writes).toEqual([]);
  });

  it("grants owner only to a member, and records it in that organization", async () => {
    const stranger = await call("alice", "POST", `/operator/organizations/${ACME}/owners`, {
      email: "nobody@example.invalid",
    });
    expect(stranger.status).toBe(422);
    const granted = await call("alice", "POST", `/operator/organizations/${ACME}/owners`, {
      email: "sam@example.invalid",
    });
    expect(granted.status).toBe(204);
    expect(writes).toEqual(["setRole:sam:owner"]);
    expect(roleChanges).toEqual([[ACME, "sam", "owner"]]);
    expect(audited).toEqual([
      {
        organizationId: ACME,
        actorUserId: "alice",
        action: "recovery.owner_granted",
        subjectType: "member",
        subjectId: "sam",
      },
    ]);
  });

  it("renames the selected organization and records the operator and normalized name", async () => {
    const response = await call("alice", "PUT", `/operator/organizations/${globex.id}/name`, {
      name: "  Globex renamed  ",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: globex.id, name: "Globex renamed" });
    expect(writes).toEqual([`rename:${globex.id}:Globex renamed`]);
    expect(organizationRows.get(acme.id)).toEqual(acme);
    expect(organizationRows.get(globex.id)?.name).toBe("Globex renamed");
    expect(audited).toEqual([
      {
        organizationId: globex.id,
        actorUserId: "alice",
        action: "organization.renamed",
        subjectType: "organization",
        subjectId: globex.id,
        data: { name: "Globex renamed" },
      },
    ]);
  });

  it.each([
    { id: "org-globex", name: "Acme", status: 422, tag: "OrganizationRejected" },
    { id: "missing-org", name: "New name", status: 404, tag: "NotFound" },
    { id: "org-globex", name: "   ", status: 422, tag: "OrganizationRejected" },
  ])("refuses rename $id/$name without mutation", async ({ id, name, status, tag }) => {
    const response = await call("alice", "PUT", `/operator/organizations/${id}/name`, { name });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ _tag: tag });
    expect([...organizationRows.values()]).toEqual([acme, globex]);
    expect({ writes, audited }).toEqual({ writes: [], audited: [] });
  });

  it.effect(
    "invites an owner into the selected organization with a normalized email and thirty-day cap",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW.getTime());
        const clock = yield* Clock.clockWith(Effect.succeed);
        const response = yield* Effect.promise(() =>
          call(
            "alice",
            "POST",
            `/operator/organizations/${globex.id}/invitations`,
            {
              email: "  New.Owner@Example.invalid  ",
              expiresInDays: 90,
            },
            clock,
          ),
        );
        expect(response.status).toBe(200);
        expect(yield* Effect.promise(() => response.json())).toEqual({
          path: "/join#operator-invite-token",
          expiresAt: "2026-10-17T10:00:00.000Z",
        });
        expect(minted).toEqual([
          {
            organizationId: globex.id,
            role: "owner",
            email: "new.owner@example.invalid",
            createdByUserId: "alice",
            expiresAt: new Date("2026-10-17T10:00:00.000Z"),
          },
        ]);
        expect(audited).toEqual([
          {
            organizationId: globex.id,
            actorUserId: "alice",
            action: "invitation.created",
            subjectType: "invitation",
            subjectId: "operator-invitation",
            data: { role: "owner", emailBound: true, byOperator: true },
          },
        ]);
      }),
  );

  it.each([
    { id: "missing-org", email: "valid@example.invalid", status: 404 },
    { id: "org-globex", email: "invalid address", status: 422 },
  ])("does not mint an owner invitation for $id/$email", async ({ id, email, status }) => {
    const response = await call("alice", "POST", `/operator/organizations/${id}/invitations`, {
      email,
    });
    expect(response.status).toBe(status);
    expect({ minted, writes, audited }).toEqual({ minted: [], writes: [], audited: [] });
  });

  it("does not promote a member of a different organization", async () => {
    const response = await call("alice", "POST", `/operator/organizations/${globex.id}/owners`, {
      email: "sam@example.invalid",
    });
    expect(response.status).toBe(422);
    expect({ roleChanges, writes, audited }).toEqual({ roleChanges: [], writes: [], audited: [] });
  });

  it("hands over a reset link for an account in an organization, and none for anyone else", async () => {
    const unknown = await call("alice", "POST", "/operator/password-resets", {
      email: "nobody@example.invalid",
    });
    expect(unknown.status).toBe(422);
    // An account that exists but belongs to no organization (removed, or never joined).
    const outside = await call("alice", "POST", "/operator/password-resets", {
      email: "alice@example.invalid",
    });
    expect(outside.status).toBe(422);
    expect(writes).toEqual([]);
    const issued = await call("alice", "POST", "/operator/password-resets", {
      email: "sam@example.invalid",
    });
    expect(issued.status).toBe(200);
    await expect(issued.json()).resolves.toMatchObject({ path: "/reset#token-for-sam" });
    expect(writes).toEqual(["reset:sam"]);
    expect(audited.map((event) => [event.organizationId, event.action])).toEqual([
      [ACME, "recovery.password_reset_issued"],
    ]);
  });
});

describe("the exposure report (docs/adr/0004)", () => {
  it("is the operator's alone", async () => {
    expect((await call("sam", "GET", "/operator/exposure")).status).toBe(404);
  });

  it("states what was declared and how each item was established", async () => {
    const response = await call("alice", "GET", "/operator/exposure");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      declared: "private",
      items: [
        {
          id: "https-origin",
          established: "open",
          detail: "plain http origin(s): http://10.0.0.216:3105",
          fix: "set APP_URL and every MEND_ALLOWED_ORIGINS entry to https",
          blocksStart: true,
        },
        {
          id: "reassessment",
          established: "open",
          detail: "no independent reassessment of dev is recorded",
          fix: "after an independent security reassessment of this exact release, set MEND_EXPOSURE_REASSESSED=dev",
          blocksStart: false,
        },
      ],
    });
  });
});
