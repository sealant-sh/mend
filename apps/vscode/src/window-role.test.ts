import { describe, expect, it } from "vitest";

import type { Project, Session, SessionProcess } from "./types.js";
import { agentTab, handoffRefusedLine, sessionOfWorkspace, windowRole } from "./window-role.js";

const ALIAS = "mend-ws-172-17-0-3-de2f165a9e5801413f7fb934";
const WORKSPACE = "61aaf28f-f715-4ce1-89be-8626d33acbb6";

const project: Project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session = (overrides: Partial<Session>): Session => ({
  id: "0a1b2c3d4e5f",
  projectId: project.id,
  harness: "claude",
  model: null,
  label: "add-rate-limit",
  worktree: "add-rate-limit",
  branch: "mend/add-rate-limit",
  status: "running",
  sealantWorkspaceId: WORKSPACE,
  summary: null,
  createdAt: "2026-10-19T09:00:00.000Z",
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: null,
  ...overrides,
});

const process = (overrides: Partial<SessionProcess>): SessionProcess => ({
  id: "process",
  kind: "agent-pty",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  label: null,
  ...overrides,
});

describe("windowRole", () => {
  it("reads a Mend workspace window's workspace id off its Remote-SSH authority", () => {
    expect(windowRole("ssh-remote", [`ssh-remote+ws-${WORKSPACE}@${ALIAS}`])).toEqual({
      kind: "workspace",
      workspaceId: WORKSPACE,
    });
  });

  it("takes the trailing id when the username prefix holds dashes", () => {
    expect(windowRole("ssh-remote", [`ssh-remote+mend-ws-dev-${WORKSPACE}@${ALIAS}`])).toEqual({
      kind: "workspace",
      workspaceId: WORKSPACE,
    });
  });

  it("is local for a local window, another SSH host, or a user with no workspace id", () => {
    expect(windowRole(undefined, [])).toEqual({ kind: "local" });
    expect(windowRole("ssh-remote", [`ssh-remote+ws-${WORKSPACE}@build-box`])).toEqual({
      kind: "local",
    });
    expect(windowRole("ssh-remote", [`ssh-remote+dana@${ALIAS}`])).toEqual({ kind: "local" });
  });
});

describe("sessionOfWorkspace", () => {
  it("finds the session the workspace holds, the live one first", () => {
    const stopped = session({ id: "older", status: "stopped", createdAt: "2026-10-19T10:00:00Z" });
    const live = session({ id: "live" });
    const elsewhere = session({ id: "other", sealantWorkspaceId: "another" });
    expect(
      sessionOfWorkspace([{ project, sessions: [stopped, elsewhere, live] }], WORKSPACE),
    ).toEqual({ project, session: live });
    expect(sessionOfWorkspace([{ project, sessions: [elsewhere] }], WORKSPACE)).toBeNull();
  });

  it("finds the session an Open meant, over a newer live one in the same worktree", () => {
    const older = session({ id: "older", createdAt: "2026-10-19T09:00:00Z" });
    const newer = session({ id: "newer", createdAt: "2026-10-19T10:00:00Z" });
    const details = [{ project, sessions: [older, newer] }];
    expect(sessionOfWorkspace(details, WORKSPACE, "older")).toEqual({ project, session: older });
    expect(sessionOfWorkspace(details, WORKSPACE)).toEqual({ project, session: newer });
    expect(sessionOfWorkspace(details, WORKSPACE, "gone")).toEqual({ project, session: newer });
  });
});

describe("agentTab", () => {
  const owner = session({});

  it("attaches the newest live terminal agent, named for its harness and the session", () => {
    expect(
      agentTab(owner, [
        process({ id: "old-claude", exitedAt: "2026-10-19T08:00:00Z", status: "exited" }),
        process({ id: "shell", kind: "shell", harness: null }),
        process({ id: "claude" }),
      ]),
    ).toEqual({ kind: "pty", processId: "claude", name: "claude · add-rate-limit" });
  });

  it("shows a conversation's line, naming where it came from", () => {
    expect(
      agentTab(owner, [process({ id: "web", kind: "agent-protocol", label: "your phone" })]),
    ).toEqual({
      kind: "conversation",
      processId: "web",
      name: "claude · add-rate-limit",
      line: "claude is running as a conversation (from your phone) · Continue here to type to it",
    });
    expect(agentTab(owner, [process({ kind: "agent-protocol", label: "claude" })])).toMatchObject({
      line: "claude is running as a conversation (from your phone or the web) · Continue here to type to it",
    });
  });

  it("falls back to a live shell, and to nothing", () => {
    expect(
      agentTab(owner, [
        process({ kind: "agent-protocol", status: "exited", exitedAt: "2026-10-19T08:00:00Z" }),
        process({ id: "shell", kind: "shell", harness: null }),
      ]),
    ).toEqual({ kind: "pty", processId: "shell", name: "shell · add-rate-limit" });
    expect(agentTab(owner, [process({ kind: "service" })])).toEqual({ kind: "none" });
  });

  it("names an unlabelled session's tab by what runs in it and the short id, said once", () => {
    expect(agentTab(session({ label: null }), [process({ id: "claude" })])).toMatchObject({
      name: "claude · 0a1b2c3d",
    });
    expect(
      agentTab(session({ label: null }), [process({ id: "shell", harness: "shell" })]),
    ).toMatchObject({ name: "shell · 0a1b2c3d" });
  });
});

describe("handoffRefusedLine", () => {
  it("says the harness cannot continue in a terminal when the server says HandoffUnsupported", () => {
    expect(
      handoffRefusedLine("opencode", {
        tag: "HandoffUnsupported",
        words: "This session's agent cannot hand off to that one.",
      }),
    ).toBe("opencode can't continue in a terminal yet · open the terminal to watch");
  });

  it("says the server's own sentence for any other refusal, never that claude cannot continue", () => {
    const words = "No saved harness state to reopen as a terminal — resume the session instead.";
    expect(handoffRefusedLine("claude", { tag: "StoreFailure", words })).toBe(words);
    expect(handoffRefusedLine("claude", { tag: null, words })).toBe(words);
  });
});
