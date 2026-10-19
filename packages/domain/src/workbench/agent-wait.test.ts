import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AGENT_HOOKS,
  AgentHookReport,
  type AgentSignal,
  AgentWait,
  agentHookTarget,
  agentSignalOf,
  agentWaitWords,
  nextAgentWait,
} from "./agent-wait.ts";

const report = (
  fields: Partial<typeof AgentHookReport.Type> & Pick<typeof AgentHookReport.Type, "event">,
) =>
  new AgentHookReport({
    harness: "claude",
    notificationType: null,
    tool: null,
    providerSessionId: "conversation-a",
    ...fields,
  });

const at = (ms: number) => new Date(ms);

describe("agentSignalOf", () => {
  it("reads a permission request with its tool", () => {
    expect(agentSignalOf(report({ event: "PermissionRequest", tool: "Bash" }))).toEqual({
      _tag: "waits",
      kind: "permission",
      tool: "Bash",
    });
    expect(
      agentSignalOf(report({ harness: "codex", event: "PermissionRequest", tool: "shell" })),
    ).toEqual({ _tag: "waits", kind: "permission", tool: "shell" });
  });

  it("reads Claude's notifications by type and ignores the ones Mend does not wire", () => {
    const kindOf = (notificationType: string) => {
      const signal = agentSignalOf(report({ event: "Notification", notificationType }));
      return signal?._tag === "waits" ? signal.kind : signal;
    };
    expect(kindOf("permission_prompt")).toBe("permission");
    expect(kindOf("elicitation_dialog")).toBe("question");
    expect(kindOf("idle_prompt")).toBe("prompt");
    expect(kindOf("auth_success")).toBeNull();
  });

  it("reads a finished turn as a wait, and a submitted prompt or a used tool as continuing", () => {
    for (const harness of ["claude", "codex"] as const) {
      expect(agentSignalOf(report({ harness, event: "Stop" }))).toEqual({
        _tag: "waits",
        kind: "prompt",
        tool: null,
      });
      expect(agentSignalOf(report({ harness, event: "UserPromptSubmit" }))?._tag).toBe("continues");
      expect(agentSignalOf(report({ harness, event: "PostToolUse", tool: "Bash" }))?._tag).toBe(
        "continues",
      );
    }
  });

  it("ignores events outside the table", () => {
    expect(agentSignalOf(report({ event: "PreToolUse", tool: "Bash" }))).toBeNull();
    expect(agentSignalOf(report({ harness: "codex", event: "Notification" }))).toBeNull();
  });

  it("reads no wait from a session start, which is wired only so the process can be named", () => {
    for (const harness of ["claude", "codex"] as const) {
      expect(AGENT_HOOKS[harness].some((hook) => hook.event === "SessionStart")).toBe(true);
      expect(agentSignalOf(report({ harness, event: "SessionStart" }))).toBeNull();
    }
  });
});

const agent = (name: string, providerSessionId: string | null) => ({ name, providerSessionId });

describe("agentHookTarget", () => {
  it("refuses a report that names no process", () => {
    expect(
      agentHookTarget(report({ event: "Stop", providerSessionId: null }), [agent("a", null)]),
    ).toEqual({ _tag: "unidentified" });
  });

  it("finds the live agent whose session id the report carries", () => {
    const named = agent("b", "conversation-a");
    expect(
      agentHookTarget(report({ event: "PermissionRequest" }), [
        agent("a", "conversation-z"),
        named,
      ]),
    ).toEqual({ _tag: "process", process: named });
  });

  it("lets a session start claim the one agent that does not know its id yet", () => {
    const fresh = agent("codex", null);
    expect(agentHookTarget(report({ event: "SessionStart" }), [fresh])).toEqual({
      _tag: "claim",
      process: fresh,
      providerSessionId: "conversation-a",
    });
  });

  it("reads any other id as another process", () => {
    expect(agentHookTarget(report({ event: "Stop" }), [agent("codex", null)])).toEqual({
      _tag: "other-process",
    });
    expect(
      agentHookTarget(report({ event: "SessionStart" }), [agent("claude", "conversation-z")]),
    ).toEqual({ _tag: "other-process" });
    expect(
      agentHookTarget(report({ event: "SessionStart" }), [agent("a", null), agent("b", null)]),
    ).toEqual({ _tag: "other-process" });
    expect(agentHookTarget(report({ event: "SessionStart" }), [])).toEqual({
      _tag: "other-process",
    });
  });
});

