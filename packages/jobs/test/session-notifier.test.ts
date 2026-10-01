import {
  OrganizationsRepo,
  PushDevice,
  type NotificationSettingsRepo,
  type PushDevicesRepo,
  type SealedSlackInstall,
  type SlackThreadSession,
} from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NotificationSettings,
  notificationPushes,
  Organization,
  Session,
  SessionProcess,
  type NotificationKind,
  type SlackThreadReach,
} from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  captureAlertsToRing,
  captureFailingNotificationBody,
  latestSenderWhoSees,
  notSavedNotificationBody,
  phaseKind,
  phaseOf,
  pushTargets,
  sessionPhase,
  slackReachOf,
  turnKind,
} from "../src/session-notifier.ts";

const agent = (patch: Partial<SessionProcess>) =>
  new SessionProcess({
    id: SessionProcessId.make("agent-1"),
    sessionId: SessionId.make("session-1"),
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: "pty-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-pty",
    harness: "claude",
    providerSessionId: null,
    protocolOptions: null,
    label: "claude",
    argv: ["claude"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: new Date("2026-08-21T10:00:00.000Z"),
    exitedAt: null,
    updatedAt: new Date("2026-08-21T10:00:00.000Z"),
    ...patch,
  });

describe("phaseOf", () => {
  it("rings for the agent's own end behind an idle session, never for idle itself", () => {
    expect(phaseOf("idle", null)).toBeNull();
    expect(phaseOf("idle", agent({}))).toBeNull();
    const ended = new Date("2026-08-21T11:00:00.000Z");
    expect(phaseOf("idle", agent({ status: "exited", exitCode: 0, exitedAt: ended }))).toBe(
      "completed",
    );
    expect(phaseOf("idle", agent({ status: "exited", exitCode: 1, exitedAt: ended }))).toBe(
      "failed",
    );
    // The user's own stop is not news.
    expect(phaseOf("idle", agent({ status: "stopped", exitedAt: ended }))).toBeNull();
  });

  it("hears a session still saving its workspace as its agent's own end, so the settle after it does not ring again", () => {
    const ended = new Date("2026-08-21T11:00:00.000Z");
    const exited = agent({ status: "exited", exitCode: 0, exitedAt: ended });
    expect(phaseOf("stopping", exited)).toBe("completed");
    expect(phaseOf("stopping", exited)).toBe(phaseOf("completed", exited));
    expect(phaseOf("stopping", agent({ status: "stopped", exitedAt: ended }))).toBeNull();
  });

  it("keeps the settled and waiting phases", () => {
    expect(phaseOf("waiting", null)).toBe("attention");
    expect(phaseOf("completed", null)).toBe("completed");
    expect(phaseOf("failed", null)).toBe("failed");
    expect(phaseOf("running", null)).toBeNull();
    expect(phaseOf("stopped", null)).toBeNull();
  });
});

describe("sessionPhase", () => {
  const ended = new Date("2026-09-27T10:15:00.000Z");
  const stoppedAgent = agent({ kind: "agent-protocol", status: "stopped", exitedAt: ended });

  it("never rings for the idle stop, settled or held open by a shell or a Service", () => {
    const idleStoppedAt = new Date("2026-09-27T10:14:59.000Z");
    expect(sessionPhase({ status: "stopped", idleStoppedAt }, stoppedAgent)).toBeNull();
    expect(sessionPhase({ status: "idle", idleStoppedAt }, stoppedAgent)).toBeNull();
    // Claimed and on its way down: whatever the processes read meanwhile is not news.
    const exited = agent({
      kind: "agent-protocol",
      status: "exited",
      exitCode: 1,
      exitedAt: ended,
    });
    expect(sessionPhase({ status: "idle", idleStoppedAt }, exited)).toBeNull();
    expect(sessionPhase({ status: "failed", idleStoppedAt }, exited)).toBeNull();
    expect(sessionPhase({ status: "completed", idleStoppedAt }, null)).toBeNull();
  });

  it("never rings for a person's stop", () => {
    expect(sessionPhase({ status: "stopped", idleStoppedAt: null }, stoppedAgent)).toBeNull();
    expect(sessionPhase({ status: "idle", idleStoppedAt: null }, stoppedAgent)).toBeNull();
  });

  it("reads the phase of any other session as phaseOf does", () => {
    expect(sessionPhase({ status: "waiting", idleStoppedAt: null }, null)).toBe("attention");
    expect(sessionPhase({ status: "failed", idleStoppedAt: null }, null)).toBe("failed");
  });
});

describe("the kind of news", () => {
  it("names phases and turn ends as a person's settings do", () => {
    expect(phaseKind("attention")).toBe("needs-input");
    expect(phaseKind("completed")).toBe("finished");
    expect(phaseKind("failed")).toBe("failed");
    expect(turnKind("completed")).toBe("finished");
    expect(turnKind("failed")).toBe("failed");
    // The person's own interrupt, and the idle stop's cancel, are not news.
    expect(turnKind("interrupted")).toBeNull();
    expect(turnKind("cancelled")).toBeNull();
    expect(turnKind("running")).toBeNull();
  });
});

describe("notificationPushes", () => {
  const kinds: ReadonlyArray<NotificationKind> = ["finished", "needs-input", "failed"];
  const pushesFor = (
    slackThread: SlackThreadReach | null,
    settings = DEFAULT_NOTIFICATION_SETTINGS,
  ) =>
    Object.fromEntries(
      kinds.map((kind) => [kind, notificationPushes({ kind, settings, slackThread })]),
    );

  it("by default, a session started in Mend pushes every kind", () => {
    expect(pushesFor(null)).toEqual({ finished: true, "needs-input": true, failed: true });
  });

  it("by default, a Slack session pushes only what its thread does not say", () => {
    // Replies: the closing message, the question naming the owner, the approval line.
    expect(pushesFor("replies")).toEqual({ finished: false, "needs-input": false, failed: true });
    // A channel thread of a private project: status line and reaction only, no question.
    expect(pushesFor("status")).toEqual({ finished: false, "needs-input": true, failed: true });
    // The app was removed: the thread says nothing.
    expect(pushesFor("none")).toEqual({ finished: true, "needs-input": true, failed: true });
  });

  it("with Slack sessions on, a Slack session pushes like any other", () => {
    const on = new NotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, slackSessions: true });
    expect(pushesFor("replies", on)).toEqual({ finished: true, "needs-input": true, failed: true });
  });

  it("each kind turned off pushes for no session", () => {
    const off = new NotificationSettings({
      slackSessions: true,
      turnFinished: false,
      needsInput: false,
      failed: false,
    });
    for (const reach of [null, "replies", "status", "none"] as const) {
      expect(pushesFor(reach, off)).toEqual({
        finished: false,
        "needs-input": false,
        failed: false,
      });
    }
    const onlyFailures = new NotificationSettings({
      ...DEFAULT_NOTIFICATION_SETTINGS,
      turnFinished: false,
      needsInput: false,
    });
    expect(pushesFor(null, onlyFailures)).toEqual({
      finished: false,
      "needs-input": false,
      failed: true,
    });
  });
});

