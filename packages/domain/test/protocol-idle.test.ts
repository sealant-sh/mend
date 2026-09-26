import { describe, expect, it } from "vitest";

import { SealantWorkspaceId, SessionId, SessionProcessId } from "../src/ids.ts";
import type { AgentRequestStatus, AgentTurnStatus } from "../src/workbench/agent-protocol.ts";
import {
  idleStopSummary,
  protocolIdleReading,
  protocolIdleStopDue,
  type ProtocolIdleFacts,
} from "../src/workbench/protocol-idle.ts";
import { SessionProcess, type SessionProcessKind } from "../src/workbench/session-process.ts";

const T0 = new Date("2026-09-26T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const process = (
  kind: SessionProcessKind,
  live: boolean,
  options: { readonly id?: string; readonly createdAt?: Date; readonly exitedAt?: Date } = {},
) =>
  new SessionProcess({
    id: SessionProcessId.make(options.id ?? `${kind}-1`),
    sessionId: SessionId.make("session-1"),
    sealantWorkspaceId: SealantWorkspaceId.make("workspace-1"),
    sealantSessionId: "process-1",
    sealantRunId: null,
    launchCorrelationId: null,
    serviceId: null,
    attemptOrdinal: null,
    kind,
    harness: kind === "shell" ? null : "claude",
    providerSessionId: kind === "agent-protocol" ? "provider-1" : null,
    protocolOptions: null,
    label: kind,
    argv: ["command"],
    status: live ? "running" : "stopped",
    exitCode: null,
    workspacePort: null,
    protocol: "tcp",
    hostPort: null,
    createdAt: options.createdAt ?? T0,
    exitedAt: live ? null : (options.exitedAt ?? T0),
    updatedAt: options.createdAt ?? T0,
  });

const turn = (status: AgentTurnStatus, endedAt: Date | null) => ({
  status,
  createdAt: T0,
  startedAt: T0,
  endedAt,
});

const request = (status: AgentRequestStatus, decidedAt: Date | null) => ({
  status,
  createdAt: T0,
  decidedAt,
});

/** A protocol agent whose one turn completed at minute 2, and nothing else. */
const idleFacts = (overrides: Partial<ProtocolIdleFacts> = {}): ProtocolIdleFacts => ({
  session: { settledAt: null, updatedAt: T0 },
  processes: [process("agent-protocol", true)],
  turns: [turn("completed", at(2))],
  requests: [],
  liveServices: 0,
  ...overrides,
});

describe("protocolIdleReading", () => {
  it("reads a live protocol agent with nothing in flight as idle since its last turn ended", () => {
    expect(protocolIdleReading(idleFacts())).toEqual({ kind: "idle", since: at(2) });
  });

  it("is held by a turn in flight, a pending request, live Services or a live shell", () => {
    expect(protocolIdleReading(idleFacts({ turns: [turn("running", null)] }))).toEqual({
      kind: "held",
      by: "turn",
    });
    expect(protocolIdleReading(idleFacts({ turns: [turn("queued", null)] }))).toEqual({
      kind: "held",
      by: "turn",
    });
    expect(protocolIdleReading(idleFacts({ requests: [request("pending", null)] }))).toEqual({
      kind: "held",
      by: "request",
    });
    expect(protocolIdleReading(idleFacts({ liveServices: 1 }))).toEqual({
      kind: "held",
      by: "services",
    });
    expect(
      protocolIdleReading(
        idleFacts({ processes: [process("agent-protocol", true), process("shell", true)] }),
      ),
    ).toEqual({ kind: "held", by: "shell" });
  });

  it("stops nothing but a live protocol agent of an unsettled session", () => {
    expect(protocolIdleReading(idleFacts({ processes: [process("agent-pty", true)] }))).toEqual({
      kind: "not-protocol",
    });
    expect(
      protocolIdleReading(idleFacts({ processes: [process("agent-protocol", false)] })),
    ).toEqual({ kind: "not-protocol" });
    expect(protocolIdleReading(idleFacts({ processes: [] }))).toEqual({ kind: "not-protocol" });
    expect(protocolIdleReading(idleFacts({ session: { settledAt: T0, updatedAt: T0 } }))).toEqual({
      kind: "not-protocol",
    });
  });

  it("clocks from the latest turn, request or process activity, and the session only without them", () => {
    // A decided request after the turn ended.
    expect(
      protocolIdleReading(idleFacts({ requests: [request("resolved", at(4))] })),
    ).toMatchObject({ since: at(4) });
    // A shell that closed later still counts as activity.
    expect(
      protocolIdleReading(
        idleFacts({
          processes: [
            process("agent-protocol", true),
            process("shell", false, { id: "shell-1", exitedAt: at(7) }),
          ],
        }),
      ),
    ).toMatchObject({ since: at(7) });
    // No turn, request or process timestamps newer than the agent's start: the start is the clock.
    expect(
      protocolIdleReading(
        idleFacts({
          turns: [],
          processes: [process("agent-protocol", true, { createdAt: at(1) })],
        }),
      ),
    ).toMatchObject({ since: at(1) });
  });
});

describe("protocolIdleStopDue", () => {
  const reading = protocolIdleReading(idleFacts());

  it("is due once the minutes have passed since the clock", () => {
    expect(protocolIdleStopDue(reading, at(2 + 14).getTime(), 15)).toBe(false);
    expect(protocolIdleStopDue(reading, at(2 + 15).getTime(), 15)).toBe(true);
  });

  it("is never due at 0 minutes, or for a held or non-protocol reading", () => {
    expect(protocolIdleStopDue(reading, at(600).getTime(), 0)).toBe(false);
    expect(protocolIdleStopDue({ kind: "held", by: "turn" }, at(600).getTime(), 15)).toBe(false);
    expect(protocolIdleStopDue({ kind: "not-protocol" }, at(600).getTime(), 15)).toBe(false);
  });

  it("words the stop with the configured minutes", () => {
    expect(idleStopSummary(15)).toBe("idle · stopped after 15 min · reply to resume");
    expect(idleStopSummary(30)).toBe("idle · stopped after 30 min · reply to resume");
  });
});
