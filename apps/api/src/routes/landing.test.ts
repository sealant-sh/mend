import type { NewAuditEvent, SessionGitOpRow } from "@mend/db";
import { ChangeLandingId, CheckpointId, SessionGitOpId, SessionId, Sha } from "@mend/domain";
import { ChangeLanding, type LandedPullRequest, Session } from "@mend/domain/workbench";
import {
  type BundleChangeInput,
  type LandInput,
  LandingNotStartedError,
  type LandingReport,
  PullRequestStepError,
} from "@mend/landing";
import { BundleTooLargeError, type ChangedFile } from "@mend/store";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import {
  CAROL_SESSION_IN_SHARED_A,
  NULL_OWNER_SESSION,
  ids,
  makeSession,
} from "../../test/support/tenancy-harness.ts";

/**
 * The landing routes (docs/adr/0007-landing.md) over the two-organization world: only the
 * change's owner lands or refreshes, anyone who can see the project reads the record and pulls
 * the bundle, and every landing and download is audited.
 */

const sharedA = ids("shared-a");
const NOW = new Date("2026-09-24T10:00:00Z");
/** Carol's session in alice's worktree, started after alice's: the change is still alice's. */
const CAROL_JOINED = SessionId.make("session-shared-a-carol-joined");
const carolJoined = new Session({
  ...makeSession(CAROL_JOINED, sharedA.project, sharedA.worktree, "carol"),
  createdAt: new Date("2026-09-18T10:00:00Z"),
});
const PUSHED = Sha.make("3f2a1c0000000000000000000000000000000000");
const CHECKPOINT = Sha.make("cccccccccccccccccccccccccccccccccccccccc");
const PR: LandedPullRequest = {
  number: 412,
  url: "https://github.com/acme/api/pull/412",
  state: "open",
  observedAt: NOW,
};

const landingRow = (overrides: Partial<ChangeLanding> = {}) =>
  new ChangeLanding({
    id: ChangeLandingId.make("landing-1"),
    changeId: sharedA.change,
    sessionId: sharedA.session,
    projectId: sharedA.project,
    checkpointId: CheckpointId.make("cp-3"),
    checkpointRef: "refs/mend/checkpoints/wt/3",
    checkpointSha: CHECKPOINT,
    commitSha: PUSHED,
    remoteBranch: "mend/shared-a",
    pushedSha: PUSHED,
    trigger: "manual",
    pullRequest: PR,
    outcome: "pull-request",
    message: null,
    userId: "alice",
    createdAt: NOW,
    ...overrides,
  });

const gitOp = (refUpdates: ReadonlyArray<string> | null): SessionGitOpRow => ({
  id: SessionGitOpId.make("op-1"),
  sessionId: sharedA.session,
  projectId: sharedA.project,
  host: "github.com",
  port: 22,
  kind: "push",
  command: "git-receive-pack 'acme/api.git'",
  authMode: "mend-key",
  refUpdates,
  exitCode: 0,
  startedAt: NOW,
  finishedAt: NOW,
});

/** What the fakes were asked and what they answer; reset before every test. */
interface State {
  lands: Array<{ readonly input: LandInput; readonly env: unknown }>;
  bundles: Array<BundleChangeInput>;
  audited: Array<NewAuditEvent>;
  report: LandingReport | LandingNotStartedError | null;
  bundle: "ok" | BundleTooLargeError;
  landings: Array<ChangeLanding>;
  refreshed: ChangeLanding | PullRequestStepError | null;
  unseen: number;
  sinceLanding: Array<ChangedFile>;
}

const fresh = (): State => ({
  lands: [],
  bundles: [],
  audited: [],
  report: null,
  bundle: "ok",
  landings: [],
  refreshed: null,
  unseen: 0,
  sinceLanding: [],
});

let state: State = fresh();