describe("pushTargets", () => {
  const registered = [
    new PushDevice({ token: "alice-phone", platform: "ios", userId: "alice" }),
    new PushDevice({ token: "carol-phone", platform: "ios", userId: "carol" }),
  ];
  const asked: Array<ReadonlyArray<string>> = [];
  const devices: PushDevicesRepo["Service"] = {
    register: () => Effect.die("unused"),
    listForUsers: (userIds) =>
      Effect.sync(() => {
        asked.push(userIds);
        return registered.filter((device) => userIds.includes(device.userId));
      }),
    remove: () => Effect.void,
    removeOwned: () => Effect.void,
    removeAllForUser: () => Effect.void,
  };
  const saved = new Map<string, NotificationSettings>();
  const settings: Pick<NotificationSettingsRepo["Service"], "forUsers"> = {
    forUsers: (userIds) =>
      Effect.sync(
        () =>
          new Map(
            userIds.map((userId) => [userId, saved.get(userId) ?? DEFAULT_NOTIFICATION_SETTINGS]),
          ),
      ),
  };
  const finished = { kind: "finished", slackThread: null } as const;

  it("rings the owner's phones only, and nobody's for a session with no owner", async () => {
    asked.length = 0;
    const owned = await Effect.runPromise(
      pushTargets(
        devices,
        settings,
        { ownerUserId: "alice", sharedControlEnabledAt: null },
        "carol",
        finished,
      ),
    );
    expect(owned.map((device) => device.token)).toEqual(["alice-phone"]);
    const unowned = await Effect.runPromise(
      pushTargets(
        devices,
        settings,
        { ownerUserId: null, sharedControlEnabledAt: new Date() },
        "carol",
        finished,
      ),
    );
    expect(unowned).toEqual([]);
    expect(asked).toEqual([["alice"]]);
  });

  it("while control is shared, also rings whoever sent the latest turn", async () => {
    const shared = await Effect.runPromise(
      pushTargets(
        devices,
        settings,
        { ownerUserId: "alice", sharedControlEnabledAt: new Date() },
        "carol",
        finished,
      ),
    );
    expect(shared.map((device) => device.token)).toEqual(["alice-phone", "carol-phone"]);
  });

  it("each recipient's own settings decide, and a Slack thread that says it rings no one", async () => {
    saved.set(
      "carol",
      new NotificationSettings({ ...DEFAULT_NOTIFICATION_SETTINGS, turnFinished: false }),
    );
    const session = { ownerUserId: "alice", sharedControlEnabledAt: new Date() };
    const mendFinished = await Effect.runPromise(
      pushTargets(devices, settings, session, "carol", finished),
    );
    expect(mendFinished.map((device) => device.token)).toEqual(["alice-phone"]);

    asked.length = 0;
    const slackFinished = await Effect.runPromise(
      pushTargets(devices, settings, session, "carol", {
        kind: "finished",
        slackThread: "replies",
      }),
    );
    expect(slackFinished).toEqual([]);
    expect(asked).toEqual([]); // nobody listening: no device lookup at all

    const slackFailed = await Effect.runPromise(
      pushTargets(devices, settings, session, "carol", { kind: "failed", slackThread: "replies" }),
    );
    expect(slackFailed.map((device) => device.token)).toEqual(["alice-phone", "carol-phone"]);
    saved.clear();
  });
});

