import { setTimeout as wait } from "node:timers/promises";

import { describe, expect, it, vi } from "vitest";

import { MendClient } from "./client.js";
import { fake } from "./test-vscode.js";
import type { Project, Session, SessionDetail, SessionProcess } from "./types.js";
import { WorkspaceWindow } from "./workspace-window.js";

const attached = vi.hoisted(() => [] as Array<string>);

vi.mock("vscode", async () => {
  const base = await import("./test-vscode.js");
  return {
    ...base,
    TerminalLink: class {
      constructor(
        readonly startIndex: number,
        readonly length: number,
        readonly tooltip?: string,
      ) {}
    },
    window: {
      ...base.window,
      activeTerminal: undefined,
      registerTerminalLinkProvider: () => ({ dispose: () => undefined }),
      onDidCloseTerminal: () => ({ dispose: () => undefined }),
      createTerminal: vi.fn(),
    },
  };
});

vi.mock("./agent-terminal.js", () => ({
  memberName: async () => "Dana",
  attachTerminal: async (_client: unknown, facts: { readonly session: Session }) => {
    attached.push(facts.session.id);
    return { show: () => undefined, dispose: () => undefined, exitStatus: undefined };
  },
}));

const WORKSPACE = "61aaf28f-f715-4ce1-89be-8626d33acbb6";

const project: Project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session = (id: string, createdAt: string): Session => ({
  id,
  projectId: project.id,
  harness: "claude",
  model: null,
  label: id,
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: WORKSPACE,
  summary: null,
  createdAt,
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: "dana",
});

const terminal = (id: string): SessionProcess => ({
  id: `${id}-pty`,
  kind: "agent-pty",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  runsAs: null,
  label: null,
  waiting: null,
});

describe("a workspace window that starts as it gains focus", () => {
  it("shows the session the Open meant, and attaches one agent tab", async () => {
    const older = session("older", "2026-10-19T09:00:00.000Z");
    const newer = session("newer", "2026-10-19T10:00:00.000Z");
    const sessions = new Map([
      [older.id, older],
      [newer.id, newer],
    ]);
    let intent: string | null = "older";
    let takes = 0;
    const intents = {
      take: async (): Promise<string | null> => {
        takes += 1;
        if (takes === 1) await wait(5);
        const taken = intent;
        intent = null;
        return taken;
      },
    };
    let reads = 0;
    const offline = {
      get: async () => ({ url: "http://mend.test", token: null }),
      refused: async () => undefined,
      held: async () => ({
        connection: { url: "http://mend.test", token: null },
        current: () => true,
      }),
    };
    const client = Object.assign(new MendClient(offline), {
      listProjects: async () => [project],
      projectDetail: async () => {
        reads += 1;
        await wait(reads === 1 ? 30 : 1);
        return { project, sessions: [older, newer] };
      },
      viewerId: async () => "dana",
      sessionDetail: async (id: string): Promise<SessionDetail> => {
        const of = sessions.get(id);
        if (of === undefined) throw new Error(`no session ${id}`);
        return {
          session: of,
          processes: [terminal(id)],
          currentAgent: null,
          changeId: null,
          launchAdmission: null,
        };
      },
    });
    const onError = vi.fn();
    const window = new WorkspaceWindow(
      client,
      { kind: "workspace", workspaceId: WORKSPACE },
      intents,
      onError,
    );
    window.start();
    fake.focus(true);
    await vi.waitFor(() => expect(takes).toBe(2));
    await wait(80);
    expect(onError).not.toHaveBeenCalled();
    expect(window.session()?.session.id).toBe("older");
    expect(attached).toEqual(["older"]);
    window.dispose();
  });
});
