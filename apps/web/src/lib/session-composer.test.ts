import type { TurnSelection } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { TurnView } from "./conversation.ts";
import {
  composerMode,
  currentSelection,
  othersOpenTurn,
  ownRunningTurn,
  sameSelection,
  shownStatus,
} from "./session-composer.ts";

const turn = (
  id: string,
  ordinal: number,
  status: string,
  author: string,
  selection: TurnSelection | null = null,
): TurnView => ({
  id,
  sessionId: "s-1",
  ordinal,
  origin: "request",
  author,
  billedUserId: author,
  billedAccountName: null,
  steerSender: author,
  fromSteer: null,
  clientMessageId: null,
  steers: [],
  input: `ask ${ordinal}`,
  status,
  error: null,
  createdAt: "2026-11-18T10:00:00.000Z",
  startedAt: "2026-11-18T10:00:01.000Z",
  endedAt: null,
  selection,
});

const session = {
  status: "running" as const,
  harness: "claude",
  importedConversationWaiting: false,
};

describe("the composer under a session's conversation", () => {
  it.each([
    ["a live conversation takes messages", session, "agent-protocol", true, true, "conversation"],
    [
      "a live terminal agent takes words in its terminal",
      session,
      "agent-pty",
      true,
      true,
      "terminal",
    ],
    [
      "a stopped conversation comes back for the next message",
      { ...session, status: "stopped" as const },
      "agent-protocol",
      true,
      false,
      "conversation",
    ],
    [
      "a stopped terminal session can't take one here",
      { ...session, status: "stopped" as const },
      "agent-pty",
      true,
      false,
      "not-running",
    ],
    [
      "a viewer who doesn't steer the session can't send",
      session,
      "agent-protocol",
      false,
      true,
      "no-control",
    ],
    [
      "an imported conversation waits for its first message",
      { ...session, status: "idle" as const, importedConversationWaiting: true },
      null,
      true,
      false,
      "first-message",
    ],
    [
      "a session whose agent hasn't started waits for it",
      { ...session, status: "starting" as const },
      null,
      true,
      false,
      "starting",
    ],
  ] as const)("%s", (_what, at, kind, steer, agentLive, mode) => {
    expect(
      composerMode({
        session: at,
        currentAgent: kind === null ? null : { kind },
        steer,
        agentLive,
      })._tag,
    ).toBe(mode);
  });

  it("says a stopped conversation comes back when it takes the message", () => {
    expect(
      composerMode({
        session: { ...session, status: "stopped" },
        currentAgent: { kind: "agent-protocol" },
        steer: true,
        agentLive: false,
      }),
    ).toEqual({ _tag: "conversation", resumes: true });
  });
});

describe("whose turn runs", () => {
  const turns = [turn("t-1", 0, "completed", "ada"), turn("t-2", 1, "running", "grace")];

  it("steers only the viewer's own running turn; another person's turn makes a message wait", () => {
    expect(ownRunningTurn(turns, "grace")?.id).toBe("t-2");
    expect(ownRunningTurn(turns, "ada")).toBeNull();
    expect(othersOpenTurn(turns, "ada")?.id).toBe("t-2");
    expect(othersOpenTurn(turns, "grace")).toBeNull();
  });
});

describe("the model, thinking and permission a session's next turn runs with", () => {
  const launched = { model: "sonnet", effort: "low" as const, permissionMode: "ask" as const };
  const sessionModel = { harness: "claude", model: "opus", effort: null };

  it("is what its newest turn was sent with", () => {
    const sent: TurnSelection = {
      harness: "claude",
      model: "opus",
      effort: "high",
      interactionMode: "default",
      speed: "fast",
      permissionMode: "bypass",
    };
    const turns = [turn("t-1", 0, "completed", "ada", sent), turn("t-2", 1, "completed", "ada")];
    expect(currentSelection(turns, sessionModel, launched)).toEqual(sent);
  });

  it("is what its agent was launched with before any turn recorded one", () => {
    expect(currentSelection([], sessionModel, launched)).toEqual({
      harness: "claude",
      model: "sonnet",
      effort: "low",
      interactionMode: "default",
      permissionMode: "ask",
    });
  });

  it("is nothing to pick for an agent with no choice per turn", () => {
    expect(currentSelection([], { ...sessionModel, harness: "pi" }, null)).toBeNull();
  });

  it("treats a missing speed and permission as Standard and skipping prompts", () => {
    const base = currentSelection([], sessionModel, null);
    expect(base).not.toBeNull();
    if (base === null) return;
    expect(sameSelection(base, { ...base, speed: "standard", permissionMode: "bypass" })).toBe(
      true,
    );
    expect(sameSelection(base, { ...base, permissionMode: "ask" })).toBe(false);
  });
});

describe("the status word on the session's tab", () => {
  it("is Idle once the person stopped the newest turn", () => {
    expect(shownStatus("running", [turn("t-1", 0, "interrupted", "ada")])).toBe("idle");
  });

  it("keeps the server's word while a turn runs, or after one that finished", () => {
    expect(
      shownStatus("running", [
        turn("t-1", 0, "interrupted", "ada"),
        turn("t-2", 1, "running", "ada"),
      ]),
    ).toBe("running");
    expect(shownStatus("running", [turn("t-1", 0, "completed", "ada")])).toBe("running");
    expect(shownStatus("stopped", [turn("t-1", 0, "interrupted", "ada")])).toBe("stopped");
  });
});
