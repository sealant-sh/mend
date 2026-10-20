import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AgentTabs,
  type AgentTabEffects,
  type AgentTabHandle,
  type ConversationTabHandle,
} from "./agent-tabs.js";
import { OpenIntents } from "./open-intent.js";
import type { Project, Session, SessionDetail, SessionProcess } from "./types.js";
import { sessionOfWorkspace } from "./window-role.js";

const WORKSPACE = "61aaf28f-f715-4ce1-89be-8626d33acbb6";

/** What a session read throws once Mend no longer has the session. */
class Gone extends Error {}

const project: Project = {
  id: "project-1",
  name: "newsroom-api",
  originUrl: null,
  storePath: "/store/newsroom-api",
  defaultBranch: "main",
};

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "older",
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
  settledAt: null,
  ownerUserId: "dana",
  livePeople: [],
  sharedControlEnabledAt: null,
  workspaceRetirement: null,
  workspaceLauncherUserId: "dana",
  ...overrides,
});

const process = (overrides: Partial<SessionProcess>): SessionProcess => ({
  id: "process",
  kind: "agent-pty",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  runsAs: null,
  label: null,
  waiting: null,
  ...overrides,
});

const detail = (
  processes: ReadonlyArray<SessionProcess>,
  of: Session = session(),
): SessionDetail => ({
  session: of,
  processes,
  currentAgent: null,
  changeId: null,
});

interface FakeTab extends ConversationTabHandle {
  readonly label: string;
  readonly lines: Array<string>;
  shows: number;
  disposed: boolean;
  ended: boolean;
}

const fakeTab = (label: string, lines: ReadonlyArray<string> = []): FakeTab => {
  const tab: FakeTab = {
    label,
    lines: [...lines],
    shows: 1,
    disposed: false,
    ended: false,
    show: () => {
      tab.shows += 1;
    },
    dispose: () => {
      tab.disposed = true;
    },
    live: () => !tab.disposed && !tab.ended,
    say: (line) => {
      tab.lines.push(line);
    },
  };
  return tab;
};

/** A window's tabs over a server whose session reads are `reads`, the last one repeating. */
const world = (
  reads: ReadonlyArray<SessionDetail | Error>,
  overrides: Partial<AgentTabEffects> = {},
) => {
  const queue = [...reads];
  let clock = 0;
  const tabs: Array<FakeTab> = [];
  const effects = {
    detail: vi.fn(async (_id: string) => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error("the test world has no session read");
      if (next instanceof Error) throw next;
      return next;
    }),
    viewer: async (): Promise<string | null> => "dana",
    ownerName: async () => "Ana",
    attachPty: vi.fn(async (facts: { readonly processId: string }): Promise<AgentTabHandle> => {
      const tab = fakeTab(`pty:${facts.processId}`);
      tabs.push(tab);
      return tab;
    }),
    showConversation: vi.fn((facts: { readonly lines: ReadonlyArray<string> }) => {
      const tab = fakeTab("conversation", facts.lines);
      tabs.push(tab);
      return tab;
    }),
    handoff: vi.fn(async (_id: string) => undefined),
    gone: (cause: unknown) => cause instanceof Gone,
    refusal: () => null,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    onError: vi.fn(),
    refused: vi.fn(),
    ...overrides,
  } satisfies AgentTabEffects;
  return {
    effects,
    tabs,
    agents: new AgentTabs(effects, { handoffWaitMs: 5000, pollMs: 1000 }),
  };
};

const conversation = process({
  id: "web",
  kind: "agent-protocol",
  label: "your phone",
});
const terminalAgent = process({ id: "claude-pty" });

