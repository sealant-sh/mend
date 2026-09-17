import { PushDevice, type PushDevicesRepo } from "@mend/db";
import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { SessionProcess } from "@mend/domain/workbench";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { phaseOf, pushTargets } from "../src/session-notifier.ts";

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
