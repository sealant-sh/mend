import { AuditEventId, OrganizationId } from "@mend/domain";
import { AuditEvent } from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  FOLDER_A,
  FOLDER_B,
  type HarnessUser,
  ids,
  organizationIdOf,
  phoneBearerOf,
} from "../../test/support/tenancy-harness.ts";

const A = organizationIdOf("A");
const B = organizationIdOf("B");
const sharedA = ids("shared-a");
const sharedB = ids("shared-b");
const NOW = new Date("2026-11-08T10:00:00.000Z");
const CLI = { authorization: `Bearer ${phoneBearerOf("erin")}` };

const auditOf = (organizationId: OrganizationId) =>
  new AuditEvent({
    id: AuditEventId.make(`audit-${organizationId}`),
    organizationId,
    actorUserId: "erin",
    action: "member.role_changed",
    subjectType: "member",
    subjectId: "carol",
    data: { role: "member" },
    accessKey: null,
    createdAt: NOW,
  });

let api: TenancyApi;

beforeAll(async () => {
  api = await createTenancyApi(
    {},
    {
      implement: {
        engine: { launchUnderWay: () => false },
        audit: {
          listForOrganization: (organizationId) => Effect.succeed([auditOf(organizationId)]),
        },
        executor: {
          configuration: (organizationId) =>
            Effect.succeed({
              mode: "own" as const,
              url: `https://executor.invalid/${organizationId}`,
              mendRunAvailable: false,
              member: { state: "unlinked" as const, observedAt: null },
            }),
        },
        slackInstalls: {
          byOrganization: (organizationId) =>
            Effect.succeed({
              organizationId,
              teamId: `T-${organizationId}`,
              teamName: `Slack of ${organizationId}`,
              botUserId: "U-bot",
              appId: "A-app",
              sealedAppToken: "sealed",
              sealedBotToken: "sealed",
              webOrigin: "http://web.internal",
              settings: {
                defaultHarness: "codex",
                showAgentMessages: true,
                showDiffs: false,
                externalChannels: false,
                landAutomatically: true,
              },
              installedByUserId: "erin",
              createdAt: NOW,
              updatedAt: NOW,
            }),
        },
        slackDefaults: { personalDefault: () => Effect.succeed(null) },
      },
    },
  );
});
afterAll(async () => {
  await api.dispose();
});
beforeEach(() => {
  api.world.calls.splice(0, api.world.calls.length);
});

const call = async (
  user: HarnessUser,
  method: string,
  path: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) => {
  const response = await api.request(
    headers?.["authorization"] === undefined ? user : null,
    method,
    path,
    body,
    headers,
  );
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
};

const read = async (path: string, headers?: Readonly<Record<string, string>>) => {
  const { status, body } = await call("erin", "GET", path, undefined, headers);
  expect(status).toBe(200);
  return body;
};

const idsIn = (body: unknown): ReadonlyArray<string> =>
  Array.isArray(body)
    ? body
        .map((row: unknown) =>
          typeof row === "object" && row !== null && "id" in row ? String(row.id) : "",
        )
        .toSorted()
    : [];

const field = (body: unknown, ...path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined,
    body,
  );

const switchTo = (organizationId: string, headers?: Readonly<Record<string, string>>) =>
  call("erin", "PUT", "/api/account/organizations/active", { organizationId }, headers);

