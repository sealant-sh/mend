import { describe, expect, it } from "vitest";

import { SealantWorkspaceId, SessionId, SessionProcessId } from "../src/ids.ts";
import { AgentWait } from "../src/workbench/agent-wait.ts";
import {
  agentWaitLine,
  agentWaitOf,
  foldSessionLiveness,
  servicesHoldLine,
} from "../src/workbench/session-fold.ts";
import { SessionProcess } from "../src/workbench/session-process.ts";

const process = (
  kind: "agent-protocol" | "agent-pty" | "shell",
  extra: Partial<Pick<SessionProcess, "waiting" | "exitedAt" | "status" | "createdAt">> = {},
) =>
  new SessionProcess({
    id: SessionProcessId.make(`${kind}-${extra.createdAt?.getTime() ?? 0}`),
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
    ...extra,
  });

const permission = new AgentWait({ kind: "permission", tool: "Bash", since: new Date(5) });
const question = new AgentWait({ kind: "question", tool: null, since: new Date(5) });
const finished = new AgentWait({ kind: "prompt", tool: null, since: new Date(5) });
const ended = { exitedAt: new Date(9), status: "exited" } as const;

describe("foldSessionLiveness", () => {
  it("reports waiting for a live protocol process with a pending request", () => {
    expect(foldSessionLiveness([process("agent-protocol")], true)).toBe("waiting");
    expect(foldSessionLiveness([process("agent-protocol")], false)).toBe("running");
    expect(foldSessionLiveness([process("agent-pty")], true)).toBe("running");
  });

  it("reports waiting for a live terminal agent that asks the person", () => {
    expect(foldSessionLiveness([process("agent-pty", { waiting: permission })])).toBe("waiting");
    expect(foldSessionLiveness([process("agent-pty", { waiting: question })])).toBe("waiting");
    expect(foldSessionLiveness([process("agent-pty", { waiting: null })])).toBe("running");
  });

  it("reports idle, not waiting, for a live terminal agent that finished its turn", () => {
    expect(foldSessionLiveness([process("agent-pty", { waiting: finished })])).toBe("idle");
    expect(
      foldSessionLiveness([process("agent-pty", { waiting: finished }), process("shell")]),
    ).toBe("idle");
  });

  it("reports running while another live agent works beside the one that finished its turn", () => {
    const working = process("agent-pty", { createdAt: new Date(1) });
    const done = process("agent-pty", { waiting: finished, createdAt: new Date(2) });
    expect(foldSessionLiveness([working, done])).toBe("running");
    const asking = process("agent-pty", { waiting: permission, createdAt: new Date(2) });
    expect(foldSessionLiveness([working, asking])).toBe("waiting");
  });

  it("ignores the wait an ended terminal agent carried", () => {
    const gone = process("agent-pty", { waiting: permission, ...ended });
    expect(foldSessionLiveness([gone])).toBe("settled");
    expect(foldSessionLiveness([gone, process("shell")])).toBe("idle");
  });

  it("keeps supporting-only and empty folds unchanged", () => {
    expect(foldSessionLiveness([process("shell")], true)).toBe("idle");
    expect(foldSessionLiveness([], true)).toBe("settled");
  });
});

describe("agentWaitOf", () => {
  it("reads the newest live terminal agent, not an older one", () => {
    const older = process("agent-pty", { waiting: permission, createdAt: new Date(1) });
    const newer = process("agent-pty", { createdAt: new Date(2) });
    expect(agentWaitOf([older, newer])).toBeNull();
    expect(agentWaitOf([newer, older])).toBeNull();
    expect(agentWaitOf([older])).toBe(permission);
  });

  it("reads no wait from a protocol agent's row", () => {
    expect(agentWaitOf([process("agent-protocol", { waiting: permission })])).toBeNull();
  });
});

describe("agentWaitLine", () => {
  it("says what the live agent waits for", () => {
    expect(agentWaitLine(process("agent-pty", { waiting: permission }))).toBe(
      "waiting · codex needs your permission to use Bash",
    );
  });

  it("says idle for a live agent that finished its turn", () => {
    expect(agentWaitLine(process("agent-pty", { waiting: finished }))).toBe(
      "idle · codex finished its turn",
    );
  });

  it("tells a finished turn from an ended agent beside a shell: only the live one has a line", () => {
    const shell = process("shell");
    const live = process("agent-pty", { waiting: finished });
    const gone = process("agent-pty", ended);
    expect(foldSessionLiveness([live, shell])).toBe(foldSessionLiveness([gone, shell]));
    expect(agentWaitLine(live)).toBe("idle · codex finished its turn");
    expect(agentWaitLine(gone)).toBeNull();
  });

  it("says nothing for no agent, a working agent, or an ended one", () => {
    expect(agentWaitLine(null)).toBeNull();
    expect(agentWaitLine(process("agent-pty"))).toBeNull();
    expect(agentWaitLine(process("agent-pty", { waiting: permission, ...ended }))).toBeNull();
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
