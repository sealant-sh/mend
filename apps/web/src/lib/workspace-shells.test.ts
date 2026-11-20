import { SealantRunId, SealantWorkspaceId, SessionId, SessionProcessId } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { SessionProcessDto } from "./api.ts";
import {
  exitWords,
  nextShell,
  openShells,
  openShellsFact,
  type ShellSession,
  shellAccess,
  shellLine,
  shellsThatExited,
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
  sharedControlUserIds: [],
  processes: [],
  ...overrides,
});

const NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};
const programName = (harness: string) => NAMES[harness] ?? harness;

describe("a workspace's shells", () => {
  it("lists every session's shells together, a session's own terminal first", () => {
    const shells = workspaceShells(
      [
        session("a", {
          harness: "claude",
          processes: [
            process("p1", "a", {
              label: "shell 1",
              createdAt: at(5),
              runsAs: "ada",
            }),
            process("agent", "a", {
              kind: "agent-pty",
              harness: "claude",
              createdAt: at(1),
            }),
          ],
        }),
        session("b", {
          processes: [
            process("p2", "b", {
              label: "shell 1",
              argv: ["bash"],
              createdAt: at(3),
            }),
          ],
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
            process("closed", "a", {
              status: "stopped",
              exitedAt: at(9),
              createdAt: at(7),
            }),
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
          processes: [
            process("cmd", "s", {
              kind: "agent-pty",
              harness: "shell",
              argv: ["bash"],
            }),
          ],
        }),
        session("c", {
          processes: [
            process("gone", "c", {
              kind: "agent-pty",
              status: "exited",
              exitedAt: at(4),
            }),
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
        session("a", {
          status: "idle",
          processes: [process("sh", "a", { status: "running" })],
        }),
      ]),
    ).toBe(true);
    expect(
      workspaceRuns([
        session("a", {
          status: "idle",
          processes: [process("x", "a", { kind: "screen" })],
        }),
      ]),
    ).toBe(false);
  });
});

describe("who watches and who types", () => {
  const sessions = [
    session("mine", { ownerUserId: "ada" }),
    session("shared", { ownerUserId: "grace", sharedControlEnabledAt: at(0) }),
    session("private", { ownerUserId: "grace" }),
    session("granted", { ownerUserId: "grace", sharedControlUserIds: ["ada"] }),
  ];

  it("lets the owner type, a steerer only watch, and anyone else neither", () => {
    const access = shellAccess(sessions, "shared", "ada");
    expect(
      ["mine", "shared", "private", "granted"].map((id) => [access.watches(id), access.types(id)]),
    ).toEqual([
      [true, true],
      [true, false],
      [false, false],
      // Shared with Ada alone (docs/adr/0026): she watches, and still types only in her own.
      [true, false],
    ]);
  });

  it("opens a new shell on the page's session when the viewer owns it, else on one they own", () => {
    expect(shellAccess(sessions, "mine", "ada").opensOn).toBe("mine");
    expect(shellAccess(sessions, "shared", "ada").opensOn).toBe("mine");
    expect(shellAccess(sessions, "shared", "grace").opensOn).toBe("shared");
    expect(shellAccess(sessions, "mine", "linus").opensOn).toBeNull();
  });
});

const nameOf = (id: string) => (id === "ada" ? "Ada Lovelace" : null);

const mine = (sessionId: string) => sessionId === "a";

describe("the shells the list holds", () => {
  const shells = workspaceShells(
    [
      session("a", {
        harness: "claude",
        processes: [
          process("agent", "a", {
            kind: "agent-pty",
            harness: "claude",
            createdAt: at(0),
          }),
          process("r", "a", {
            label: "shell 1",
            runsAs: "ada",
            createdAt: at(1),
          }),
          process("e", "a", {
            label: "shell 2",
            status: "exited",
            exitCode: 0,
            exitedAt: at(4),
            createdAt: at(2),
          }),
          process("x", "a", {
            label: "shell 3",
            status: "exited",
            exitCode: 137,
            exitedAt: at(4),
            createdAt: at(3),
          }),
          process("c", "a", {
            status: "stopped",
            exitedAt: at(4),
            createdAt: at(4),
          }),
        ],
      }),
      session("b", {
        ownerUserId: "grace",
        processes: [process("theirs", "b", {})],
      }),
    ],
    programName,
  );

  it("holds the open shells the person may see, and the tab counts exactly those", () => {
    const open = openShells(shells, mine);
    expect(open.map((shell) => shell.key)).toEqual(["session:a", "r"]);
    expect(openShellsFact(open)).toBe("2 shells");
    expect(openShellsFact(open.slice(1))).toBe("1 shell");
    expect(openShellsFact([])).toBeUndefined();
  });

  it("says what runs in a listed shell, and as whom", () => {
    const running = shells.find((shell) => shell.key === "r");
    expect(running && shellLine(running, nameOf)).toBe("zsh · Running · Ada Lovelace");
  });

  it("finds the shells that exited by themselves, with their codes, and not the closed one", () => {
    const exits = shellsThatExited(["session:a", "r", "e", "x", "c", "gone"], shells);
    expect(exits).toEqual([
      { key: "e", name: "Shell 2", processId: "e", exitCode: 0 },
      { key: "x", name: "Shell 3", processId: "x", exitCode: 137 },
    ]);
    expect(exits.map(exitWords)).toEqual(["Shell 2 exited.", "Shell 3 exited with code 137."]);
    expect(exitWords({ key: "n", name: "Shell 4", processId: "n", exitCode: null })).toBe(
      "Shell 4 ended.",
    );
  });

  it("moves to the shell after the one that left, else the one before, else none", () => {
    expect(nextShell(["a", "b", "c"], "b", ["a", "c"])).toBe("c");
    expect(nextShell(["a", "b", "c"], "c", ["a", "b"])).toBe("b");
    expect(nextShell(["a", "b", "c"], "b", ["a"])).toBe("a");
    expect(nextShell(["a"], "a", [])).toBeNull();
    expect(nextShell(["a"], "new", ["a"])).toBe("a");
  });
});
