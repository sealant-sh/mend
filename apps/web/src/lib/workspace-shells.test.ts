import { SealantRunId, SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionProcessDto } from "./api.ts";
import {
  runningShellsFact,
  type ShellSession,
  shellAccess,
  shellLine,
  workspaceRuns,
  workspaceShells,
} from "./workspace-shells.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 18, 10, minute));

const process = (
  id: string,
  sessionId: string,
  overrides: Partial<SessionProcessDto>,
): SessionProcessDto => ({
  id: SessionProcessId.make(id),
  sessionId: SessionId.make(sessionId),
  sealantWorkspaceId: SealantWorkspaceId.make("ws-2"),
  sealantSessionId: `pty-${id}`,
  sealantRunId: SealantRunId.make(`run-${id}`),
  launchCorrelationId: null,
  serviceId: null,
  attemptOrdinal: null,
  kind: "shell",
  harness: null,
  providerSessionId: null,
  protocolOptions: null,
  label: null,
  argv: ["/bin/zsh"],
  status: "running",
  exitCode: null,
  workspacePort: null,
  protocol: "tcp",
  hostPort: null,
  createdAt: at(0),
  firstOutputAt: null,
  exitedAt: null,
  updatedAt: at(0),
  runsAs: null,
  waiting: null,
  ...overrides,
});

const session = (id: string, overrides: Partial<ShellSession>): ShellSession => ({
  id,
  title: `Session ${id}`,
  harness: "codex",
  status: "running",
  ownerUserId: "ada",
  sharedControlEnabledAt: null,
  processes: [],
  ...overrides,
});

const NAMES: Readonly<Record<string, string>> = { claude: "Claude Code", codex: "Codex" };
const programName = (harness: string) => NAMES[harness] ?? harness;

describe("a workspace's shells", () => {
  it("lists every session's shells together, a session's own terminal first", () => {
    const shells = workspaceShells(
      [
        session("a", {
          harness: "claude",
          processes: [
            process("p1", "a", { label: "shell 1", createdAt: at(5), runsAs: "ada" }),
            process("agent", "a", { kind: "agent-pty", harness: "claude", createdAt: at(1) }),
          ],
        }),
        session("b", {
          processes: [process("p2", "b", { label: "shell 1", argv: ["bash"], createdAt: at(3) })],
        }),
      ],
      programName,
    );
    expect(shells.map((shell) => [shell.key, shell.name, shell.program, shell.processId])).toEqual([
      ["session:a", "Session a", "Claude Code", null],
      ["p2", "Shell 1", "bash", "p2"],
      ["p1", "Shell 1", "zsh", "p1"],
    ]);
  });

  it("keeps the shells that ended in the workspace's latest run, not those of runs before", () => {
    const shells = workspaceShells(
      [
        session("a", {
          status: "stopped",
          processes: [
            process("old", "a", {
              sealantWorkspaceId: SealantWorkspaceId.make("ws-1"),
              status: "exited",
              exitedAt: at(2),
              createdAt: at(1),
            }),
            process("ended", "a", {
              status: "exited",
              exitCode: 0,
              exitedAt: at(9),
              createdAt: at(6),
            }),
            process("closed", "a", { status: "stopped", exitedAt: at(9), createdAt: at(7) }),
          ],
        }),
      ],
      programName,
    );
    expect(shells.map((shell) => [shell.key, shell.live, shell.stopped])).toEqual([
      ["ended", false, false],
      ["closed", false, true],
    ]);
  });

  it("shows a shell session's own command by its program, and leaves out an agent that ended", () => {
    const shells = workspaceShells(
      [
        session("s", {
          harness: "shell",
          processes: [process("cmd", "s", { kind: "agent-pty", harness: "shell", argv: ["bash"] })],
        }),
        session("c", {
          processes: [
            process("gone", "c", { kind: "agent-pty", status: "exited", exitedAt: at(4) }),
          ],
        }),
      ],
      programName,
    );
    expect(shells.map((shell) => [shell.key, shell.program])).toEqual([["session:s", "bash"]]);
  });
});

describe("whether the workspace runs", () => {
  it("runs while a session runs or anything but a screen is live in it", () => {
    const stopped = session("a", { status: "stopped" });
    expect(workspaceRuns([stopped])).toBe(false);
    expect(workspaceRuns([stopped, session("b", { status: "waiting" })])).toBe(true);
    expect(
      workspaceRuns([
        session("a", { status: "idle", processes: [process("sh", "a", { status: "running" })] }),
      ]),
    ).toBe(true);
    expect(
      workspaceRuns([
        session("a", { status: "idle", processes: [process("x", "a", { kind: "screen" })] }),
      ]),
    ).toBe(false);
  });
});

describe("who watches and who types", () => {
  const sessions = [
    session("mine", { ownerUserId: "ada" }),
    session("shared", { ownerUserId: "grace", sharedControlEnabledAt: at(0) }),
    session("private", { ownerUserId: "grace" }),
  ];

  it("lets the owner type, a steerer only watch, and anyone else neither", () => {
    const access = shellAccess(sessions, "shared", "ada");
    expect(
      ["mine", "shared", "private"].map((id) => [access.watches(id), access.types(id)]),
    ).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
  });

  it("opens a new shell on the page's session when the viewer owns it, else on one they own", () => {
    expect(shellAccess(sessions, "mine", "ada").opensOn).toBe("mine");
    expect(shellAccess(sessions, "shared", "ada").opensOn).toBe("mine");
    expect(shellAccess(sessions, "shared", "grace").opensOn).toBe("shared");
    expect(shellAccess(sessions, "mine", "linus").opensOn).toBeNull();
  });
});

describe("what a shell's row says", () => {
  const ago = () => "9m";
  const nameOf = (id: string) => (id === "ada" ? "Ada Lovelace" : null);
  const [running, exited, closed] = workspaceShells(
    [
      session("a", {
        processes: [
          process("r", "a", { runsAs: "ada", createdAt: at(1) }),
          process("e", "a", { status: "exited", exitCode: 0, exitedAt: at(2), createdAt: at(2) }),
          process("c", "a", { status: "stopped", exitedAt: at(3), createdAt: at(3) }),
        ],
      }),
    ],
    programName,
  );

  it("says what runs, that it runs and as whom, or how it ended and when", () => {
    expect(running && shellLine(running, nameOf, ago)).toBe("zsh · Running · Ada Lovelace");
    expect(exited && shellLine(exited, nameOf, ago)).toBe("Exited with code 0 · 9m");
    expect(closed && shellLine(closed, nameOf, ago)).toBe("Closed · 9m");
  });

  it("counts the shells that run, for the tab", () => {
    expect(runningShellsFact([running, exited, closed].filter((each) => each !== undefined))).toBe(
      "1 shell",
    );
    expect(runningShellsFact([])).toBeUndefined();
  });
});
