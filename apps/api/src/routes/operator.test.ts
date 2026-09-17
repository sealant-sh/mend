import { CurrentUser, NotFound, operatorGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AuditEventsRepo,
  OrganizationsRepo,
  UserFacts,
  UsersRepo,
  type NewAuditEvent,
} from "@mend/db";
import { OrganizationId } from "@mend/domain";
import { Organization, OrganizationMember } from "@mend/domain/workbench";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { ProjectAccess } from "../access.ts";
import { ExposureConfig } from "../exposure.ts";
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
      return { token: `tok-${userId}`, expiresAt: new Date("2026-09-18T10:00:00Z") };
    }),
});

const dependencies = Layer.mergeAll(
  authLayer,
  Layer.mock(OrganizationsRepo, {
    byId: (id) => (id === ACME ? Effect.succeed(acme) : Effect.die("unknown organization")),
    roleOf: (_organizationId, userId) => Effect.succeed(userId === "sam" ? "member" : null),
    membershipOf: (userId) =>
      Effect.succeed(
        userId === "sam" ? { organization: acme, role: "member", joinedAt: NOW } : null,
      ),
    setRole: (_organizationId, userId, role) =>
      Effect.sync(() => {
        writes.push(`setRole:${userId}:${role}`);
        return new OrganizationMember({
          organizationId: ACME,
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
  Layer.succeed(TenancyConfig, { mode: "single", gate: [] }),
  Layer.succeed(ExposureConfig, {
    exposure: "private",
    gate: [
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

const call = (user: string, method: string, path: string, body?: unknown) =>
  handler(
    new Request(`http://api.internal/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${user}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  );

afterAll(async () => {
  await dispose();
  await runtime.dispose();
});

beforeEach(() => {
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
    expect(audited.map((event) => [event.organizationId, event.action, event.subjectId])).toEqual([
      [ACME, "recovery.owner_granted", "sam"],
    ]);
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
    await expect(issued.json()).resolves.toMatchObject({ path: "/reset/tok-sam" });
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
