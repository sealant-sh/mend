import { ChangeId, ChangeLandingId, ProjectId, SessionId, Sha } from "@mend/domain";
import { ChangeLanding, type AgentTurnStatus } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { LandingReport } from "../src/landing.ts";
import { workspaceLandLines, workspaceLandRefusal } from "../src/workspace-land.ts";

const NOW = new Date("2026-09-27T12:00:00.000Z");
const PUSHED = Sha.make("3f2a1c0".padEnd(40, "0"));

const session = (ownerUserId: string | null, shared = false) => ({
  ownerUserId,
  sharedControlEnabledAt: shared ? NOW : null,
});

const turn = (status: AgentTurnStatus, author: string | null) => ({ status, author });

describe("mend land: who it lands for (docs/adr/0007, Who lands)", () => {
  it("lands the owner's own request, in their session", () => {
    expect(
      workspaceLandRefusal({
        session: session("alice"),
        changeOwnerUserId: "alice",
        turns: [turn("completed", "alice"), turn("running", "alice")],
      }),
    ).toBeNull();
  });

  it("refuses a change with no owner, and a session a teammate started in the owner's worktree", () => {
    expect(
      workspaceLandRefusal({ session: session("alice"), changeOwnerUserId: null, turns: [] }),
    ).toBe("not landed · the change has no owner");
    expect(
      workspaceLandRefusal({ session: session("bob"), changeOwnerUserId: "alice", turns: [] }),
    ).toBe("not landed · only the change's owner lands it · this session is not theirs");
  });

  it("refuses a turn someone else sent under shared control", () => {
    expect(
      workspaceLandRefusal({
        session: session("alice", true),
        changeOwnerUserId: "alice",
        turns: [turn("running", "bob")],
      }),
    ).toBe("not landed · only the change's owner lands it · someone else sent this turn");
  });

  it("in a terminal session, lands only while nobody else can be typing", () => {
    expect(
      workspaceLandRefusal({ session: session("alice"), changeOwnerUserId: "alice", turns: [] }),
    ).toBeNull();
    expect(
      workspaceLandRefusal({
        session: session("alice", true),
        changeOwnerUserId: "alice",
        turns: [],
      }),
    ).toBe("not landed · shared control is on · the change's owner lands it from Mend");
  });
});

const report = (row: ChangeLanding, pullRequest: LandingReport["pullRequest"]): LandingReport => ({
  landing: row,
  pullRequest,
});

describe("mend land: what it prints", () => {
  const landing = (overrides: Partial<ChangeLanding> = {}) =>
    new ChangeLanding({
      id: ChangeLandingId.make("landing-1"),
      changeId: ChangeId.make("change-1"),
      sessionId: SessionId.make("session-1"),
      projectId: ProjectId.make("project-1"),
      checkpointId: null,
      checkpointRef: null,
      checkpointSha: null,
      commitSha: null,
      remoteBranch: "mend/fix-login",
      pushedSha: PUSHED,
      trigger: "manual",
      pullRequest: null,
      outcome: "pushed",
      message: null,
      userId: "alice",
      createdAt: NOW,
      ...overrides,
    });

  it("prints the push and the pull request as observed, then its URL", () => {
    const pullRequest = {
      number: 412,
      url: "https://github.com/acme/api/pull/412",
      state: "open" as const,
      observedAt: NOW,
    };
    expect(
      workspaceLandLines(
        report(landing({ outcome: "pull-request", pullRequest }), {
          _tag: "opened",
          pullRequest,
        }),
      ),
    ).toEqual({
      landed: true,
      lines: [
        "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · open · observed",
        "https://github.com/acme/api/pull/412",
      ],
    });
  });

  it("prints a push with no pull request, and why", () => {
    expect(
      workspaceLandLines(
        report(landing(), { _tag: "unavailable", reason: "origin is not on GitHub" }),
      ),
    ).toEqual({
      landed: true,
      lines: ["pushed · mend/fix-login · 3f2a1c0 · origin is not on GitHub"],
    });
  });

  it("reports a refusal and a failed step in the remote's words, as not landed", () => {
    expect(
      workspaceLandLines(
        report(landing({ outcome: "refused", pushedSha: null, message: "origin has moved" }), {
          _tag: "not-reached",
        }),
      ),
    ).toEqual({ landed: false, lines: ["push refused · mend/fix-login · origin has moved"] });
    expect(
      workspaceLandLines(
        report(landing({ outcome: "failed", message: "gh: not logged in" }), {
          _tag: "failed",
          message: "gh: not logged in",
        }),
      ),
    ).toEqual({
      landed: false,
      lines: ["pushed · mend/fix-login · 3f2a1c0 · pull request step failed · gh: not logged in"],
    });
  });
});
