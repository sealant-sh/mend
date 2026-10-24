import { describe, expect, it } from "vitest";

import { SealantWorkspaceId, SessionId, SessionProcessId } from "../src/ids.ts";
import { AgentWait } from "../src/workbench/agent-wait.ts";
import {
  agentWaitLine,
  foldSessionLiveness,
  lastPermissionMode,
  liveAgentsReading,
  servicesHoldLine,
} from "../src/workbench/session-fold.ts";
import { SessionProcess } from "../src/workbench/session-process.ts";

const process = (
  kind: "agent-protocol" | "agent-pty" | "agent-external" | "shell",
  extra: Partial<
    Pick<
      SessionProcess,
      | "id"
      | "waiting"
      | "exitedAt"
      | "status"
      | "createdAt"
      | "harness"
      | "argv"
      | "protocolOptions"
    >
  > = {},
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

const read = (rows: ReadonlyArray<SessionProcess>) => ({
  status: foldSessionLiveness(rows),
  line: agentWaitLine(liveAgentsReading(rows))?.line ?? null,
});

const lineOf = (rows: ReadonlyArray<SessionProcess>) => agentWaitLine(liveAgentsReading(rows));

describe("several live agents", () => {
  it("keeps an older agent's permission waiting beside a newer one that finished its turn", () => {
    const older = process("agent-pty", { waiting: permission, createdAt: new Date(1) });
    const newer = process("agent-pty", { waiting: finished, createdAt: new Date(2) });
    const asking = { status: "waiting", line: "waiting · codex needs your permission to use Bash" };
    expect(read([older, newer])).toEqual(asking);
    expect(read([newer, older])).toEqual(asking);
  });

  it("reads the same whichever order rows with the same createdAt arrive in", () => {
    const tie = new Date(3);
    const asking = process("agent-pty", { id: SessionProcessId.make("b"), waiting: question });
    const done = process("agent-pty", { id: SessionProcessId.make("a"), waiting: finished });
    for (const rows of [
      [asking, done],
      [done, asking],
    ]) {
      expect(read(rows.map((row) => new SessionProcess({ ...row, createdAt: tie })))).toEqual({
        status: "waiting",
        line: "waiting · codex asks you a question",
      });
    }
    const first = new AgentWait({ kind: "permission", tool: "Bash", since: new Date(4) });
    const second = new AgentWait({ kind: "permission", tool: "Edit", since: new Date(4) });
    const claude = process("agent-pty", {
      id: SessionProcessId.make("c"),
      waiting: first,
      harness: "claude",
      createdAt: tie,
    });
    const codex = process("agent-pty", {
      id: SessionProcessId.make("d"),
      waiting: second,
      createdAt: tie,
    });
    expect(read([claude, codex])).toEqual(read([codex, claude]));
  });

  it("words the earliest ask when several agents ask", () => {
    const later = new AgentWait({ kind: "permission", tool: "Edit", since: new Date(8) });
    const first = process("agent-pty", { waiting: later, createdAt: new Date(1) });
    const second = process("agent-pty", { waiting: question, createdAt: new Date(2) });
    expect(read([first, second]).line).toBe("waiting · codex asks you a question");
  });

  it("reads idle when every live agent finished its turn", () => {
    const one = process("agent-pty", { waiting: finished, createdAt: new Date(1) });
    const two = process("agent-pty", { waiting: finished, createdAt: new Date(2) });
    expect(read([one, two])).toEqual({ status: "idle", line: "idle · codex finished its turn" });
  });

  it("reads running while another live agent works beside the one that finished its turn", () => {
    const done = process("agent-pty", { waiting: finished, createdAt: new Date(1) });
    const working = process("agent-pty", { createdAt: new Date(2) });
    expect(read([done, working])).toEqual({ status: "running", line: null });
    expect(read([working, done])).toEqual({ status: "running", line: null });
    expect(read([done, process("agent-protocol", { createdAt: new Date(2) })])).toEqual({
      status: "running",
      line: null,
    });
  });

  it("gives a protocol agent's request its own waiting, with no terminal line", () => {
    const done = process("agent-pty", { waiting: finished, createdAt: new Date(2) });
    const rows = [process("agent-protocol", { createdAt: new Date(1) }), done];
    expect(foldSessionLiveness(rows, true)).toBe("waiting");
    expect(agentWaitLine(liveAgentsReading(rows, true))).toBeNull();
  });
});

describe("agentWaitLine", () => {
  it("says what the live agent waits for, with the word the fold reads for it", () => {
    expect(lineOf([process("agent-pty", { waiting: permission })])).toEqual({
      status: "waiting",
      line: "waiting · codex needs your permission to use Bash",
    });
    expect(lineOf([process("agent-pty", { waiting: finished })])).toEqual({
      status: "idle",
      line: "idle · codex finished its turn",
    });
  });

  it("tells a finished turn from an ended agent beside a shell: only the live one has a line", () => {
    const shell = process("shell");
    const live = process("agent-pty", { waiting: finished });
    const gone = process("agent-pty", ended);
    expect(foldSessionLiveness([live, shell])).toBe(foldSessionLiveness([gone, shell]));
    expect(lineOf([live, shell])?.line).toBe("idle · codex finished its turn");
    expect(lineOf([gone, shell])).toBeNull();
  });

  it("says nothing for no agent, a working agent, an ended one, or a protocol agent's row", () => {
    expect(lineOf([])).toBeNull();
    expect(lineOf([process("agent-pty")])).toBeNull();
    expect(lineOf([process("agent-pty", { waiting: permission, ...ended })])).toBeNull();
    expect(lineOf([process("agent-protocol", { waiting: permission })])).toBeNull();
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

describe("lastPermissionMode", () => {
  const at = (time: number) => ({ createdAt: new Date(time), ...ended });
  const conversation = (time: number, permissionMode: "ask" | "bypass") =>
    process("agent-protocol", {
      ...at(time),
      protocolOptions: { model: null, effort: null, permissionMode },
    });
  const terminal = (time: number, harness: string, argv: ReadonlyArray<string>) =>
    process("agent-pty", { ...at(time), harness, argv });

  it("reads the newest agent, a conversation or a terminal, whatever order the rows come in", () => {
    const askTerminal = terminal(2, "codex", [
      "codex",
      "resume",
      "id",
      "--sandbox",
      "danger-full-access",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(lastPermissionMode([askTerminal, conversation(1, "bypass")])).toBe("ask");
    expect(lastPermissionMode([conversation(3, "bypass"), askTerminal])).toBe("bypass");
    expect(lastPermissionMode([conversation(1, "ask"), terminal(2, "claude", ["claude"])])).toBe(
      "bypass",
    );
  });

  it("passes over rows that do not say, so they never undo an ask", () => {
    const ask = terminal(1, "claude", ["claude", "--permission-mode", "auto"]);
    expect(
      lastPermissionMode([
        ask,
        process("shell", at(2)),
        terminal(3, "shell", ["bash"]),
        terminal(4, "pi", ["pi"]),
        terminal(5, "claude", ["sh", "-c", "exec claude --dangerously-skip-permissions", "sh"]),
        process("agent-external", { ...at(6), harness: "claude", argv: ["claude"] }),
        process("agent-protocol", at(7)),
      ]),
    ).toBe("ask");
  });

  it("is undefined for a session no agent of which says", () => {
    expect(lastPermissionMode([])).toBeUndefined();
    expect(lastPermissionMode([process("shell"), terminal(1, "pi", ["pi"])])).toBeUndefined();
  });
});
