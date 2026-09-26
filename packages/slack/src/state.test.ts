import { SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { SessionProcess, type AgentTurnStatus } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  isSettledState,
  isStoppedState,
  slackSessionState,
  statusMayMove,
  switchOffered,
} from "./state.ts";

const agent = (patch: Partial<SessionProcess> = {}) =>
  new SessionProcess({
    id: SessionProcessId.make("agent-1"),
    sessionId: SessionId.make("session-1"),
    sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
    sealantSessionId: "protocol-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind: "agent-protocol",
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
    createdAt: new Date("2026-09-23T10:00:00.000Z"),
    exitedAt: null,
    updatedAt: new Date("2026-09-23T10:00:00.000Z"),
    ...patch,
  });

const turn = (ordinal: number, status: AgentTurnStatus) => ({ ordinal, status });

describe("the state a thread hears", () => {
  it("keeps the session's own words where they say what the request came to", () => {
    for (const status of ["starting", "waiting", "completed", "failed", "stopped"] as const) {
      expect(slackSessionState({ status, currentAgent: agent(), turns: [] })).toBe(status);
    }
  });

  it("reads a stop Mend made for idleness as idle-stopped, and the person's own as stopped", () => {
    const ended = agent({ status: "stopped", exitedAt: new Date("2026-09-23T10:20:00.000Z") });
    const idleStoppedAt = new Date("2026-09-23T10:20:00.000Z");
    expect(
      slackSessionState({ status: "stopped", currentAgent: ended, turns: [], idleStoppedAt }),
    ).toBe("idle-stopped");
    expect(
      slackSessionState({ status: "stopped", currentAgent: ended, turns: [], idleStoppedAt: null }),
    ).toBe("stopped");
    expect(isSettledState("idle-stopped")).toBe(true);
    expect(isStoppedState("idle-stopped")).toBe(true);
    expect(isStoppedState("completed")).toBe(false);
    expect(switchOffered("idle-stopped", [])).toBe(false);
    // The reply that resumes it moves the thread back to running.
    expect(statusMayMove("idle-stopped", "running")).toBe(true);
  });

  it("reads a live protocol agent by its latest turn", () => {
    const live = agent();
    expect(slackSessionState({ status: "running", currentAgent: live, turns: [] })).toBe("running");
    expect(
      slackSessionState({ status: "running", currentAgent: live, turns: [turn(1, "running")] }),
    ).toBe("running");
    expect(
      slackSessionState({ status: "running", currentAgent: live, turns: [turn(1, "completed")] }),
    ).toBe("completed");
    // A follow-up turn puts it back to running; the latest turn decides, not the order given.
    expect(
      slackSessionState({
        status: "running",
        currentAgent: live,
        turns: [turn(2, "failed"), turn(1, "completed")],
      }),
    ).toBe("failed");
    expect(
      slackSessionState({
        status: "idle",
        currentAgent: live,
        turns: [turn(1, "completed"), turn(2, "queued")],
      }),
    ).toBe("running");
    expect(
      slackSessionState({ status: "idle", currentAgent: live, turns: [turn(1, "interrupted")] }),
    ).toBe("stopped");
  });

  it("reads an ended agent by its exit, and no agent at all as starting", () => {
    const ended = new Date("2026-09-23T10:05:00.000Z");
    expect(
      slackSessionState({
        status: "idle",
        currentAgent: agent({ status: "exited", exitCode: 1, exitedAt: ended }),
        turns: [turn(1, "completed")],
      }),
    ).toBe("failed");
    expect(slackSessionState({ status: "idle", currentAgent: null, turns: [] })).toBe("starting");
  });

  it("never moves the status message back to starting once it moved on", () => {
    expect(statusMayMove(null, "starting")).toBe(true);
    expect(statusMayMove("starting", "running")).toBe(true);
    expect(statusMayMove("completed", "running")).toBe(true);
    expect(statusMayMove("failed", "starting")).toBe(false);
    expect(statusMayMove("running", "starting")).toBe(false);
    expect(isSettledState("completed")).toBe(true);
    expect(isSettledState("waiting")).toBe(false);
  });

  it("offers Switch project until the first turn completes, and never on a stopped session", () => {
    expect(switchOffered("starting", [])).toBe(true);
    expect(switchOffered("running", [turn(1, "running")])).toBe(true);
    expect(switchOffered("failed", [turn(1, "failed")])).toBe(true);
    expect(switchOffered("completed", [turn(1, "completed")])).toBe(false);
    expect(switchOffered("running", [turn(1, "completed"), turn(2, "running")])).toBe(false);
    expect(switchOffered("stopped", [])).toBe(false);
  });
});