describe("a workspace window holding two live sessions", () => {
  it("attaches the agent of the older session the Open meant, not the newer one's", async () => {
    const older = session({
      id: "older",
      createdAt: "2026-10-19T09:00:00.000Z",
    });
    const newer = session({
      id: "newer",
      createdAt: "2026-10-19T10:00:00.000Z",
    });
    const intents = new OpenIntents(await mkdtemp(join(tmpdir(), "mend-intents-")));
    await intents.write({ workspaceId: WORKSPACE, sessionId: "older" });

    const located = sessionOfWorkspace(
      [{ project, sessions: [older, newer] }],
      WORKSPACE,
      await intents.take(WORKSPACE),
    );
    expect(located).toMatchObject({ kind: "found", session: { id: "older" } });

    const reads = new Map([
      ["older", detail([process({ id: "older-pty" })], older)],
      ["newer", detail([process({ id: "newer-pty" })], newer)],
    ]);
    const { effects, agents } = world([], {
      detail: vi.fn(async (id: string) => {
        const read = reads.get(id);
        if (read === undefined) throw new Error(`no session ${id}`);
        return read;
      }),
    });
    await agents.focus(located.kind === "found" ? located.session.id : "", WORKSPACE);
    expect(effects.attachPty).toHaveBeenCalledTimes(1);
    expect(effects.attachPty).toHaveBeenCalledWith(
      expect.objectContaining({ processId: "older-pty" }),
    );
  });
});

describe("focusing a session's agent", () => {
  it("shows its tab while that process still is the agent, without attaching again", async () => {
    const { effects, agents, tabs } = world([detail([terminalAgent])]);
    await agents.focus("older", WORKSPACE);
    await agents.focus("older", WORKSPACE);
    expect(effects.attachPty).toHaveBeenCalledTimes(1);
    expect(tabs[0]?.shows).toBe(2);
  });

  it("never shows a tab whose process ended as if live: it attaches the agent again", async () => {
    const { effects, agents, tabs } = world([detail([terminalAgent])]);
    await agents.focus("older", WORKSPACE);
    const ended = tabs[0];
    if (ended === undefined) throw new Error("no tab attached");
    ended.ended = true;
    await agents.focus("older", WORKSPACE);
    expect(ended.shows).toBe(1);
    expect(ended.disposed).toBe(true);
    expect(effects.attachPty).toHaveBeenCalledTimes(2);
  });

  it("attaches nothing when Mend could not read who she is, and says why", async () => {
    const { effects, agents } = world([detail([terminalAgent])], { viewer: async () => null });
    await agents.focus("older", WORKSPACE);
    expect(effects.attachPty).not.toHaveBeenCalled();
    expect(effects.showConversation).not.toHaveBeenCalled();
    expect(effects.refused).toHaveBeenCalledWith(
      "Mend could not read who you are on this server · no agent attached",
    );
  });

  it("attaches nothing for a workspace someone else launched, shared control on or not", async () => {
    const anas = session({
      ownerUserId: "ana",
      workspaceLauncherUserId: "ana",
      sharedControlEnabledAt: "2026-10-19T09:00:00.000Z",
    });
    const { effects, agents } = world([detail([terminalAgent], anas)]);
    await agents.focus("older", WORKSPACE);
    expect(effects.attachPty).not.toHaveBeenCalled();
    expect(effects.refused).toHaveBeenCalledWith(
      "another person launched this workspace · Remote-SSH opens it only for them · no agent attached",
    );
  });

  it("answers her own conversation from a workspace Ana launched, with Continue here", async () => {
    const mine = session({ workspaceLauncherUserId: "ana" });
    const asked = world([detail([conversation], mine)]);
    await asked.agents.focus("older", null);
    const tab = asked.tabs[0];
    if (tab === undefined) throw new Error("no conversation tab");
    expect(asked.agents.continueOffered(tab)).toBe("older");
  });

  it("answers nothing of Ana's from a workspace she launched, shared control on or not", async () => {
    const anas = session({
      ownerUserId: "ana",
      workspaceLauncherUserId: "ana",
      sharedControlEnabledAt: "2026-10-19T09:00:00.000Z",
    });
    const asked = world([detail([conversation], anas)]);
    await asked.agents.focus("older", null);
    expect(asked.tabs).toEqual([]);
    const terminal = world([detail([terminalAgent], anas)]);
    await terminal.agents.focus("older", null);
    expect(terminal.effects.attachPty).not.toHaveBeenCalled();
  });

  it("names the session a tab shows, and none for a tab it did not attach", async () => {
    const { agents, tabs } = world([detail([terminalAgent])]);
    await agents.focus("older", null);
    const tab = tabs[0];
    if (tab === undefined) throw new Error("no tab attached");
    expect(agents.sessionOf(tab)).toBe("older");
    agents.forget(tab);
    expect(agents.sessionOf(tab)).toBeNull();
  });

  it("forgets a tab she closed: it offers nothing more, and the next focus attaches anew", async () => {
    const { effects, agents, tabs } = world([detail([conversation])]);
    await agents.focus("older", WORKSPACE);
    const closed = tabs[0];
    if (closed === undefined) throw new Error("no tab attached");
    expect(agents.continueOffered(closed)).toBe("older");
    agents.forget(closed);
    expect(agents.continueOffered(closed)).toBeNull();
    await agents.focus("older", WORKSPACE);
    expect(closed.shows).toBe(1);
    expect(effects.showConversation).toHaveBeenCalledTimes(2);
  });

  it("replaces a terminal tab once the phone moved the agent into a conversation", async () => {
    const { effects, agents, tabs } = world([
      detail([terminalAgent]),
      detail([
        {
          ...terminalAgent,
          status: "exited",
          exitedAt: "2026-10-19T10:00:00Z",
        },
        conversation,
      ]),
    ]);
    await agents.focus("older", WORKSPACE);
    await agents.focus("older", WORKSPACE);
    expect(tabs[0]?.disposed).toBe(true);
    expect(tabs[0]?.shows).toBe(1);
    expect(effects.showConversation).toHaveBeenCalledTimes(1);
    expect(tabs[1]?.lines).toEqual([
      "claude is running as a conversation (from your phone) · Continue here to type to it",
    ]);
  });

  it("replaces a conversation's tab once the agent runs in a terminal", async () => {
    const { effects, agents, tabs } = world([detail([conversation]), detail([terminalAgent])]);
    await agents.focus("older", WORKSPACE);
    await agents.focus("older", WORKSPACE);
    expect(tabs[0]?.disposed).toBe(true);
    expect(effects.attachPty).toHaveBeenCalledWith(
      expect.objectContaining({ processId: "claude-pty" }),
    );
  });
});