describe("AgentHookReport at the boundary", () => {
  const decode = Schema.decodeUnknownExit(AgentHookReport);
  const base = {
    harness: "claude",
    event: "Stop",
    notificationType: null,
    tool: null,
    providerSessionId: "0f8d5f2c-6c3e-4f63-9a51-2f0c7d4b9e11",
  };

  it("takes the five fields", () => {
    expect(decode(base)._tag).toBe("Success");
    expect(decode({ ...base, providerSessionId: null })._tag).toBe("Success");
  });

  it("refuses a field that is long, unprintable or names another harness", () => {
    expect(decode({ ...base, tool: "x".repeat(65) })._tag).toBe("Failure");
    expect(decode({ ...base, tool: "Bash\u001b[2J" })._tag).toBe("Failure");
    expect(decode({ ...base, providerSessionId: "x".repeat(65) })._tag).toBe("Failure");
    expect(decode({ ...base, harness: "opencode" })._tag).toBe("Failure");
  });
});

describe("nextAgentWait", () => {
  const permissionBash: AgentSignal = { _tag: "waits", kind: "permission", tool: "Bash" };
  const permissionUnknown: AgentSignal = { _tag: "waits", kind: "permission", tool: null };
  const prompt: AgentSignal = { _tag: "waits", kind: "prompt", tool: null };
  const continues: AgentSignal = { _tag: "continues" };

  it("starts a wait at the report's time", () => {
    expect(nextAgentWait(null, permissionBash, at(1))).toEqual(
      new AgentWait({ kind: "permission", tool: "Bash", since: at(1) }),
    );
  });

  it("answers the same wait for a repeat, keeping its start and its tool", () => {
    const first = nextAgentWait(null, permissionBash, at(1));
    expect(nextAgentWait(first, permissionBash, at(7))).toBe(first);
    expect(nextAgentWait(first, permissionUnknown, at(7))).toBe(first);
    const idle = nextAgentWait(null, prompt, at(1));
    expect(nextAgentWait(idle, prompt, at(60))).toBe(idle);
  });

  it("learns a tool a repeat names, and starts over for another kind", () => {
    const unknown = nextAgentWait(null, permissionUnknown, at(1));
    expect(nextAgentWait(unknown, permissionBash, at(2))).toEqual(
      new AgentWait({ kind: "permission", tool: "Bash", since: at(1) }),
    );
    expect(nextAgentWait(unknown, prompt, at(3))).toEqual(
      new AgentWait({ kind: "prompt", tool: null, since: at(3) }),
    );
  });

  it("starts over for a permission about another known tool", () => {
    const bash = nextAgentWait(null, permissionBash, at(1));
    expect(nextAgentWait(bash, { _tag: "waits", kind: "permission", tool: "Edit" }, at(4))).toEqual(
      new AgentWait({ kind: "permission", tool: "Edit", since: at(4) }),
    );
  });

  it("clears when the agent continues", () => {
    expect(nextAgentWait(nextAgentWait(null, permissionBash, at(1)), continues, at(2))).toBeNull();
    expect(nextAgentWait(null, continues, at(2))).toBeNull();
  });
});

describe("agentWaitWords", () => {
  const wait = (kind: AgentWait["kind"], tool: string | null = null) =>
    new AgentWait({ kind, tool, since: at(0) });

  it("says what the agent waits for, in observed words", () => {
    expect(agentWaitWords("claude", wait("permission", "Bash"))).toBe(
      "claude needs your permission to use Bash",
    );
    expect(agentWaitWords("claude", wait("permission"))).toBe("claude needs your permission");
    expect(agentWaitWords("codex", wait("question"))).toBe("codex asks you a question");
    expect(agentWaitWords("codex", wait("prompt"))).toBe("codex finished its turn");
  });
});

describe("AGENT_HOOKS", () => {
  it("wires each event once per harness", () => {
    for (const hooks of Object.values(AGENT_HOOKS)) {
      const events = hooks.map((hook) => hook.event);
      expect(new Set(events).size).toBe(events.length);
    }
  });
});