describe("landing routes", () => {
  let api: TenancyApi;

  beforeAll(async () => {
    api = await createTenancyApi(
      { bundleBytes: 4096, accountOriginChecksPerMinute: 2 },
      {
        sessions: [carolJoined],
        implement: {
          audit: {
            record: (event) =>
              Effect.sync(() => {
                state.audited.push(event);
              }),
          },
          landing: {
            land: (input) =>
              Effect.gen(function* () {
                // The push env resolves as the landing's step 3 would.
                const env = yield* input.remoteEnv.pipe(Effect.orElseSucceed(() => null));
                state.lands.push({ input, env });
                const report = state.report;
                if (report === null) return yield* Effect.die("no report scripted");
                if (report instanceof LandingNotStartedError) return yield* report;
                return report;
              }),
            bundle: (input) =>
              Effect.suspend(() => {
                state.bundles.push(input);
                return state.bundle === "ok"
                  ? Effect.succeed({
                      branch: "mend/shared-a",
                      base: Sha.make("0123456789abcdef"),
                      tip: PUSHED,
                      commits: 2,
                      bytes: new Uint8Array([35, 32, 118, 50]),
                    })
                  : Effect.fail(state.bundle);
              }),
            refreshPullRequest: () =>
              Effect.suspend(() => {
                const refreshed = state.refreshed;
                if (refreshed === null) return Effect.die("no refresh scripted");
                return refreshed instanceof PullRequestStepError
                  ? Effect.fail(refreshed)
                  : Effect.succeed(refreshed);
              }),
          },
          landings: {
            byId: (id) =>
              Effect.succeed(state.landings.find((landing) => landing.id === id) ?? null),
            listForChange: (changeId) =>
              Effect.succeed(state.landings.filter((landing) => landing.changeId === changeId)),
          },
          landingGit: {
            probe: (_place, input) =>
              Effect.succeed({
                remoteBranch: input.remoteBranch,
                remoteSha: input.sha,
                unseen: state.unseen,
                ahead: 0,
                holds: true,
              }),
          },
          reads: {
            changedFiles: () =>
              Effect.succeed({
                value: state.sinceLanding,
                stamp: {
                  source: "worktree",
                  captureN: null,
                  captureId: null,
                  seq: null,
                  kind: null,
                  partial: false,
                  observedAt: null,
                },
              }),
          },
          gitOps: {
            listForSession: (sessionId) =>
              Effect.succeed(
                sessionId === sharedA.session
                  ? [
                      gitOp([
                        `${"0".repeat(40)} 91bd2e4000000000000000000000000000000000 refs/heads/wip`,
                      ]),
                    ]
                  : [],
              ),
          },
        },
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });
  beforeEach(() => {
    api.world.calls.splice(0, api.world.calls.length);
    state = fresh();
  });

  const land = `/api/sessions/${sharedA.session}/land`;

  describe("POST /sessions/:id/land", () => {
    it("lands for the owner with their options, and audits it", async () => {
      state.report = { landing: landingRow(), pullRequest: { _tag: "opened", pullRequest: PR } };
      const response = await api.request("alice", "POST", land, {
        branch: " fix/login ",
        pullRequest: true,
        title: "Fix the login loop",
        body: "Closes #12",
      });
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({
        landing: { outcome: "pull-request", remoteBranch: "mend/shared-a" },
        pullRequest: { _tag: "opened", pullRequest: { number: 412, state: "open" } },
      });
      expect(state.lands).toHaveLength(1);
      expect(state.lands[0]?.input).toMatchObject({
        sessionId: sharedA.session,
        actorUserId: "alice",
        trigger: "manual",
        remoteBranch: "fix/login",
        pullRequest: true,
        title: "Fix the login loop",
        body: "Closes #12",
        webOrigin: "http://api.internal",
      });
      // The project's auth mode resolved for the owner: ambient ssh, pinned by the policy.
      expect(state.lands[0]?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
      expect(state.audited).toEqual([
        {
          organizationId: "org-A",
          actorUserId: "alice",
          action: "change.landed",
          subjectType: "change",
          subjectId: sharedA.change,
          data: {
            sessionId: sharedA.session,
            landingId: "landing-1",
            outcome: "pull-request",
            trigger: "manual",
            remoteBranch: "mend/shared-a",
            pushedSha: PUSHED,
            pullRequest: 412,
          },
        },
      ]);
    });

    it("keeps the previous branch and opens the pull request unless told otherwise", async () => {
      state.report = {
        landing: landingRow({ outcome: "pushed", pullRequest: null }),
        pullRequest: { _tag: "off" },
      };
      const response = await api.request("alice", "POST", land, {});
      expect(response.status).toBe(200);
      expect(state.lands[0]?.input).toMatchObject({
        remoteBranch: null,
        pullRequest: true,
        title: null,
        body: null,
      });
    });

    it("audits a refused landing too", async () => {
      state.report = {
        landing: landingRow({
          outcome: "refused",
          pushedSha: null,
          pullRequest: null,
          message: "[remote rejected] (protected branch hook declined)",
        }),
        pullRequest: { _tag: "not-reached" },
      };
      const response = await api.request("alice", "POST", land, {});
      expect(response.status).toBe(200);
      expect(state.audited[0]?.data).toMatchObject({ outcome: "refused", pushedSha: null });
    });

    it("refuses a teammate even under shared control, before anything moves", async () => {
      const on = await api.request(
        "alice",
        "PUT",
        `/api/sessions/${sharedA.session}/shared-control`,
        {
          enabled: true,
        },
      );
      expect(on.status).toBe(200);
      api.world.calls.splice(0, api.world.calls.length);
      state.audited = [];

      const response = await api.request("carol", "POST", land, {});
      expect({ status: response.status, calls: api.world.calls, audited: state.audited }).toEqual({
        status: 403,
        calls: [],
        audited: [],
      });
      expect(await response.json()).toEqual({
        _tag: "LandingNotAllowed",
        message: "only the change's owner lands it",
      });

      await api.request("alice", "PUT", `/api/sessions/${sharedA.session}/shared-control`, {
        enabled: false,
      });
    });

    it("refuses an organization owner on a member's session", async () => {
      const response = await api.request(
        "alice",
        "POST",
        `/api/sessions/${CAROL_SESSION_IN_SHARED_A}/land`,
        {},
      );
      expect({ status: response.status, calls: api.world.calls }).toEqual({
        status: 403,
        calls: [],
      });
    });

    it("refuses a teammate who started a session in the owner's worktree", async () => {
      const response = await api.request("carol", "POST", `/api/sessions/${CAROL_JOINED}/land`, {});
      expect({
        status: response.status,
        calls: api.world.calls.filter((call) => call.startsWith("landing")),
        audited: state.audited,
      }).toEqual({ status: 403, calls: [], audited: [] });
      expect(await response.json()).toEqual({
        _tag: "LandingNotAllowed",
        message: "only the change's owner lands it",
      });
    });

    it("lands for the change's owner through any session in her worktree", async () => {
      state.report = { landing: landingRow(), pullRequest: { _tag: "opened", pullRequest: PR } };
      for (const sessionId of [CAROL_JOINED, NULL_OWNER_SESSION]) {
        const response = await api.request("alice", "POST", `/api/sessions/${sessionId}/land`, {});
        expect(response.status).toBe(200);
      }
      expect(state.lands.map((asked) => [asked.input.sessionId, asked.input.actorUserId])).toEqual([
        [CAROL_JOINED, "alice"],
        [NULL_OWNER_SESSION, "alice"],
      ]);
    });

    it("answers 409 for a branch that is the base, and for nothing new", async () => {
      for (const reason of ["branch", "nothing-new"] as const) {
        state.report = new LandingNotStartedError({
          reason,
          message: `landing not started · ${reason}`,
        });
        const response = await api.request("alice", "POST", land, { branch: "main" });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          _tag: "LandingNotStarted",
          message: `landing not started · ${reason}`,
        });
      }
      expect(state.audited).toEqual([]);
    });

    it("answers 409 when the session has no change to land, and audits nothing", async () => {
      state.report = new LandingNotStartedError({
        reason: "no-change",
        message: "landing not started · the session has no change",
      });
      const response = await api.request("alice", "POST", land, {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ _tag: "LandingNotStarted" });
      expect(state.audited).toEqual([]);
    });
  });

  describe("GET landings", () => {
    it("reads the record with the facts observed since, for anyone who can see the project", async () => {
      state.landings = [landingRow()];
      state.sinceLanding = [
        { path: "src/login.ts", additions: 4, deletions: 1 },
        { path: "notes.md", additions: 1, deletions: 0 },
      ];
      const response = await api.request("carol", "GET", `/api/changes/${sharedA.change}/landings`);
      expect(response.status).toBe(200);
      const view: unknown = await response.json();
      expect(view).toMatchObject({
        changeId: sharedA.change,
        sessionId: sharedA.session,
        land: false,
        remote: null,
        remoteFailure: null,
        pullRequest: { available: false },
        facts: [
          { _tag: "pushed", branch: "mend/shared-a", sha: PUSHED },
          { _tag: "pull-request", number: 412, state: "open" },
          { _tag: "changed-since-landing", files: 2 },
          {
            _tag: "agent-push",
            ref: "refs/heads/wip",
            sha: "91bd2e4000000000000000000000000000000000",
          },
        ],
      });
      // No fetch unless asked for.
      expect(api.world.calls).not.toContain("landingGit.probe");
    });

    it("fetches origin's branch on request and states that it moved", async () => {
      state.landings = [landingRow()];
      state.unseen = 2;
      const response = await api.request(
        "alice",
        "GET",
        `/api/sessions/${sharedA.session}/landings?probe=true`,
      );
      expect(response.status).toBe(200);
      const view: unknown = await response.json();
      expect(view).toMatchObject({
        land: true,
        remote: { remoteBranch: "mend/shared-a", remoteSha: PUSHED, unseen: 2, holds: true },
        facts: expect.arrayContaining([
          { _tag: "origin-moved", branch: "mend/shared-a", commits: 2 },
        ]),
      });
    });

    it("offers the button to the change's owner only, whichever session is asked about", async () => {
      state.landings = [landingRow()];
      const carol = await api.request("carol", "GET", `/api/sessions/${CAROL_JOINED}/landings`);
      const alice = await api.request("alice", "GET", `/api/sessions/${CAROL_JOINED}/landings`);
      expect(await carol.json()).toMatchObject({ sessionId: CAROL_JOINED, land: false });
      expect(await alice.json()).toMatchObject({ sessionId: CAROL_JOINED, land: true });
    });

    it("bounds each account's fetches of origin, and says so instead of fetching", async () => {
      state.landings = [landingRow()];
      const probe = `/api/changes/${sharedA.change}/landings?probe=true`;
      const views: Array<unknown> = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        views.push(await (await api.request("carol", "GET", probe)).json());
      }
      expect(api.world.calls.filter((call) => call === "landingGit.probe")).toHaveLength(2);
      expect(views[1]).toMatchObject({ remote: { unseen: 0 }, remoteFailure: null });
      expect(views[2]).toMatchObject({
        remote: null,
        remoteFailure: expect.stringMatching(
          /^origin not checked · budget reached · 2 fetches of origin per minute for one account · nothing running was stopped · try again in \d+ s$/,
        ),
      });
    });

    it("answers a session with no change with an empty record", async () => {
      const response = await api.request(
        "carol",
        "GET",
        `/api/sessions/${CAROL_SESSION_IN_SHARED_A}/landings`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        changeId: null,
        sessionId: CAROL_SESSION_IN_SHARED_A,
        land: true,
        landings: [],
        facts: [],
      });
    });
  });

  describe("POST /landings/:id/refresh", () => {
    const refresh = "/api/landings/landing-1/refresh";

    it("records what gh reports now for the owner, and audits it", async () => {
      state.landings = [landingRow()];
      state.refreshed = landingRow({ pullRequest: { ...PR, state: "merged" } });
      const response = await api.request("alice", "POST", refresh);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pullRequest: { state: "merged" } });
      expect(state.audited).toMatchObject([
        {
          action: "change.pull_request_refreshed",
          subjectId: sharedA.change,
          data: { pullRequest: 412, state: "merged" },
        },
      ]);
    });

    it("refuses anyone but the landing's owner, and hides it from other organizations", async () => {
      state.landings = [landingRow()];
      const carol = await api.request("carol", "POST", refresh);
      const bob = await api.request("bob", "POST", refresh);
      expect({ carol: carol.status, bob: bob.status, calls: api.world.calls }).toEqual({
        carol: 403,
        bob: 404,
        calls: [],
      });
      expect(await bob.json()).toMatchObject({ id: "landing-1" });
    });

    it("answers gh's words when it cannot say", async () => {
      state.landings = [landingRow()];
      state.refreshed = new PullRequestStepError({ message: "gh pr view · HTTP 401" });
      const response = await api.request("alice", "POST", refresh);
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        _tag: "PullRequestStepFailed",
        message: "gh pr view · HTTP 401",
      });
    });

    it("is 404 for a landing that does not exist", async () => {
      const response = await api.request("alice", "POST", "/api/landings/landing-9/refresh");
      expect(response.status).toBe(404);
    });
  });

  describe("GET /changes/:id/bundle", () => {
    const bundle = `/api/changes/${sharedA.change}/bundle`;

    it("answers the git bundle with its branch and range, under the budget's limit", async () => {
      const response = await api.request("carol", "GET", bundle);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/x-git-bundle");
      expect(response.headers.get("x-mend-bundle-branch")).toBe("mend/shared-a");
      expect(response.headers.get("x-mend-bundle-tip")).toBe(PUSHED);
      expect(response.headers.get("x-mend-bundle-commits")).toBe("2");
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([35, 32, 118, 50]);
      expect(state.bundles).toEqual([
        {
          sessionId: sharedA.session,
          actorUserId: "carol",
          webOrigin: "http://api.internal",
          limitBytes: 4096,
        },
      ]);
      // Every download is audited, whoever asked.
      expect(state.audited).toEqual([
        {
          organizationId: "org-A",
          actorUserId: "carol",
          action: "change.bundle_downloaded",
          subjectType: "change",
          subjectId: sharedA.change,
          data: {
            sessionId: sharedA.session,
            branch: "mend/shared-a",
            base: "0123456789abcdef",
            tip: PUSHED,
            commits: 2,
            bytes: 4,
          },
        },
      ]);
    });

    it("refuses a bundle over the limit with its size", async () => {
      state.bundle = new BundleTooLargeError({ branch: "mend/shared-a", size: 9000, limit: 4096 });
      const response = await api.request("alice", "GET", bundle);
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        _tag: "BundleTooLarge",
        size: 9000,
        limit: 4096,
      });
      expect(state.audited).toEqual([]);
    });

    it("is hidden from another organization", async () => {
      const response = await api.request("bob", "GET", bundle);
      expect({ status: response.status, calls: api.world.calls }).toEqual({
        status: 404,
        calls: [],
      });
    });
  });

  describe("GET /sessions/:id/git-ops", () => {
    it("lists the operations the session's workspace ran, the agent's pushes included", async () => {
      const response = await api.request(
        "carol",
        "GET",
        `/api/sessions/${sharedA.session}/git-ops`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject([
        {
          kind: "push",
          host: "github.com",
          refUpdates: [`${"0".repeat(40)} 91bd2e4000000000000000000000000000000000 refs/heads/wip`],
        },
      ]);
    });
  });
});