/** A thread, an install and a project, for `slackReachOf`. */
const reachOrg = OrganizationId.make("org-acme");
const thread = (channelId: string): SlackThreadSession => ({
  sessionId: SessionId.make("session-1"),
  teamId: "T1",
  channelId,
  threadTs: "1.0",
  requestTs: "1.0",
  statusTs: "1.1",
  slackUserId: "U1",
  projectSource: "channel-default",
  external: false,
  reportedState: null,
  reportedStatus: null,
  createdAt: new Date("2026-09-27T10:00:00.000Z"),
});
const install = (organizationId: OrganizationId): SealedSlackInstall => ({
  organizationId,
  teamId: "T1",
  teamName: "Acme",
  botUserId: "B1",
  appId: "A1",
  sealedAppToken: "sealed",
  sealedBotToken: "sealed",
  webOrigin: "https://mend.example.com",
  settings: {
    defaultHarness: "codex",
    showAgentMessages: true,
    showDiffs: false,
    externalChannels: false,
    landAutomatically: true,
  },
  installedByUserId: "alice",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
  updatedAt: new Date("2026-09-01T00:00:00.000Z"),
});
const reach = (
  found: SlackThreadSession | null,
  installed: SealedSlackInstall | null,
  project: {
    readonly organizationId: OrganizationId;
    readonly visibility: "shared" | "private";
  } | null,
) =>
  Effect.runPromise(
    slackReachOf(
      { forSession: () => Effect.succeed(found) },
      { byTeam: () => Effect.succeed(installed) },
      { id: SessionId.make("session-1") },
      project,
    ),
  );
describe("slackReachOf", () => {
  const acme = reachOrg;
  const shared = { organizationId: acme, visibility: "shared" } as const;
  const privateProject = { organizationId: acme, visibility: "private" } as const;

  it("is null for a session that reports to no thread", async () => {
    expect(await reach(null, install(acme), shared)).toBeNull();
  });

  it("reads as the reporter writes: replies, status only, or nothing", async () => {
    expect(await reach(thread("C1"), install(acme), shared)).toBe("replies");
    expect(await reach(thread("D1"), install(acme), privateProject)).toBe("replies");
    expect(await reach(thread("C1"), install(acme), privateProject)).toBe("status");
    expect(await reach(thread("C1"), null, shared)).toBe("none");
    expect(await reach(thread("C1"), install(OrganizationId.make("org-other")), shared)).toBe(
      "none",
    );
    expect(await reach(thread("C1"), install(acme), null)).toBe("none");
  });
});

