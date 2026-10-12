import { describe, expect, it } from "vitest";

import {
  PENDING_TAKEOVER_TTL_MS,
  agentModeLabel,
  continueCommand,
  isStalePendingTakeover,
  liveEngineAgentOf,
  pendingTakeoverFor,
  type SessionProcessLite,
} from "./takeover.js";

const process = (overrides: Partial<SessionProcessLite>): SessionProcessLite => ({
  id: "p1",
  kind: "agent-pty",
  harness: "codex",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  ...overrides,
});

describe("liveEngineAgentOf", () => {
  it("finds the live terminal agent", () => {
    const pty = process({ id: "pty" });
    expect(liveEngineAgentOf([process({ kind: "shell", id: "sh" }), pty])).toBe(pty);
  });

  it("finds a phone pickup (protocol agent)", () => {
    const protocol = process({ id: "proto", kind: "agent-protocol" });
    expect(liveEngineAgentOf([protocol])).toBe(protocol);
  });

  it("prefers the newest live engine agent", () => {
    const older = process({ id: "older", exitedAt: "2026-09-06T10:00:00Z", status: "stopped" });
    const newer = process({ id: "newer", kind: "agent-protocol" });
    expect(liveEngineAgentOf([older, newer])).toBe(newer);
  });

  it("ignores ended agents, observed agents, and shells", () => {
    expect(
      liveEngineAgentOf([
        process({ exitedAt: "2026-09-06T10:00:00Z", status: "exited" }),
        process({ kind: "agent-external" }),
        process({ kind: "shell" }),
        process({ status: "stopped" }),
      ]),
    ).toBeNull();
  });
});

describe("continueCommand", () => {
  it("resumes the exact provider conversation when its id is known", () => {
    expect(continueCommand("codex", "0199bd6a-1d2f-7c33-8f5e-2b1c0a9d8e7f")).toBe(
      "codex resume 0199bd6a-1d2f-7c33-8f5e-2b1c0a9d8e7f",
    );
    expect(continueCommand("claude", "e822576a-0000-4000-8000-000000000000")).toBe(
      "claude --resume e822576a-0000-4000-8000-000000000000",
    );
  });

  it("falls back to the most recent conversation without an id", () => {
    expect(continueCommand("codex", null)).toBe("codex resume --last");
    expect(continueCommand("claude", null)).toBe("claude --continue");
  });

  it("never interpolates an id the shell could read as syntax", () => {
    expect(continueCommand("codex", "x; rm -rf /")).toBe("codex resume --last");
  });

  it("has no hand-run continuation for other harnesses", () => {
    expect(continueCommand("shell", null)).toBeNull();
    expect(continueCommand("custom", "abc")).toBeNull();
  });
});

describe("agentModeLabel", () => {
  it("names where the agent runs", () => {
    expect(agentModeLabel("agent-protocol")).toBe("from a phone or the web");
    expect(agentModeLabel("agent-pty")).toBe("in a terminal");
  });
});

describe("pendingTakeoverFor", () => {
  const authority = "ssh-remote+mend-ws1@mend-mini";
  const record = {
    authority,
    workspaceId: "ws1",
    sessionId: "s1",
    harness: "codex",
    command: "codex resume --last",
    at: 1_000_000,
  };

  it("claims the record in the window that carries its authority", () => {
    expect(pendingTakeoverFor(record, authority, record.at + 5_000)).toEqual(record);
  });

  it("claims the same complete authority after case normalization", () => {
    expect(pendingTakeoverFor(record, "SSH-REMOTE+mend-WS1@mend-mini", record.at)).toEqual(record);
  });

  it.each([
    "ssh-remote+mend-ws10@mend-mini",
    "ssh-remote+mend-other-ws1@mend-mini",
    "ssh-remote+unrelated@ws1.evil.example",
    "ssh-remote+mend-ws1@other-host",
    "ssh-remote+mend-ws1@mend-mini.evil.example",
    "ssh-remote+mend-ws1@mend-mini:2222",
    "dev-container+mend-ws1@mend-mini",
    "ssh-remote+mend-ws1@mend-mini/suffix",
  ])("does not claim a matching workspace substring in %s", (other) => {
    expect(pendingTakeoverFor(record, other, record.at)).toBeNull();
    expect(pendingTakeoverFor(record, authority, record.at)).toEqual(record);
  });

  it("keeps authorities distinct for overlapping workspace identifiers", () => {
    for (let index = 1; index <= 100; index++) {
      const workspaceId = `ws${index}`;
      const destination = `ssh-remote+mend-${workspaceId}@gateway`;
      const pending = { ...record, workspaceId, authority: destination };
      expect(pendingTakeoverFor(pending, destination, record.at)).toEqual(pending);
      expect(
        pendingTakeoverFor(pending, `ssh-remote+mend-${workspaceId}0@gateway`, record.at),
      ).toBeNull();
      expect(
        pendingTakeoverFor(pending, `ssh-remote+mend-${workspaceId}@other-gateway`, record.at),
      ).toBeNull();
    }
  });

  it("ignores the record in a local window or another remote", () => {
    expect(pendingTakeoverFor(record, undefined, record.at)).toBeNull();
    expect(pendingTakeoverFor(record, "ssh-remote+mend-ws2@mend-mini", record.at)).toBeNull();
  });

  it("expires an unclaimed record", () => {
    expect(
      pendingTakeoverFor(record, authority, record.at + PENDING_TAKEOVER_TTL_MS + 1),
    ).toBeNull();
    expect(isStalePendingTakeover(record, record.at + PENDING_TAKEOVER_TTL_MS + 1)).toBe(true);
    expect(isStalePendingTakeover(record, record.at)).toBe(false);
  });

  it("reads malformed state as nothing pending", () => {
    expect(pendingTakeoverFor({ authority }, authority, 0)).toBeNull();
    expect(pendingTakeoverFor("nope", authority, 0)).toBeNull();
    expect(isStalePendingTakeover(undefined, 0)).toBe(false);
  });
});
