import { OrganizationsRepo, PushDevice, type PushDevicesRepo } from "@mend/db";
import {
  OrganizationId,
  ProjectId,
  SealantWorkspaceId,
  SessionId,
  SessionProcessId,
  Sha,
  WorktreeId,
} from "@mend/domain";
import { Organization, Session, SessionProcess } from "@mend/domain/workbench";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  captureAlertsToRing,
  captureFailingNotificationBody,
  latestSenderWhoSees,
  notSavedNotificationBody,
  phaseOf,
  pushTargets,
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

  it("rings the owner's phones only, and nobody's for a session with no owner", async () => {
    const owned = await Effect.runPromise(
      pushTargets(devices, { ownerUserId: "alice", sharedControlEnabledAt: null }, "carol"),
    );
    expect(owned.map((device) => device.token)).toEqual(["alice-phone"]);
    const unowned = await Effect.runPromise(
      pushTargets(devices, { ownerUserId: null, sharedControlEnabledAt: new Date() }, "carol"),
    );
    expect(unowned).toEqual([]);
    expect(asked).toEqual([["alice"]]);
  });

  it("while control is shared, also rings whoever sent the latest turn", async () => {
    const shared = await Effect.runPromise(
      pushTargets(devices, { ownerUserId: "alice", sharedControlEnabledAt: new Date() }, "carol"),
    );
    expect(shared.map((device) => device.token)).toEqual(["alice-phone", "carol-phone"]);
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