describe("Continue here", () => {
  it("runs one handoff for a double click, and offers no link while it runs", async () => {
    const handoff = Promise.withResolvers<void>();
    const { effects, agents, tabs } = world([detail([conversation]), detail([terminalAgent])], {
      handoff: vi.fn(() => handoff.promise),
    });
    await agents.focus("older", WORKSPACE);
    const tab = tabs[0];
    if (tab === undefined) throw new Error("no conversation tab");
    expect(agents.continueOffered(tab)).toBe("older");
    const first = agents.continueHere("older");
    const second = agents.continueHere("older");
    expect(agents.continueOffered(tab)).toBeNull();
    handoff.resolve();
    await Promise.all([first, second]);
    expect(effects.handoff).toHaveBeenCalledTimes(1);
    expect(effects.attachPty).toHaveBeenCalledTimes(1);
    expect(tab.disposed).toBe(true);
  });

  it("keeps the conversation's tab and its link when attaching fails after the handoff", async () => {
    const { effects, agents, tabs } = world([
      detail([conversation]),
      new Error("Mend did not answer in 30 s"),
      detail([terminalAgent]),
    ]);
    await agents.focus("older", WORKSPACE);
    const tab = tabs[0];
    if (tab === undefined) throw new Error("no conversation tab");
    await agents.continueHere("older");
    expect(effects.handoff).toHaveBeenCalledTimes(1);
    expect(tab.disposed).toBe(false);
    expect(tab.lines.at(-1)).toBe("Mend did not answer in 30 s · Continue here to try again");
    expect(agents.continueOffered(tab)).toBe("older");

    await agents.continueHere("older");
    expect(effects.handoff).toHaveBeenCalledTimes(2);
    expect(effects.attachPty).toHaveBeenCalledTimes(1);
    expect(tab.disposed).toBe(true);
    expect(effects.onError).not.toHaveBeenCalled();
  });

  it("keeps the conversation's tab when the terminal itself fails to attach", async () => {
    let failures = 1;
    const { effects, agents, tabs } = world([detail([conversation]), detail([terminalAgent])], {
      attachPty: vi.fn(async (): Promise<AgentTabHandle> => {
        if (failures-- > 0) throw new Error("Mend refused the terminal");
        return fakeTab("pty");
      }),
    });
    await agents.focus("older", WORKSPACE);
    const tab = tabs[0];
    if (tab === undefined) throw new Error("no conversation tab");
    await agents.continueHere("older");
    expect(tab.disposed).toBe(false);
    expect(tab.lines.at(-1)).toBe("Mend refused the terminal · Continue here to try again");
    await agents.continueHere("older");
    expect(effects.attachPty).toHaveBeenCalledTimes(2);
    expect(tab.disposed).toBe(true);
  });

  it("says why when the server refuses, and attaches nothing", async () => {
    const { effects, agents, tabs } = world([detail([conversation])], {
      handoff: vi.fn(async () => {
        throw new Error("refused");
      }),
      refusal: () => ({ tag: "HandoffUnsupported", words: "refused" }),
    });
    await agents.focus("older", WORKSPACE);
    await agents.continueHere("older");
    expect(tabs[0]?.lines.at(-1)).toBe(
      "claude can't continue in a terminal yet · open the terminal to watch",
    );
    expect(effects.attachPty).not.toHaveBeenCalled();
  });

  it("is not offered on a conversation that is someone else's", async () => {
    const anas = session({
      ownerUserId: "ana",
      sharedControlEnabledAt: "2026-10-19T09:00:00Z",
    });
    const { agents, tabs } = world([detail([conversation], anas)]);
    await agents.focus("older", WORKSPACE);
    const tab = tabs[0];
    if (tab === undefined) throw new Error("no conversation tab");
    expect(tab.lines).toEqual(["read-only · Ana's session"]);
    expect(agents.continueOffered(tab)).toBeNull();
  });
});

