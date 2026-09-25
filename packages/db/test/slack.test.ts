import { PgClient } from "@effect/sql-pg";
import { OrganizationId, ProjectId, SessionId, Sha, WorktreeId } from "@mend/domain";
import type { SlackPendingMention } from "@mend/domain/workbench";
import { Effect, Layer, Redacted } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { SessionsRepo, SessionsRepoLive } from "../src/repos/agent-sessions.ts";
import { SlackDefaultsRepo, SlackDefaultsRepoLive } from "../src/repos/slack-defaults.ts";
import {
  SLACK_EVENT_CLAIM_RETENTION_MS,
  SlackEventClaimsRepo,
  SlackEventClaimsRepoLive,
} from "../src/repos/slack-event-claims.ts";
import {
  type NewSlackInstall,
  SlackInstallsRepo,
  SlackInstallsRepoLive,
} from "../src/repos/slack-installs.ts";
import {
  hashSlackLinkCode,
  mintSlackLinkCode,
  SLACK_LINK_CODE_TTL_MS,
  SlackLinksRepo,
  SlackLinksRepoLive,
} from "../src/repos/slack-links.ts";
import { SlackThreadsRepo, SlackThreadsRepoLive } from "../src/repos/slack-threads.ts";

describe("slack link codes", () => {
  it("mints recognisable, url-safe codes and stores only a hash", () => {
    const code = mintSlackLinkCode();
    expect(code).toMatch(/^msl_[A-Za-z0-9_-]{43}$/);
    expect(hashSlackLinkCode(code)).toHaveLength(64);
    expect(hashSlackLinkCode(code)).not.toContain(code);
    expect(mintSlackLinkCode()).not.toBe(code);
  });
});

/**
 * The real statements against the dev Postgres (`compose.dev.yaml`, :5434) in a throwaway database.
 * Without one reachable these skip rather than pretend; set MEND_TEST_DATABASE_URL elsewhere.
 */
const ADMIN_URL =
  process.env["MEND_TEST_DATABASE_URL"] ?? "postgres://mend:mend@localhost:5434/mend";
