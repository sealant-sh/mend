import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  agentStartingFacts,
  agentStartingLine,
  agentStartingWords,
  withoutAgentStarting,
} from "../src/workbench/agent-start.ts";
import { SessionProcess } from "../src/workbench/session-process.ts";

describe("agentStartingWords", () => {
  it("names a coding-agent TUI, and the new machine when it is one", () => {
    expect(agentStartingWords("claude", true)).toBe("claude is starting on the new machine");
    expect(agentStartingWords("codex", false)).toBe("codex is starting");
    expect(agentStartingWords("opencode", true)).toBe("opencode is starting on the new machine");
  });

  it("says nothing for a shell or a command of the owner's own", () => {
    expect(agentStartingWords("shell", true)).toBeNull();
    expect(agentStartingWords("run", true)).toBeNull();
  });
});

describe("withoutAgentStarting", () => {
  it("takes the starting words off wherever they stand and keeps every other part in order", () => {
    expect(withoutAgentStarting("claude is starting on the new machine")).toBeNull();
    expect(withoutAgentStarting("codex is starting")).toBeNull();
    expect(
      withoutAgentStarting(
        "executor lost · lease expired at 07:00 · claude is starting on the new machine",
      ),
    ).toBe("executor lost · lease expired at 07:00");
    expect(
      withoutAgentStarting("setup skipped · codex is starting on the new machine · picked up"),
    ).toBe("setup skipped · picked up");
  });

  it("leaves a line without them exactly as it was", () => {
    expect(withoutAgentStarting(null)).toBeNull();
    const line = "stopped · the process is starting to save";
    expect(withoutAgentStarting(line)).toBe(line);
    expect(withoutAgentStarting("booting")).toBe("booting");
  });
});

describe("agentStartingLine", () => {
  it("says who is starting, where, and for how long", () => {
    expect(agentStartingLine("claude", { startedAt: 0, freshMachine: true }, 23_400)).toBe(
      "claude is starting on the new machine · 23s",
    );
    expect(agentStartingLine("the agent", { startedAt: null, freshMachine: false }, -5)).toBe(
      "the agent is starting · 0s",
    );
  });
});

describe("agentStartingFacts", () => {
  const now = Date.parse("2026-09-30T17:15:30.000Z");
  const agent = {
    id: "agent",
    sealantWorkspaceId: "ws-1",
    createdAt: "2026-09-30T17:14:55.000Z",
  };

  it("counts from the agent's start, on a machine it was the first process on", () => {
    expect(agentStartingFacts(agent, [agent], now)).toEqual({
      startedAt: Date.parse(agent.createdAt),
      freshMachine: true,
    });
  });

  it("is not a new machine when something ran there before the agent", () => {
    const shell = { id: "shell", sealantWorkspaceId: "ws-1", createdAt: "2026-09-30T17:00:00Z" };
    expect(agentStartingFacts(agent, [shell, agent], now).freshMachine).toBe(false);
    // A process on another executor says nothing about this one.
    const elsewhere = { ...shell, sealantWorkspaceId: "ws-0" };
    expect(agentStartingFacts(agent, [elsewhere, agent], now).freshMachine).toBe(true);
  });

  it("claims nothing without an agent or its processes, and distrusts a skewed clock", () => {
    expect(agentStartingFacts(null, [], now)).toEqual({ startedAt: null, freshMachine: false });
    expect(agentStartingFacts(agent, undefined, now).freshMachine).toBe(false);
    const future = { ...agent, createdAt: "2026-09-30T17:20:00.000Z" };
    expect(agentStartingFacts(future, [future], now).startedAt).toBeNull();
  });

  it("reads a process row as the API decodes it, Dates included", () => {
    const row = Schema.decodeUnknownSync(SessionProcess)({
      id: "agent",
      sessionId: "session",
      sealantWorkspaceId: "ws-1",
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
      createdAt: "2026-09-30T17:14:55.000Z",
      exitedAt: null,
      updatedAt: "2026-09-30T17:14:55.000Z",
    });
    // An older server's row carries no first output: it decodes as none observed.
    expect(row.firstOutputAt).toBeNull();
    expect(agentStartingFacts(row, [row], now)).toEqual({
      startedAt: Date.parse("2026-09-30T17:14:55.000Z"),
      freshMachine: true,
    });
  });
});