describe("latestSenderWhoSees", () => {
  const acme = OrganizationId.make("org-acme");
  const members = new Set(["alice", "carol"]);
  const organizations = Effect.runSync(
    Effect.gen(function* () {
      return yield* OrganizationsRepo;
    }).pipe(
      Effect.provide(
        Layer.mock(OrganizationsRepo, {
          membershipOf: (userId) =>
            Effect.succeed(
              members.has(userId)
                ? {
                    organization: new Organization({
                      id: acme,
                      name: "Acme",
                      createdByUserId: null,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    }),
                    role: "member" as const,
                    joinedAt: new Date(),
                  }
                : null,
            ),
        }),
      ),
    ),
  );
  const turns = [{ author: "alice" }, { author: "carol" }, { author: null }];

  it("names the latest sender only while they can see the project", async () => {
    const shared = {
      organizationId: acme,
      visibility: "shared" as const,
      createdByUserId: "alice",
    };
    expect(await Effect.runPromise(latestSenderWhoSees(organizations, shared, turns))).toBe(
      "carol",
    );
    const privateToAlice = { ...shared, visibility: "private" as const };
    expect(
      await Effect.runPromise(latestSenderWhoSees(organizations, privateToAlice, turns)),
    ).toBeNull();
    members.delete("carol");
    expect(await Effect.runPromise(latestSenderWhoSees(organizations, shared, turns))).toBeNull();
  });
});

describe("notSavedNotificationBody", () => {
  it("tells the owner what is kept and why, in the words every surface uses", () => {
    const at = new Date("2026-09-27T10:00:00.000Z");
    const session = new Session({
      id: SessionId.make("session-1"),
      projectId: ProjectId.make("p-billing"),
      worktreeId: WorktreeId.make("wt-1"),
      harness: "claude",
      providerSessionId: null,
      label: "billing-fix",
      worktree: "wt-1",
      branch: "mend/wt-1",
      baseSha: Sha.make("abc"),
      baseRef: "main",
      contextSnapshotId: null,
      referenceMounts: [],
      extraMounts: [],
      sealantRunId: null,
      sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
      sealantSessionId: null,
      workspaceExpiresAt: null,
      workspaceTtlRenewedAt: null,
      workspaceTtlRenewalFailedAt: null,
      workspaceTtlRenewalError: null,
      workspaceImage: null,
      dotfiles: null,
      ownerUserId: "alice",
      hasTranscript: null,
      status: "stopped",
      summary: null,
      lastSeenSequence: 0n,
      recordHistoryComplete: true,
      startedAt: at,
      settledAt: at,
      createdAt: at,
      updatedAt: at,
      capturePending: 3,
      captureDrain: "stop",
      captureDrainRequestedAt: at,
      captureDrainProgressAt: at,
      captureNotSavedAt: at,
    });
    expect(notSavedNotificationBody(session)).toBe(
      "billing-fix not saved · 3 pending · workspace kept",
    );
  });
});

describe("capture alerts", () => {
  const quiet = { notSaved: false, failing: false };
  it("ring the owner once when a running executor's snaps start failing, never again while they fail, and not on the baseline", () => {
    expect(captureAlertsToRing(undefined, { notSaved: false, failing: true })).toEqual([]);
    expect(captureAlertsToRing(quiet, { notSaved: false, failing: true })).toEqual(["failing"]);
    expect(
      captureAlertsToRing({ notSaved: false, failing: true }, { notSaved: false, failing: true }),
    ).toEqual([]);
    // Failing again after it recovered is news again.
    expect(captureAlertsToRing(quiet, { notSaved: false, failing: true })).toEqual(["failing"]);
    expect(captureAlertsToRing(quiet, { notSaved: true, failing: false })).toEqual(["not-saved"]);
  });

  it("tell the owner since when and why, in the words every surface uses", () => {
    const at = new Date("2026-09-27T16:29:51.000Z");
    const session = new Session({
      id: SessionId.make("session-1"),
      projectId: ProjectId.make("p-billing"),
      worktreeId: WorktreeId.make("wt-1"),
      harness: "claude",
      providerSessionId: null,
      label: "billing-fix",
      worktree: "wt-1",
      branch: "mend/wt-1",
      baseSha: Sha.make("abc"),
      baseRef: "main",
      contextSnapshotId: null,
      referenceMounts: [],
      extraMounts: [],
      sealantRunId: null,
      sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
      sealantSessionId: null,
      workspaceExpiresAt: null,
      workspaceTtlRenewedAt: null,
      workspaceTtlRenewalFailedAt: null,
      workspaceTtlRenewalError: null,
      workspaceImage: null,
      dotfiles: null,
      ownerUserId: "alice",
      hasTranscript: null,
      status: "running",
      summary: null,
      lastSeenSequence: 0n,
      recordHistoryComplete: true,
      startedAt: at,
      settledAt: null,
      createdAt: at,
      updatedAt: at,
      captureFailingSince: at,
      captureFailingError: "EIO: tree/db.sqlite",
    });
    expect(captureFailingNotificationBody(session)).toBe(
      "billing-fix capture failing since 16:29:51 UTC · EIO: tree/db.sqlite",
    );
  });
});
