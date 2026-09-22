import { NotFound, slackGroup } from "@mend/api-contracts";
import { Auth } from "@mend/auth";
import {
  AuditEventsRepo,
  OrganizationsRepo,
  SlackDefaultsRepo,
  SlackInstallsRepo,
  SlackLinkNotMemberError,
  SlackLinksRepo,
  SlackTeamTakenError,
  UserFacts,
  UsersRepo,
  type NewAuditEvent,
  type OrganizationMembership,
  type SealedSlackInstall,
  type SlackLink,
} from "@mend/db";
import { OrganizationId, ProjectId } from "@mend/domain";
import {
  Organization,
  type SlackLinkedMentionJob,
  type SlackPendingMention,
} from "@mend/domain/workbench";
import { JobRunner, type JobSpec } from "@mend/jobs";
import { makePublicNetwork, NetworkConfig, PublicOrigin } from "@mend/network";
import { makeFakeSlack, SlackApiError, type FakeSlackWorkspace } from "@mend/slack/client";
import { SecretCipher } from "@mend/store";
import { Effect, Layer, ManagedRuntime, Option, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { makeProject } from "../../test/support/tenancy-harness.ts";
import { ProjectAccess } from "../access.ts";
import { AuthMiddlewareLive } from "./api-live.ts";
import { changedSettings, slackFailure, SlackGroupLive, tokenProblem } from "./slack.ts";

const NOW = new Date("2026-09-22T10:00:00.000Z");
const organization = (id: string, name: string) =>
  new Organization({
    id: OrganizationId.make(id),
    name,
    createdByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
const acme = organization("org-acme", "Acme");
const globex = organization("org-globex", "Globex");

/** alice owns Acme, carol is a member there; gus owns Globex; dave belongs nowhere. */
const members: Record<
  string,
  { readonly organization: Organization; readonly role: "owner" | "member" } | undefined
> = {
  alice: { organization: acme, role: "owner" },
  carol: { organization: acme, role: "member" },
  gus: { organization: globex, role: "owner" },
};

const acmeSlack: FakeSlackWorkspace = {
  teamId: "T-acme",
  teamName: "Acme HQ",
  appId: "A-acme",
  botId: "B-acme",
  botUserId: "U-bot",
  botToken: "xoxb-acme",
  appToken: "xapp-acme",
  users: [
    {
      id: "U-carol",
      teamId: "T-acme",
      name: "carol",
      displayName: "Carol",
      realName: "Carol Danvers",
      isBot: false,
      deleted: false,
    },
  ],
};
/** A second app in the same workspace: its app token belongs to another app. */
const otherApp: FakeSlackWorkspace = {
  ...acmeSlack,
  appId: "A-other",
  botId: "B-other",
  botToken: "xoxb-other",
  appToken: "xapp-other",
};
const slack = makeFakeSlack([acmeSlack, otherApp]);

// ─── An in-memory Slack store, as the repositories promise it ──────────────

const installs = new Map<OrganizationId, SealedSlackInstall>();
const links: Array<SlackLink> = [];
const codes = new Map<
  string,
  {
    readonly teamId: string;
    readonly slackUserId: string;
    readonly request: SlackPendingMention;
    readonly expiresAt: Date;
    spent: boolean;
  }
>();
const personalDefaults = new Map<string, ProjectId>();
const audited: Array<NewAuditEvent> = [];
const enqueued: Array<JobSpec> = [];

const installOfTeam = (teamId: string) =>
  [...installs.values()].find((install) => install.teamId === teamId) ?? null;

const installsLayer = Layer.mock(SlackInstallsRepo, {
  byOrganization: (organizationId) => Effect.succeed(installs.get(organizationId) ?? null),
  byTeam: (teamId) => Effect.succeed(installOfTeam(teamId)),
  save: (install) =>
    Effect.suspend(() => {
      const holder = installOfTeam(install.teamId);
      if (holder !== null && holder.organizationId !== install.organizationId) {
        return Effect.fail(new SlackTeamTakenError({ teamId: install.teamId }));
      }
      const previous = installs.get(install.organizationId) ?? null;
      const saved: SealedSlackInstall = {
        ...install,
        settings:
          previous !== null && previous.teamId === install.teamId
            ? previous.settings
            : {
                defaultHarness: "claude",
                showAgentMessages: true,
                showDiffs: false,
                externalChannels: false,
              },
        createdAt: previous?.createdAt ?? NOW,
        updatedAt: NOW,
      };
      installs.set(install.organizationId, saved);
      return Effect.succeed({ install: saved, previous });
    }),
  updateSettings: (organizationId, settings) =>
    Effect.sync(() => {
      const current = installs.get(organizationId);
      if (current === undefined) throw new Error("no install");
      const updated = { ...current, settings };
      installs.set(organizationId, updated);
      return updated;
    }),
  remove: (organizationId) =>
    Effect.sync(() => {
      const current = installs.get(organizationId) ?? null;
      installs.delete(organizationId);
      return current;
    }),
});

const removeLinks = (keep: (link: SlackLink) => boolean) => {
  const kept = links.filter(keep);
  links.splice(0, links.length, ...kept);
};

const linksLayer = Layer.mock(SlackLinksRepo, {
  listForUser: (userId) => Effect.succeed(links.filter((link) => link.userId === userId)),
  listForOrganization: (organizationId) =>
    Effect.succeed(links.filter((link) => link.organizationId === organizationId)),
  unlink: (teamId, slackUserId) =>
    Effect.sync(() => {
      const found = links.find(
        (link) => link.teamId === teamId && link.slackUserId === slackUserId,
      );
      removeLinks((link) => link !== found);
      return found ?? null;
    }),
  peekCode: (code) =>
    Effect.sync(() => {
      const found = codes.get(code);
      const install = found === undefined ? null : installOfTeam(found.teamId);
      if (found === undefined || found.spent || install === null) return null;
      return {
        organizationId: install.organizationId,
        teamId: found.teamId,
        teamName: install.teamName,
        slackUserId: found.slackUserId,
        request: found.request,
        expiresAt: found.expiresAt,
      };
    }),
  redeemCode: ({ code, userId }) =>
    Effect.suspend(() => {
      const found = codes.get(code);
      const install = found === undefined ? null : installOfTeam(found.teamId);
      if (found === undefined || found.spent || install === null) return Effect.succeed(null);
      if (members[userId]?.organization.id !== install.organizationId) {
        return Effect.fail(new SlackLinkNotMemberError({ teamId: found.teamId, userId }));
      }
      found.spent = true;
      removeLinks(
        (link) =>
          link.teamId !== found.teamId ||
          (link.slackUserId !== found.slackUserId && link.userId !== userId),
      );
      const link: SlackLink = {
        organizationId: install.organizationId,
        teamId: found.teamId,
        slackUserId: found.slackUserId,
        userId,
        createdAt: NOW,
      };
      links.push(link);
      return Effect.succeed({ link, request: found.request });
    }),
});

const defaultsLayer = Layer.mock(SlackDefaultsRepo, {
  personalDefault: (userId) => Effect.succeed(personalDefaults.get(userId) ?? null),
  setPersonalDefault: (userId, projectId) =>
    Effect.sync(() => {
      if (projectId === null) personalDefaults.delete(userId);
      else personalDefaults.set(userId, projectId);
    }),
});

/** carol sees the shared project; nobody sees the private one but its creator, alice. */
const visible: Record<string, ReadonlySet<string>> = {
  alice: new Set(["p-shared", "p-private"]),
  carol: new Set(["p-shared"]),
};

const dependencies = Layer.mergeAll(
  Layer.succeed(Auth, {
    handler: () => Effect.succeed(new Response(null, { status: 404 })),
    issuePasswordReset: () => Effect.die("unused"),
    getSession: (headers) => {
      const user = headers.get("authorization")?.replace("Bearer ", "") ?? "";
      return Effect.succeed(
        user === ""
          ? Option.none()
          : Option.some({
              user: { id: user, email: `${user}@example.invalid`, name: user },
              expiresAt: new Date("2026-09-23T10:00:00Z"),
            }),
      );
    },
  }),
  Layer.mock(OrganizationsRepo, {
    membershipOf: (userId) => {
      const found = members[userId];
      const membership: OrganizationMembership | null =
        found === undefined
          ? null
          : { organization: found.organization, role: found.role, joinedAt: NOW };
      return Effect.succeed(membership);
    },
  }),
  Layer.mock(UsersRepo, {
    byId: (id) =>
      Effect.succeed(
        members[id] === undefined
          ? null
          : new UserFacts({ id, name: id, email: `${id}@example.invalid` }),
      ),
  }),
  Layer.mock(AuditEventsRepo, {
    record: (event) => Effect.sync(() => void audited.push(event)),
  }),
  Layer.mock(JobRunner, {
    enqueue: (job) => Effect.sync(() => (enqueued.push(job), "job-1")),
  }),
  Layer.mock(ProjectAccess, {
    projectAs: (userId, id) =>
      visible[userId]?.has(id) === true
        ? Effect.succeed(
            makeProject({
              id,
              organizationId: acme.id,
              visibility: id === "p-private" ? "private" : "shared",
              createdByUserId: "alice",
              storePath: `/store/${id}/repo.git`,
            }),
          )
        : Effect.fail(new NotFound({ id })),
  }),
  Layer.succeed(SecretCipher, {
    encrypt: (plaintext) => Effect.succeed(`sealed(${plaintext.length})`),
    decrypt: () => Effect.succeed(acmeSlack.botToken),
  }),
  Layer.succeed(
    NetworkConfig,
    makePublicNetwork(Schema.decodeUnknownSync(PublicOrigin)("https://mend.acme.test"), [
      Schema.decodeUnknownSync(PublicOrigin)("https://phone.acme.test"),
    ]),
  ),
  slack.layer,
  installsLayer,
  linksLayer,
  defaultsLayer,
);
const api = HttpApi.make("mend").add(slackGroup).prefix("/api");
const apiLayer = HttpApiBuilder.layer(api).pipe(
  Layer.provide(SlackGroupLive),
  Layer.provide(AuthMiddlewareLive.pipe(Layer.provide(dependencies))),
  Layer.provide(HttpServer.layerServices),
);
const runtime = ManagedRuntime.make(dependencies);
const context = await runtime.runPromise(Effect.context<Layer.Success<typeof dependencies>>());
const { handler, dispose } = HttpRouter.toWebHandler(apiLayer, { disableLogger: true });

const call = (
  user: string | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const sent = new Headers(headers);
  if (user !== null) sent.set("authorization", `Bearer ${user}`);
  if (body !== undefined) sent.set("content-type", "application/json");
  return handler(
    new Request(`http://api.internal${path}`, {
      method,
      headers: sent,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    context,
  );
};

const connect = (appToken = "xapp-acme", botToken = "xoxb-acme", as = "alice") =>
  call(
    as,
    "PUT",
    "/api/organization/slack",
    { appToken, botToken },
    {
      origin: "https://phone.acme.test",
    },
  );

const mention: SlackPendingMention = {
  channelId: "C-eng",
  messageTs: "1726999999.000100",
  threadTs: "1726999000.000001",
  text: "<@U-bot> fix the flaky login test &amp; add a retry",
};

const mintCode = (code: string, slackUserId = "U-carol") =>
  codes.set(code, {
    teamId: "T-acme",
    slackUserId,
    request: mention,
    expiresAt: new Date("2026-09-22T10:10:00Z"),
    spent: false,
  });

afterAll(async () => {
  await dispose();
  await runtime.dispose();
});

beforeEach(() => {
  installs.clear();
  links.splice(0, links.length);
  codes.clear();
  personalDefaults.clear();
  audited.splice(0, audited.length);
  enqueued.splice(0, enqueued.length);
});

describe("the organization's Slack app (docs/adr/0006)", () => {
  it("is its owners' alone: a member or an outsider gets 404 and nothing moves", async () => {
    const attempts = [
      ["GET", "/api/organization/slack"],
      ["PUT", "/api/organization/slack", { appToken: "xapp-acme", botToken: "xoxb-acme" }],
      ["DELETE", "/api/organization/slack"],
      ["GET", "/api/organization/slack/manifest"],
      ["GET", "/api/organization/slack/links"],
    ] as const;
    for (const user of ["carol", "dave"]) {
      for (const [method, path, body] of attempts) {
        const response = await call(user, method, path, body);
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ id: "slack" });
      }
    }
    expect({ installs: installs.size, audited, slack: slack.calls }).toEqual({
      installs: 0,
      audited: [],
      slack: [],
    });
  });

  it("checks both tokens with Slack, seals them, and records the origin the owner used", async () => {
    const response = await connect();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      teamId: "T-acme",
      teamName: "Acme HQ",
      appId: "A-acme",
      botUserId: "U-bot",
      webOrigin: "https://phone.acme.test",
      installedByName: "alice",
      settings: { defaultHarness: "claude", showAgentMessages: true, showDiffs: false },
    });
    // Neither token, nor its sealed form, ever comes back.
    expect(text).not.toContain("xoxb");
    expect(text).not.toContain("xapp");
    expect(text).not.toContain("sealed");
    const stored = installs.get(acme.id);
    expect(stored?.sealedBotToken).toBe("sealed(9)");
    expect(stored?.sealedAppToken).toBe("sealed(9)");
    expect(audited.map((event) => [event.action, event.subjectType, event.subjectId])).toEqual([
      ["slack.installed", "slack", "T-acme"],
    ]);
  });

  it("never records an origin the configuration does not list", async () => {
    const response = await call(
      "alice",
      "PUT",
      "/api/organization/slack",
      { appToken: "xapp-acme", botToken: "xoxb-acme" },
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(200);
    expect(installs.get(acme.id)?.webOrigin).toBe("https://mend.acme.test");
  });

  it("refuses tokens of the wrong kind before asking Slack, and says which", async () => {
    const swapped = await connect("xoxb-acme", "xapp-acme");
    expect(swapped.status).toBe(422);
    await expect(swapped.json()).resolves.toMatchObject({
      _tag: "SlackRejected",
      message: expect.stringContaining("xapp-"),
    });
    expect(tokenProblem("xapp-1", "xoxp-1")).toContain("xoxb-");
    expect(tokenProblem("xapp-1", "xoxb-1")).toBeNull();
  });

  it("refuses a token Slack refuses, and two tokens of different apps", async () => {
    const refused = await connect("xapp-acme", "xoxb-revoked");
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toMatchObject({
      message: "Slack refused the bot token (invalid_auth).",
    });
    const mixed = await connect("xapp-other", "xoxb-acme");
    expect(mixed.status).toBe(422);
    await expect(mixed.json()).resolves.toMatchObject({
      message: expect.stringContaining("different Slack apps"),
    });
    expect(installs.size).toBe(0);
    expect(audited).toEqual([]);
  });

  it("tells a Slack that did not answer apart from a refusal", () => {
    const failure = slackFailure("bot token");
    expect(
      failure(new SlackApiError({ method: "auth.test", code: "http_503", message: "down" }))._tag,
    ).toBe("SlackUnavailable");
    expect(
      failure(new SlackApiError({ method: "auth.test", code: "missing_scope", message: "" }))
        .message,
    ).toBe("Slack answered missing_scope for the bot token.");
  });

  it("records a replacement, and refuses a workspace another organization holds", async () => {
    await connect();
    const again = await connect();
    expect(again.status).toBe(200);
    const taken = await connect("xapp-acme", "xoxb-acme", "gus");
    expect(taken.status).toBe(422);
    await expect(taken.json()).resolves.toMatchObject({
      message: expect.stringContaining("another organization"),
    });
    expect(audited.map((event) => [event.action, event.data])).toEqual([
      ["slack.installed", { teamName: "Acme HQ" }],
      ["slack.replaced", { teamName: "Acme HQ", previousTeamId: "T-acme", linksKept: true }],
    ]);
  });

  it("changes the display settings, records only what changed, and refuses an unknown harness", async () => {
    await connect();
    const settings = {
      defaultHarness: "codex",
      showAgentMessages: true,
      showDiffs: true,
      externalChannels: false,
    };
    const patched = await call("alice", "PATCH", "/api/organization/slack/settings", { settings });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({ settings });
    const unknown = await call("alice", "PATCH", "/api/organization/slack/settings", {
      settings: { ...settings, defaultHarness: "shell" },
    });
    expect(unknown.status).toBe(422);
    const unchanged = await call("alice", "PATCH", "/api/organization/slack/settings", {
      settings,
    });
    expect(unchanged.status).toBe(200);
    expect(audited.slice(1).map((event) => [event.action, event.data])).toEqual([
      ["slack.settings_changed", { defaultHarness: "codex", showDiffs: true }],
    ]);
    expect(
      changedSettings(settings, { ...settings, externalChannels: true, showAgentMessages: false }),
    ).toEqual({ showAgentMessages: false, externalChannels: true });
  });

  it("hands an owner the manifest to paste, with no URL in it", async () => {
    const response = await call("alice", "GET", "/api/organization/slack/manifest");
    expect(response.status).toBe(200);
    const body: { manifest: string; appTokenScope: string } = await response.json();
    expect(body.appTokenScope).toBe("connections:write");
    expect(body.manifest).toContain("app_mentions:read");
    expect(body.manifest).not.toMatch(/https?:\/\//);
  });

  it("removes the app with its links, and says so in the audit log", async () => {
    await connect();
    const removed = await call("alice", "DELETE", "/api/organization/slack");
    expect(removed.status).toBe(204);
    expect(installs.size).toBe(0);
    const again = await call("alice", "DELETE", "/api/organization/slack");
    expect(again.status).toBe(404);
    expect(audited.map((event) => event.action)).toEqual(["slack.installed", "slack.removed"]);
  });
});

describe("linking a Slack user to a Mend account (docs/adr/0006)", () => {
  it("shows who in which workspace is asking, and what runs once linked", async () => {
    await connect();
    mintCode("msl_one");
    const response = await call("carol", "POST", "/api/slack/link/preview", { code: "msl_one" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      teamName: "Acme HQ",
      slackUserId: "U-carol",
      slackUserName: "Carol",
      slackRealName: "Carol Danvers",
      requestText: "@mend fix the flaky login test & add a retry",
      replacesSlackUserId: null,
    });
  });

  it("does not show or accept a code to anyone outside the install's organization", async () => {
    await connect();
    mintCode("msl_one");
    for (const user of ["gus", "dave"]) {
      const preview = await call(user, "POST", "/api/slack/link/preview", { code: "msl_one" });
      const confirm = await call(user, "POST", "/api/slack/link/confirm", { code: "msl_one" });
      expect([preview.status, confirm.status]).toEqual([404, 404]);
    }
    expect({ spent: codes.get("msl_one")?.spent, links, enqueued }).toEqual({
      spent: false,
      links: [],
      enqueued: [],
    });
  });

  it("links once, then hands the waiting mention to the runner", async () => {
    await connect();
    mintCode("msl_one");
    const confirmed = await call("carol", "POST", "/api/slack/link/confirm", { code: "msl_one" });
    expect(confirmed.status).toBe(200);
    await expect(confirmed.json()).resolves.toMatchObject({
      link: { teamId: "T-acme", slackUserId: "U-carol", userId: "carol", userName: "carol" },
      requestQueued: true,
    });
    const job: SlackLinkedMentionJob = {
      organizationId: acme.id,
      teamId: "T-acme",
      slackUserId: "U-carol",
      userId: "carol",
      request: mention,
      linkedAt: NOW.toISOString(),
    };
    expect(enqueued).toEqual([
      {
        name: "slack-linked-mention",
        payload: job,
        idempotencyKey: "slack-linked-mention:T-acme:C-eng:1726999999.000100",
        retryLimit: 0,
      },
    ]);
    const spent = await call("carol", "POST", "/api/slack/link/confirm", { code: "msl_one" });
    expect(spent.status).toBe(404);
    expect(audited.slice(1).map((event) => [event.action, event.subjectId, event.data])).toEqual([
      ["slack.link_created", "carol", { teamId: "T-acme", slackUserId: "U-carol" }],
    ]);
  });

  it("says when confirming replaces the Slack user this account was linked to", async () => {
    await connect();
    mintCode("msl_one", "U-carol-old");
    await call("carol", "POST", "/api/slack/link/confirm", { code: "msl_one" });
    mintCode("msl_two");
    const preview = await call("carol", "POST", "/api/slack/link/preview", { code: "msl_two" });
    await expect(preview.json()).resolves.toMatchObject({ replacesSlackUserId: "U-carol-old" });
    await call("carol", "POST", "/api/slack/link/confirm", { code: "msl_two" });
    expect(links.map((link) => link.slackUserId)).toEqual(["U-carol"]);
    expect(audited.at(-1)?.data).toEqual({
      teamId: "T-acme",
      slackUserId: "U-carol",
      replacedSlackUserId: "U-carol-old",
    });
  });

  it("shows a person their link and default, and lets them unlink", async () => {
    await connect();
    mintCode("msl_one");
    await call("carol", "POST", "/api/slack/link/confirm", { code: "msl_one" });
    const me = await call("carol", "GET", "/api/slack/me");
    await expect(me.json()).resolves.toMatchObject({
      workspace: { teamId: "T-acme", teamName: "Acme HQ" },
      link: { slackUserId: "U-carol" },
      defaultProjectId: null,
    });
    const unlinked = await call("carol", "DELETE", "/api/slack/me/link");
    expect(unlinked.status).toBe(204);
    const again = await call("carol", "DELETE", "/api/slack/me/link");
    expect(again.status).toBe(404);
    expect(audited.at(-1)).toMatchObject({
      action: "slack.link_removed",
      subjectId: "carol",
      actorUserId: "carol",
    });
  });

  it("sets a default project only from the projects the person can see", async () => {
    const hidden = await call("carol", "PUT", "/api/slack/me/default-project", {
      projectId: "p-private",
    });
    expect(hidden.status).toBe(404);
    await expect(hidden.json()).resolves.toMatchObject({ id: "p-private" });
    expect(personalDefaults.size).toBe(0);
    const set = await call("carol", "PUT", "/api/slack/me/default-project", {
      projectId: "p-shared",
    });
    expect(set.status).toBe(200);
    await expect(set.json()).resolves.toMatchObject({ defaultProjectId: "p-shared" });
    const cleared = await call("carol", "PUT", "/api/slack/me/default-project", {
      projectId: null,
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      workspace: null,
      link: null,
      defaultProjectId: null,
    });
  });

  it("lets an owner see and remove anyone's link in the organization", async () => {
    await connect();
    mintCode("msl_one");
    await call("carol", "POST", "/api/slack/link/confirm", { code: "msl_one" });
    const listed = await call("alice", "GET", "/api/organization/slack/links");
    await expect(listed.json()).resolves.toMatchObject([
      { slackUserId: "U-carol", userName: "carol" },
    ]);
    const byMember = await call("carol", "DELETE", "/api/organization/slack/links/U-carol");
    expect(byMember.status).toBe(404);
    const removed = await call("alice", "DELETE", "/api/organization/slack/links/U-carol");
    expect(removed.status).toBe(204);
    const unknown = await call("alice", "DELETE", "/api/organization/slack/links/U-carol");
    expect(unknown.status).toBe(404);
    expect(audited.at(-1)).toMatchObject({
      action: "slack.link_removed",
      subjectId: "carol",
      actorUserId: "alice",
    });
  });
});