const SCRATCH_DB = `mend_slack_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const reposLayer = Layer.mergeAll(
  SlackInstallsRepoLive,
  SlackLinksRepoLive,
  SlackDefaultsRepoLive,
  SlackThreadsRepoLive,
  SlackEventClaimsRepoLive,
  SessionsRepoLive,
).pipe(Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))));

type Repos =
  | SlackInstallsRepo
  | SlackLinksRepo
  | SlackDefaultsRepo
  | SlackThreadsRepo
  | SlackEventClaimsRepo
  | SessionsRepo
  | SqlClient.SqlClient
  | PgClient.PgClient;

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, Repos>) =>
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

const OTHER = OrganizationId.make("org-other");
const PROJECT = ProjectId.make("p-api");
const WORKTREE = WorktreeId.make("wt-1");

const mention = (text: string): SlackPendingMention => ({
  channelId: "C-GENERAL",
  messageTs: "1726000000.000100",
  threadTs: null,
  text,
});

describe.skipIf(!reachable)("slack in Postgres", () => {
  // The default organization the migrations create; Alice owns it and Bob is a member.
  let ACME = OrganizationId.make("");
  const installFor = (overrides: Partial<NewSlackInstall> = {}): NewSlackInstall => ({
    organizationId: ACME,
    teamId: "T-ACME",
    teamName: "Acme",
    botUserId: "B-MEND",
    appId: "A-MEND",
    sealedAppToken: "sealed:app:1",
    sealedBotToken: "sealed:bot:1",
    webOrigin: "https://mend.acme.example",
    installedByUserId: "alice",
    ...overrides,
  });

  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    ACME = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.forEach(ORDERED, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO "user" ("id", "name", "email", "createdAt") VALUES
            ('alice', 'Alice', 'alice@example.com', '2026-01-01T00:00:00Z'),
            ('bob', 'Bob', 'bob@example.com', '2026-01-02T00:00:00Z'),
            ('carol', 'Carol', 'carol@example.com', '2026-01-03T00:00:00Z')`;
        const [organization] = yield* sql<{ readonly id: string }>`SELECT id FROM organizations`;
        const acme = OrganizationId.make(organization?.id ?? "");
        yield* sql`INSERT INTO organizations (id, name) VALUES (${OTHER}, 'Other')`;
        yield* sql`
          INSERT INTO organization_members (organization_id, user_id, role) VALUES
            (${acme}, 'alice', 'owner'),
            (${acme}, 'bob', 'member'),
            (${OTHER}, 'carol', 'owner')`;
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id, visibility)
          VALUES (${PROJECT}, 'api', '/store/p-api/repo.git', 'main', ${acme}, 'shared')`;
        yield* sql`
          INSERT INTO worktrees (id, project_id, name, directory, branch, base_sha)
          VALUES (${WORKTREE}, ${PROJECT}, 'one', 'one', 'mend/one', 'abc')`;
        return acme;
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

  it("installs once per organization, keeps a workspace's links across a token change, and starts over for another workspace", async () => {
    await run(
      Effect.gen(function* () {
        const installs = yield* SlackInstallsRepo;
        const links = yield* SlackLinksRepo;
        const defaults = yield* SlackDefaultsRepo;

        const first = yield* installs.save(installFor());
        expect(first.previous).toBeNull();
        expect(first.install.settings).toEqual({
          defaultHarness: "claude",
          showAgentMessages: true,
          showDiffs: false,
          externalChannels: false,
          landAutomatically: true,
        });
        yield* installs.updateSettings(ACME, {
          defaultHarness: "codex",
          showAgentMessages: false,
          showDiffs: true,
          externalChannels: false,
          landAutomatically: false,
        });
        const { code } = yield* links.mintCode({
          teamId: "T-ACME",
          slackUserId: "U-BOB",
          request: mention("fix it"),
        });
        yield* links.redeemCode({ code, userId: "bob" });
        yield* defaults.setChannelDefault({
          teamId: "T-ACME",
          channelId: "C-GENERAL",
          projectId: PROJECT,
          setByUserId: "bob",
        });

        // New tokens for the same workspace: the settings, links and defaults stay.
        const rotated = yield* installs.save(
          installFor({ sealedBotToken: "sealed:bot:2", installedByUserId: "alice" }),
        );
        expect(rotated.previous?.sealedBotToken).toBe("sealed:bot:1");
        expect(rotated.install.sealedBotToken).toBe("sealed:bot:2");
        expect(rotated.install.settings.defaultHarness).toBe("codex");
        expect(rotated.install.settings.landAutomatically).toBe(false);
        expect(rotated.install.createdAt).toEqual(first.install.createdAt);
        expect(yield* links.bySlackUser("T-ACME", "U-BOB")).toMatchObject({ userId: "bob" });
        expect(yield* defaults.channelDefault("T-ACME", "C-GENERAL")).not.toBeNull();

        // Another organization cannot claim the workspace, and its refusal changes nothing.
        const taken = yield* installs
          .save(installFor({ organizationId: OTHER, installedByUserId: "carol" }))
          .pipe(Effect.flip);
        expect(taken._tag).toBe("SlackTeamTakenError");
        expect(yield* installs.byOrganization(OTHER)).toBeNull();

        // Another workspace: the old one's links and channel defaults go with it.
        const moved = yield* installs.save(installFor({ teamId: "T-NEW", teamName: "Acme 2" }));
        expect(moved.previous?.teamId).toBe("T-ACME");
        expect(moved.install.settings.defaultHarness).toBe("claude");
        expect(moved.install.settings.landAutomatically).toBe(true);
        expect(yield* links.listForOrganization(ACME)).toEqual([]);
        expect(yield* defaults.channelDefault("T-ACME", "C-GENERAL")).toBeNull();
        expect(yield* installs.byTeam("T-ACME")).toBeNull();

        // Now the old workspace is free for someone else.
        yield* installs.save(
          installFor({ organizationId: OTHER, teamId: "T-ACME", installedByUserId: "carol" }),
        );
        expect((yield* installs.list()).map((install) => install.teamId)).toEqual([
          "T-NEW",
          "T-ACME",
        ]);

        const removed = yield* installs.remove(OTHER);
        expect(removed?.teamId).toBe("T-ACME");
        expect(yield* installs.remove(OTHER)).toBeNull();
        const missing = yield* installs
          .updateSettings(OTHER, first.install.settings)
          .pipe(Effect.flip);
        expect(missing._tag).toBe("SlackInstallNotFoundError");
        yield* installs.remove(ACME);
      }),
    );
  });

  it("spends a link code exactly once, however many redeem it at the same moment", async () => {
    await run(
      Effect.gen(function* () {
        const installs = yield* SlackInstallsRepo;
        const links = yield* SlackLinksRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* installs.save(installFor());

        const { code, expiresAt } = yield* links.mintCode({
          teamId: "T-ACME",
          slackUserId: "U-ALICE",
          request: mention("fix the flaky login test"),
        });
        const stored = yield* sql<{ readonly code_hash: string }>`
          SELECT code_hash FROM slack_link_codes`;
        expect(stored.map((row) => row.code_hash)).toEqual([hashSlackLinkCode(code)]);
        expect(yield* links.peekCode(code)).toEqual({
          organizationId: ACME,
          teamId: "T-ACME",
          teamName: "Acme",
          slackUserId: "U-ALICE",
          request: mention("fix the flaky login test"),
          expiresAt,
        });

        const outcomes = yield* Effect.all(
          Array.from({ length: 16 }, () => links.redeemCode({ code, userId: "alice" })),
          { concurrency: "unbounded" },
        );
        const winners = outcomes.flatMap((outcome) => (outcome === null ? [] : [outcome]));
        expect(winners).toHaveLength(1);
        expect(winners[0]?.request.text).toBe("fix the flaky login test");
        expect(winners[0]?.link).toMatchObject({
          organizationId: ACME,
          teamId: "T-ACME",
          slackUserId: "U-ALICE",
          userId: "alice",
        });
        expect(yield* links.peekCode(code)).toBeNull();
        expect(yield* links.bySlackUser("T-ACME", "U-ALICE")).toMatchObject({ userId: "alice" });
        expect((yield* links.listForUser("alice")).map((link) => link.slackUserId)).toEqual([
          "U-ALICE",
        ]);
        yield* installs.remove(ACME);
      }),
    );
  });

  it("refuses an expired code, and an account outside the organization without spending the code", async () => {
    await run(
      Effect.gen(function* () {
        const installs = yield* SlackInstallsRepo;
        const links = yield* SlackLinksRepo;
        yield* installs.save(installFor());
        const now = new Date("2026-09-22T10:00:00.000Z");
        const at = (ms: number) => new Date(now.getTime() + ms);

        const { code } = yield* links.mintCode({
          teamId: "T-ACME",
          slackUserId: "U-BOB",
          request: mention("hello"),
          now,
        });
        expect(yield* links.peekCode(code, at(SLACK_LINK_CODE_TTL_MS))).toBeNull();
        expect(
          yield* links.redeemCode({ code, userId: "bob", now: at(SLACK_LINK_CODE_TTL_MS) }),
        ).toBeNull();

        const outsider = yield* links
          .redeemCode({ code, userId: "carol", now: at(1) })
          .pipe(Effect.flip);
        expect(outsider._tag).toBe("SlackLinkNotMemberError");
        expect(yield* links.bySlackUser("T-ACME", "U-BOB")).toBeNull();
        // Still unspent: the right person can use it.
        expect(yield* links.redeemCode({ code, userId: "bob", now: at(2) })).not.toBeNull();
        expect(yield* links.redeemCode({ code, userId: "bob", now: at(3) })).toBeNull();
        expect(yield* links.redeemCode({ code: mintSlackLinkCode(), userId: "bob" })).toBeNull();
        yield* installs.remove(ACME);
      }),
    );
  });

  it("replaces either side's earlier link, and forgets a member who leaves", async () => {
    await run(
      Effect.gen(function* () {
        const installs = yield* SlackInstallsRepo;
        const links = yield* SlackLinksRepo;
        const sql = yield* SqlClient.SqlClient;
        yield* installs.save(installFor());
        const linkAs = (slackUserId: string, userId: string) =>
          links
            .mintCode({ teamId: "T-ACME", slackUserId, request: mention("hi") })
            .pipe(Effect.flatMap(({ code }) => links.redeemCode({ code, userId })));

        expect((yield* linkAs("U-1", "bob"))?.replaced).toEqual([]);
        // Bob links another Slack user: his first link goes, and the redeem names it.
        const again = yield* linkAs("U-2", "bob");
        expect(again?.replaced.map((link) => `${link.slackUserId}:${link.userId}`)).toEqual([
          "U-1:bob",
        ]);
        // Alice links the Slack user Bob had: it is hers now, and Bob's link is named as replaced.
        const taken = yield* linkAs("U-2", "alice");
        expect(taken?.replaced).toMatchObject([
          { organizationId: ACME, teamId: "T-ACME", slackUserId: "U-2", userId: "bob" },
        ]);
        yield* linkAs("U-3", "bob");
        const pairs = (yield* links.listForOrganization(ACME))
          .map((link) => `${link.slackUserId}:${link.userId}`)
          .toSorted();
        expect(pairs).toEqual(["U-2:alice", "U-3:bob"]);

        expect((yield* links.unlink("T-ACME", "U-2"))?.userId).toBe("alice");
        expect(yield* links.unlink("T-ACME", "U-2")).toBeNull();

        yield* sql`DELETE FROM organization_members WHERE user_id = 'bob'`;
        expect(yield* links.listForOrganization(ACME)).toEqual([]);
        yield* sql`
          INSERT INTO organization_members (organization_id, user_id, role)
          VALUES (${ACME}, 'bob', 'member')`;
        yield* installs.remove(ACME);
      }),
    );
  });

  it("keeps a channel's default and a person's default", async () => {
    await run(
      Effect.gen(function* () {
        const installs = yield* SlackInstallsRepo;
        const defaults = yield* SlackDefaultsRepo;
        yield* installs.save(installFor());

        expect(yield* defaults.channelDefault("T-ACME", "C-1")).toBeNull();
        yield* defaults.setChannelDefault({
          teamId: "T-ACME",
          channelId: "C-1",
          projectId: PROJECT,
          setByUserId: "bob",
        });
        const replaced = yield* defaults.setChannelDefault({
          teamId: "T-ACME",
          channelId: "C-1",
          projectId: PROJECT,
          setByUserId: "alice",
        });
        expect(replaced).toMatchObject({ projectId: PROJECT, setByUserId: "alice" });
        expect(yield* defaults.channelDefault("T-ACME", "C-1")).toMatchObject({
          setByUserId: "alice",
        });
        expect(yield* defaults.clearChannelDefault("T-ACME", "C-1")).toBe(true);
        expect(yield* defaults.clearChannelDefault("T-ACME", "C-1")).toBe(false);

        expect(yield* defaults.personalDefault("bob")).toBeNull();
        yield* defaults.setPersonalDefault("bob", PROJECT);
        yield* defaults.setPersonalDefault("bob", PROJECT);
        expect(yield* defaults.personalDefault("bob")).toBe(PROJECT);
        yield* defaults.setPersonalDefault("bob", null);
        expect(yield* defaults.personalDefault("bob")).toBeNull();
        yield* installs.remove(ACME);
      }),
    );
  });

  it("records where a session came from, and follows up a thread's most recent session", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const threads = yield* SlackThreadsRepo;
        const newSession = (id: string, origin: "mend" | "slack") =>
          sessions.create({
            id: SessionId.make(id),
            projectId: PROJECT,
            worktreeId: WORKTREE,
            harness: "claude",
            label: null,
            worktree: "one",
            branch: "mend/one",
            baseSha: Sha.make("abc"),
            baseRef: "main",
            contextSnapshotId: null,
            ownerUserId: "alice",
            origin,
          });
        const fromWeb = yield* newSession("s-web", "mend");
        const first = yield* newSession("s-slack-1", "slack");
        const second = yield* newSession("s-slack-2", "slack");
        expect(fromWeb.origin).toBe("mend");
        expect(first.origin).toBe("slack");
        expect((yield* sessions.byId(second.id)).origin).toBe("slack");

        const thread = { teamId: "T-ACME", channelId: "C-1", threadTs: "1726000000.000100" };
        expect(yield* threads.latestInThread(thread)).toBeNull();
        yield* threads.record({
          ...thread,
          sessionId: first.id,
          requestTs: "1726000000.000100",
          slackUserId: "U-ALICE",
          projectSource: "thread-link",
          external: false,
        });
        yield* threads.record({
          ...thread,
          sessionId: second.id,
          requestTs: "1726000100.000200",
          slackUserId: "U-ALICE",
          projectSource: "thread-session",
          external: true,
        });
        expect((yield* threads.latestInThread(thread))?.sessionId).toBe(second.id);
        expect(yield* threads.latestInThread({ ...thread, channelId: "C-2" })).toBeNull();

        expect(yield* threads.forSession(fromWeb.id)).toBeNull();
        expect(yield* threads.forSession(first.id)).toMatchObject({
          projectSource: "thread-link",
          statusTs: null,
          external: false,
          reportedState: null,
          reportedStatus: null,
        });
        // Nothing to move before the status message exists.
        const running = { state: "running", line: "api · running" } as const;
        expect(yield* threads.claimStatus(first.id, null, running)).toBe(false);
        yield* threads.setStatusTs(first.id, "1726000001.000300", {
          state: "starting",
          line: "api · starting",
        });
        expect(yield* threads.forSession(first.id)).toMatchObject({
          statusTs: "1726000001.000300",
          reportedState: "starting",
          reportedStatus: "api · starting",
        });
        // Two workers saw the same move: one edits the message.
        const moves = yield* Effect.all(
          Array.from({ length: 8 }, () => threads.claimStatus(first.id, "api · starting", running)),
          { concurrency: "unbounded" },
        );
        expect(moves.filter(Boolean)).toHaveLength(1);
        // A worker that read the old line cannot move it back.
        expect(
          yield* threads.claimStatus(first.id, "api · starting", {
            state: "starting",
            line: "api · starting",
          }),
        ).toBe(false);
        expect((yield* threads.forSession(first.id))?.reportedState).toBe("running");

        const posts = yield* Effect.all(
          Array.from({ length: 8 }, () => threads.claimPost(first.id, "turn:t-1")),
          { concurrency: "unbounded" },
        );
        expect(posts.filter(Boolean)).toHaveLength(1);
        expect(yield* threads.claimPost(first.id, "turn:t-2")).toBe(true);
        expect(yield* threads.claimPost(second.id, "turn:t-1")).toBe(true);

        const twice = yield* threads
          .record({
            ...thread,
            sessionId: first.id,
            requestTs: "1726000200.000100",
            slackUserId: "U-ALICE",
            projectSource: "message",
            external: false,
          })
          .pipe(Effect.exit);
        expect(twice._tag).toBe("Failure");
      }),
    );
  });

  it("lists the sessions a person started from one Slack workspace, newest first", async () => {
    await run(
      Effect.gen(function* () {
        const sessions = yield* SessionsRepo;
        const threads = yield* SlackThreadsRepo;
        const started = (id: string, owner: string, teamId: string, requestTs: string) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({
              id: SessionId.make(id),
              projectId: PROJECT,
              worktreeId: WORKTREE,
              harness: "codex",
              label: id === "s-list-2" ? "retry storm" : null,
              worktree: "one",
              branch: "mend/one",
              baseSha: Sha.make("abc"),
              baseRef: "main",
              contextSnapshotId: null,
              ownerUserId: owner,
              origin: "slack",
            });
            yield* threads.record({
              sessionId: session.id,
              teamId,
              channelId: "C-LIST",
              threadTs: requestTs,
              requestTs,
              slackUserId: owner === "alice" ? "U-ALICE" : "U-BOB",
              projectSource: "channel-default",
              external: false,
            });
          });
        yield* started("s-list-1", "alice", "T-LIST", "1726100000.000100");
        yield* started("s-list-2", "alice", "T-LIST", "1726100100.000100");
        yield* started("s-list-3", "bob", "T-LIST", "1726100200.000100");
        yield* started("s-list-4", "alice", "T-ELSEWHERE", "1726100300.000100");

        const listed = yield* threads.listForOwner({
          teamId: "T-LIST",
          ownerUserId: "alice",
          limit: 10,
        });
        expect(listed.map((row) => row.sessionId)).toEqual(["s-list-2", "s-list-1"]);
        expect(listed[0]).toMatchObject({
          projectId: PROJECT,
          label: "retry storm",
          harness: "codex",
          branch: "mend/one",
          status: "starting",
          channelId: "C-LIST",
          requestTs: "1726100100.000100",
        });
        expect(
          yield* threads.listForOwner({ teamId: "T-LIST", ownerUserId: "alice", limit: 1 }),
        ).toHaveLength(1);
      }),
    );
  });

  it("lets exactly one of many racing workers claim an event, and sweeps old claims", async () => {
    await run(
      Effect.gen(function* () {
        const claims = yield* SlackEventClaimsRepo;
        const now = new Date("2026-09-22T10:00:00.000Z");
        const outcomes = yield* Effect.all(
          Array.from({ length: 16 }, () =>
            claims.claim({ eventId: "Ev-1", teamId: "T-ACME", now }),
          ),
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect(yield* claims.claim({ eventId: "Ev-1", teamId: "T-ACME", now })).toBe(false);

        const later = new Date(now.getTime() + SLACK_EVENT_CLAIM_RETENTION_MS + 1);
        expect(yield* claims.claim({ eventId: "Ev-2", teamId: "T-ACME", now: later })).toBe(true);
        expect(
          yield* claims.sweep(new Date(later.getTime() - SLACK_EVENT_CLAIM_RETENTION_MS)),
        ).toBe(1);
        // Swept, so it could be claimed again; Slack does not redeliver that late.
        expect(yield* claims.claim({ eventId: "Ev-1", teamId: "T-ACME", now: later })).toBe(true);
        expect(yield* claims.claim({ eventId: "Ev-2", teamId: "T-ACME", now: later })).toBe(false);
      }),
    );
  });
});