describe("a window asked again for the session it already shows", () => {
  it("attaches nothing for a session Mend deleted, and says so instead of an error", async () => {
    const { effects, agents, tabs } = world([new Gone("404")]);
    await agents.focus("older", WORKSPACE);
    expect(tabs).toHaveLength(0);
    expect(effects.onError).not.toHaveBeenCalled();
    expect(effects.refused).toHaveBeenCalledWith(
      "Mend lists no session older now · no agent attached",
    );
  });

  it("attaches nothing for a session that moved to another workspace", async () => {
    const moved = session({ id: "older", sealantWorkspaceId: "another-workspace" });
    const { effects, agents, tabs } = world([detail([process({ id: "moved-pty" })], moved)]);
    await agents.focus("older", WORKSPACE);
    expect(tabs).toHaveLength(0);
    expect(effects.attachPty).not.toHaveBeenCalled();
    expect(effects.refused).toHaveBeenCalledWith(
      "add-rate-limit is running and not in this workspace · no agent attached",
    );
  });

  it("attaches a session in any workspace when Answer names none", async () => {
    const elsewhere = session({ id: "older", sealantWorkspaceId: "another-workspace" });
    const { agents, tabs } = world([detail([process({ id: "answered-pty" })], elsewhere)]);
    await agents.focus("older", null);
    expect(tabs.map((tab) => tab.label)).toEqual(["pty:answered-pty"]);
  });
});