describe("one account in two organizations", () => {
  it("each sign-in starts where the account joined first, and lists both memberships with their roles", async () => {
    const listed = await read("/api/account/organizations");
    expect(
      Array.isArray(listed)
        ? listed.map((row: unknown) => [
            field(row, "organization", "id"),
            field(row, "role"),
            field(row, "active"),
          ])
        : listed,
    ).toEqual([
      [A, "owner", true],
      [B, "member", false],
    ]);
    expect(idsIn(await read("/api/projects"))).toEqual([sharedA.project]);
    expect(field(await read("/api/organization"), "organization", "id")).toBe(A);
    expect(idsIn(await read("/api/projects", CLI))).toEqual([sharedA.project]);
  });

  describe("after the web sign-in switches to B", () => {
    beforeAll(async () => {
      const switched = await switchTo(B);
      expect(switched.status).toBe(200);
      expect([field(switched.body, "organization", "id"), field(switched.body, "role")]).toEqual([
        B,
        "member",
      ]);
    });

    it("every list shows B only: projects, sessions, the inbox, members, folders, audit refusal, Slack and Executor", async () => {
      expect(idsIn(await read("/api/projects"))).toEqual([sharedB.project]);
      const sessions = idsIn(await read("/api/sessions"));
      expect(sessions).toContain(sharedB.session);
      expect(sessions).not.toContain(sharedA.session);
      const inbox = await read("/api/session-inbox");
      expect(
        new Set(
          Array.isArray(inbox)
            ? inbox.map((row: unknown) => field(row, "session", "projectId"))
            : [],
        ),
      ).toEqual(new Set([sharedB.project]));
      const organization = await read("/api/organization");
      expect([field(organization, "organization", "id"), field(organization, "role")]).toEqual([
        B,
        "member",
      ]);
      const members = await read("/api/organization/members");
      expect(
        Array.isArray(members)
          ? members.map((row: unknown) => String(field(row, "userId"))).toSorted()
          : [],
      ).toEqual(["bob", "erin"]);
      expect(idsIn(await read("/api/organization/folders"))).toEqual([FOLDER_B]);
      expect(field(await read("/api/slack/me"), "workspace", "teamId")).toBe(`T-${B}`);
      expect(field(await read("/api/organization/executor"), "url")).toBe(
        `https://executor.invalid/${B}`,
      );
    });

    it("A's project, session, worktree and change answer like missing ones, with zero effects", async () => {
      for (const path of [
        `/api/projects/${sharedA.project}`,
        `/api/sessions/${sharedA.session}`,
        `/api/worktrees/${sharedA.worktree}`,
        `/api/changes/${sharedA.change}/stats`,
      ]) {
        api.world.calls.splice(0, api.world.calls.length);
        const { status } = await call("erin", "GET", path);
        expect({ path, status, calls: api.world.calls }).toEqual({ path, status: 404, calls: [] });
      }
    });

    it("owning A grants nothing while she acts in B, and owning A makes her no owner of B", async () => {
      const attempts: ReadonlyArray<readonly [string, string, unknown]> = [
        ["PUT", `/api/projects/${sharedA.project}/visibility`, { visibility: "private" }],
        ["PUT", `/api/projects/${sharedB.project}/visibility`, { visibility: "private" }],
        ["GET", "/api/organization/audit", undefined],
        ["GET", "/api/organization/invitations", undefined],
        ["POST", "/api/organization/invitations", { role: "member" }],
        ["DELETE", "/api/organization/members/bob", undefined],
      ];
      for (const [method, path, body] of attempts) {
        api.world.calls.splice(0, api.world.calls.length);
        const { status } = await call("erin", method, path, body);
        expect({ path, status, calls: api.world.calls }).toEqual({ path, status: 404, calls: [] });
      }
    });

    it("her CLI sign-in stays in A, where she still owns it", async () => {
      expect(idsIn(await read("/api/projects", CLI))).toEqual([sharedA.project]);
      const organization = await read("/api/organization", CLI);
      expect([field(organization, "organization", "id"), field(organization, "role")]).toEqual([
        A,
        "owner",
      ]);
      expect(idsIn(await read("/api/organization/folders", CLI))).toEqual([FOLDER_A]);
      const audit = await read("/api/organization/audit", CLI);
      expect(
        Array.isArray(audit)
          ? audit.map((row: unknown) => field(row, "event", "organizationId"))
          : audit,
      ).toEqual([A]);
      const listed = await read("/api/account/organizations", CLI);
      expect(
        Array.isArray(listed)
          ? listed.flatMap((row: unknown) =>
              field(row, "active") === true ? [field(row, "organization", "id")] : [],
            )
          : listed,
      ).toEqual([A]);
    });

    it("switching back is the same route, and the web sign-in sees A again", async () => {
      expect((await switchTo(A)).status).toBe(200);
      expect(idsIn(await read("/api/projects"))).toEqual([sharedA.project]);
      expect((await switchTo(B)).status).toBe(200);
    });
  });

  it("switching to an organization the account is not in answers 404 and changes nothing", async () => {
    const before = await call("bob", "GET", "/api/projects");
    const refused = await call("bob", "PUT", "/api/account/organizations/active", {
      organizationId: A,
    });
    const unknown = await call("bob", "PUT", "/api/account/organizations/active", {
      organizationId: "org-nope",
    });
    expect([refused.status, unknown.status]).toEqual([404, 404]);
    expect(await call("bob", "GET", "/api/projects")).toEqual(before);
    expect(idsIn(before.body)).toEqual([sharedB.project]);
  });
});

describe("a switch's announcement on the event bus", () => {
  it("ends the event stream of the sign-in that switched, and nobody else's", async () => {
    const erin = await api.events("erin");
    const alice = await api.events("alice");
    await api.notify({ type: "sign-in-organization", userId: "erin", credential: "session:erin" });
    expect(await erin.next(1_000)).toContain('"type":"sign-in-organization"');
    await api.notify({ type: "user", userId: "erin", facet: "accounts" });
    await api.notify({ type: "user", userId: "alice", facet: "accounts" });
    expect(await erin.next(300)).toBeNull();
    expect(await alice.next(1_000)).toContain('"userId":"alice"');
    await erin.close();
    await alice.close();
  });

  it("leaving another organization leaves the stream of the one a sign-in acts in alone", async () => {
    const erin = await api.events("erin");
    await api.notify({ type: "user", userId: "erin", facet: "access", organizationId: A });
    await api.notify({ type: "user", userId: "erin", facet: "accounts" });
    expect(await erin.next(1_000)).toContain('"facet":"accounts"');
    await erin.close();
  });
});
