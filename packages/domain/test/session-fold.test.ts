import { describe, expect, it } from "vitest";

import { SealantWorkspaceId, SessionId, SessionProcessId } from "../src/ids.ts";
import { foldSessionLiveness, servicesHoldLine } from "../src/workbench/session-fold.ts";
import { SessionProcess } from "../src/workbench/session-process.ts";

const process = (kind: "agent-protocol" | "agent-pty" | "shell") =>
  new SessionProcess({
    id: SessionProcessId.make(`${kind}-1`),
    sessionId: SessionId.make("session-1"),
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
    sealantSessionId: "process-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: kind === "shell" ? null : "codex",
    providerSessionId: null,
    protocolOptions: null,
    label: kind,
    argv: ["command"],
    status: "running",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: new Date(0),
    exitedAt: null,
    updatedAt: new Date(0),
  });

describe("foldSessionLiveness", () => {
  it("reports waiting only for a live protocol process with a pending request", () => {
    expect(foldSessionLiveness([process("agent-protocol")], true)).toBe("waiting");
    expect(foldSessionLiveness([process("agent-protocol")], false)).toBe("running");
    expect(foldSessionLiveness([process("agent-pty")], true)).toBe("running");
  });

  it("keeps supporting-only and empty folds unchanged", () => {
    expect(foldSessionLiveness([process("shell")], true)).toBe("idle");
    expect(foldSessionLiveness([], true)).toBe("settled");
  });
});

describe("servicesHoldLine", () => {
  it("names the agent's outcome and the Services that keep the workspace up", () => {
    expect(servicesHoldLine({ agentLive: false, agentOutcome: "stopped", liveServices: 3 })).toBe(
      "agent stopped · 3 services keep the workspace up",
    );
    expect(servicesHoldLine({ agentLive: false, agentOutcome: "completed", liveServices: 1 })).toBe(
      "agent completed · 1 service keeps the workspace up",
    );
  });

  it("says only the hold when no agent ever ran", () => {
    expect(servicesHoldLine({ agentLive: false, agentOutcome: null, liveServices: 2 })).toBe(
      "2 services keep the workspace up",
    );
  });

  it("says nothing while the agent runs or no Service holds the workspace", () => {
    expect(servicesHoldLine({ agentLive: true, agentOutcome: null, liveServices: 2 })).toBeNull();
    expect(
      servicesHoldLine({ agentLive: false, agentOutcome: "stopped", liveServices: 0 }),
    ).toBeNull();
  });
});
