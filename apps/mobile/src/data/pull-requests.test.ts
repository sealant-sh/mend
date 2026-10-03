import {
  buildAgentConversation,
  type AgentItemDto,
  type AgentTurnDto,
} from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import { reconcileConversation } from "./pending-turns";
import {
  changedSinceLanding,
  newestPullRequest,
  pullRequestCards,
  pullRequestFact,
  pullRequestOrigin,
  withPullRequests,
  type ChangeLandingDto,
} from "./pull-requests";

const landing = (
  id: string,
  createdAt: string,
  overrides: Partial<ChangeLandingDto> = {},
): ChangeLandingDto => ({
  id,
  remoteBranch: "fix/login",
  trigger: "adopted",
  pullRequest: {
    number: 413,
    url: "https://github.com/acme/api/pull/413",
    state: "open",
    title: "Fix the login flake",
    observedAt: createdAt,
  },
  createdAt,
  ...overrides,
});

const turn = (id: string, ordinal: number, createdAt: string): AgentTurnDto => ({
  id,
  ordinal,
  input: `request ${ordinal}`,
  status: "completed",
  error: null,
  createdAt,
});

const item = (id: string, turnId: string, createdAt: string): AgentItemDto => ({
  id,
  seq: 0,
  turnId,
  kind: "assistant-message",
  status: "completed",
  title: null,
  text: id,
  createdAt,
  updatedAt: createdAt,
});

describe("pull request cards", () => {
  it("shows each pull request once, as the newest landing reports it, opened where it first was", () => {
    const cards = pullRequestCards([
      // Newest first, as the server sends them: Mend's landing later updated the adopted one.
      landing("l-3", "2026-10-03T09:20:00Z", {
        trigger: "automatic",
        remoteBranch: "fix/login",
        pullRequest: {
          number: 413,
          url: "https://github.com/acme/api/pull/413",
          state: "merged",
          title: "Fix the login flake for good",
          observedAt: "2026-10-03T09:30:00Z",
        },
      }),
      landing("l-2", "2026-10-03T09:10:00Z", { trigger: "manual", pullRequest: null }),
      landing("l-1", "2026-10-03T09:05:00Z"),
    ]);
    expect(cards).toEqual([
      {
        number: 413,
        url: "https://github.com/acme/api/pull/413",
        state: "merged",
        title: "Fix the login flake for good",
        observedAt: "2026-10-03T09:30:00Z",
        branch: "fix/login",
        outside: true,
        fork: null,
        landingId: "l-3",
        recordedAt: "2026-10-03T09:05:00Z",
      },
    ]);
    const [card] = cards;
    expect(card === undefined ? null : pullRequestOrigin(card)).toBe("opened outside Mend");
  });

  it("names a fork, and keeps the newest pull request for a review", () => {
    const fork = landing("l-1", "2026-10-03T09:05:00Z", {
      pullRequestCrossRepository: true,
      pullRequestHeadOwner: "anna",
    });
    const second = landing("l-2", "2026-10-03T10:00:00Z", {
      trigger: "automatic",
      pullRequest: {
        number: 420,
        url: "https://github.com/acme/api/pull/420",
        state: "open",
        observedAt: "2026-10-03T10:00:00Z",
      },
    });
    const newest = newestPullRequest([second, fork]);
    expect(newest).toMatchObject({ number: 420, title: null, outside: false });
    expect(newest === undefined ? null : pullRequestOrigin(newest)).toBe(
      "opened by Mend's landing",
    );
    const [forked] = pullRequestCards([fork]);
    expect(forked === undefined ? null : pullRequestOrigin(forked)).toBe(
      "opened outside Mend · from anna's fork",
    );
    expect(newestPullRequest([])).toBeUndefined();
  });

  it("reads a list row's fact and the files changed since landing", () => {
    expect(pullRequestFact({ number: 412, state: "open" })).toBe("#412 · open");
    expect(
      changedSinceLanding([{ _tag: "pushed" }, { _tag: "changed-since-landing", files: 3 }]),
    ).toBe(3);
    expect(changedSinceLanding([{ _tag: "pushed" }])).toBeNull();
  });
});

const keys = (placed: ReturnType<typeof withPullRequests>) => placed.map((row) => row.key);

describe("withPullRequests", () => {
  const rows = () =>
    reconcileConversation(
      buildAgentConversation({
        turns: [turn("t1", 0, "2026-10-03T09:00:00Z"), turn("t2", 1, "2026-10-03T09:10:00Z")],
        items: [
          item("i1", "t1", "2026-10-03T09:01:00Z"),
          item("i2", "t1", "2026-10-03T09:04:00Z"),
          item("i3", "t2", "2026-10-03T09:11:00Z"),
        ],
        requests: [],
      }),
      [],
    );

  it("closes the turn that opened it: before the first row that happened after", () => {
    const placed = withPullRequests(
      rows(),
      pullRequestCards([landing("l-1", "2026-10-03T09:05:00Z")]),
    );
    expect(keys(placed)).toEqual([
      keys(rows())[0],
      keys(rows())[1],
      keys(rows())[2],
      "pull-request:413",
      keys(rows())[3],
      keys(rows())[4],
    ]);
  });

  it("goes at the end when it was recorded after everything, and changes nothing without one", () => {
    const placed = withPullRequests(
      rows(),
      pullRequestCards([landing("l-1", "2026-10-03T09:30:00Z")]),
    );
    expect(keys(placed).at(-1)).toBe("pull-request:413");
    expect(withPullRequests(rows(), [])).toEqual(rows());
  });
});
