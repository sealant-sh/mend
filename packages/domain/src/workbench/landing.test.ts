import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ChangeId, ChangeLandingId, ProjectId, SessionId, Sha } from "../ids.ts";
import {
  agentPushedBranches,
  ChangeLanding,
  changeOwnerOf,
  forkPullRequestReason,
  type DecidedTurn,
  intentAllowsLanding,
  LandingFact,
  landingFactLine,
  LANDING_GUARD,
  landingFacts,
  landingFactsFromWire,
  latestDecidedTurn,
  nextLandingBranch,
  notLandedReasonOf,
  observedAgo,
  openForkPullRequest,
  parseRefUpdate,
  pullRequestToUpdate,
  RequestIntentReading,
  requestOfTurn,
  resolveAutoLand,
  withLandingGuard,
} from "./landing.ts";

const NOW = new Date("2026-09-24T12:00:00.000Z");
const sha = (digit: string) => Sha.make(digit.repeat(40));

const landing = (overrides: Partial<ConstructorParameters<typeof ChangeLanding>[0]> = {}) =>
  new ChangeLanding({
    id: ChangeLandingId.make("l-1"),
    changeId: ChangeId.make("c-1"),
    sessionId: SessionId.make("s-1"),
    projectId: ProjectId.make("p-1"),
    checkpointId: null,
    checkpointRef: "refs/mend/checkpoints/wt-1/3",
    checkpointSha: sha("c"),
    commitSha: null,
    remoteBranch: "mend/fix-login",
    pushedSha: sha("3"),
    trigger: "manual",
    pullRequest: null,
    outcome: "pushed",
    message: null,
    userId: "alice",
    createdAt: NOW,
    ...overrides,
  });

const lines = (facts: ReadonlyArray<LandingFact>) =>
  facts.map((fact) => landingFactLine(fact, NOW));

const nothingObserved = { originCommitsUnseen: null, filesChangedSinceLanding: null };

/** One session of a worktree, as `changeOwnerOf` reads it. */
const worktreeSession = (id: string, ownerUserId: string | null, at: string) => ({
  id,
  ownerUserId,
  createdAt: new Date(at),
});

describe("changeOwnerOf (docs/adr/0007, Who lands)", () => {
  const session = worktreeSession;

  it("is the owner of the worktree's first session, whoever joined it since", () => {
    expect(
      changeOwnerOf([
        session("s-3", "carol", "2026-09-24T12:05:00Z"),
        session("s-1", "alice", "2026-09-24T12:00:00Z"),
        session("s-2", "bob", "2026-09-24T12:01:00Z"),
      ]),
    ).toBe("alice");
  });

  it("breaks a tie by id, and is nobody for no session or an ownerless first one", () => {
    expect(
      changeOwnerOf([
        session("s-b", "bob", "2026-09-24T12:00:00Z"),
        session("s-a", "alice", "2026-09-24T12:00:00Z"),
      ]),
    ).toBe("alice");
    expect(changeOwnerOf([])).toBeNull();
    expect(
      changeOwnerOf([
        session("s-2", "bob", "2026-09-24T12:01:00Z"),
        session("s-1", null, "2026-09-24T12:00:00Z"),
      ]),
    ).toBeNull();
  });
});

describe("the landing facts (docs/adr/0007, What Mend records and shows)", () => {
  it("says nothing for a change that was never landed and never pushed", () => {
    expect(landingFacts({ landings: [], ...nothingObserved, agentRefUpdates: [] })).toEqual([]);
  });

  it("states the push, the pull request and what moved since, as the ADR writes them", () => {
    const pushed = landing({
      pushedSha: Sha.make("3f2a1c0d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f"),
      outcome: "pull-request",
      pullRequest: {
        number: 412,
        url: "https://github.com/acme/api/pull/412",
        state: "open",
        observedAt: new Date(NOW.getTime() - 2 * 60_000),
      },
    });
    expect(
      lines(
        landingFacts({
          landings: [pushed],
          originCommitsUnseen: 2,
          filesChangedSinceLanding: 3,
          agentRefUpdates: [],
        }),
      ),
    ).toEqual([
      "pushed · mend/fix-login · 3f2a1c0 · observed",
      "pull request #412 · open · observed 2 min ago",
      "origin has moved · mend/fix-login has 2 commits Mend has not seen",
      "changed since landing · 3 files",
    ]);
  });

  it("keeps the last push and the last pull request when a later landing was refused", () => {
    const earlier = landing({
      id: ChangeLandingId.make("l-1"),
      outcome: "pull-request",
      pullRequest: {
        number: 7,
        url: "https://github.com/acme/api/pull/7",
        state: "merged",
        observedAt: new Date(NOW.getTime() - 3 * 3600_000),
      },
    });
    const refused = landing({
      id: ChangeLandingId.make("l-2"),
      pushedSha: null,
      outcome: "refused",
      message: "! [rejected] mend/fix-login -> mend/fix-login (fetch first)",
    });
    expect(
      lines(
        landingFacts({
          landings: [refused, earlier],
          originCommitsUnseen: 1,
          filesChangedSinceLanding: 1,
          agentRefUpdates: [],
        }),
      ),
    ).toEqual([
      "pushed · mend/fix-login · 3333333 · observed",
      "pull request #7 · merged · observed 3 h ago",
      "origin has moved · mend/fix-login has 1 commit Mend has not seen",
      "changed since landing · 1 file",
      "push refused · mend/fix-login · ! [rejected] mend/fix-login -> mend/fix-login (fetch first)",
    ]);
  });

  it("tells a failure before the push from a pull request step that failed after it", () => {
    const before = landing({ pushedSha: null, outcome: "failed", message: "checkpoint failed" });
    expect(
      lines(landingFacts({ landings: [before], ...nothingObserved, agentRefUpdates: [] })),
    ).toEqual(["landing failed · checkpoint failed"]);

    const after = landing({ outcome: "failed", message: "gh: no GitHub account connected" });
    expect(
      lines(landingFacts({ landings: [after], ...nothingObserved, agentRefUpdates: [] })),
    ).toEqual([
      "pushed · mend/fix-login · 3333333 · observed",
      "pull request step failed · gh: no GitHub account connected",
    ]);
  });

  it("does not report origin or the worktree as moved when nothing was pushed to compare with", () => {
    const refused = landing({ pushedSha: null, outcome: "refused", message: "denied" });
    expect(
      lines(
        landingFacts({
          landings: [refused],
          originCommitsUnseen: 4,
          filesChangedSinceLanding: 2,
          agentRefUpdates: [],
        }),
      ),
    ).toEqual(["push refused · mend/fix-login · denied"]);
  });

  it("shows the agent's own pushes beside the landings, and skips lines it cannot read", () => {
    const facts = landingFacts({
      landings: [],
      ...nothingObserved,
      agentRefUpdates: [
        `${"0".repeat(40)} 91bd2e4${"a".repeat(33)} refs/heads/wip`,
        `${"b".repeat(40)} ${"0".repeat(40)} refs/heads/old`,
        "not a ref command",
      ],
    });
    expect(lines(facts)).toEqual([
      "pushed by the agent · refs/heads/wip · 91bd2e4",
      "deleted by the agent · refs/heads/old",
    ]);
  });

  it("says why a completed turn's changes did not land, and when intent was not read", () => {
    const notLanded = (reason: "question" | "option" | "off" | "not-owner") =>
      landingFactLine({ _tag: "not-landed", reason }, NOW);
    expect(notLanded("question")).toBe("changes not landed · the request read as a question");
    expect(notLanded("option")).toBe("changes not landed · the request said autopr=false");
    expect(notLanded("off")).toBe("changes not landed · automatic landing is off");
    expect(notLanded("not-owner")).toBe("changes not landed · the turn was not sent by the owner");
    expect(landingFactLine({ _tag: "intent-not-read" }, NOW)).toBe("intent not read");
  });

  it("never renders a verdict", () => {
    const every: ReadonlyArray<LandingFact> = [
      { _tag: "pushed", branch: "mend/x", sha: sha("a") },
      {
        _tag: "pull-request",
        number: 1,
        state: "closed",
        observedAt: NOW,
        outside: false,
        fork: null,
      },
      {
        _tag: "pull-request",
        number: 2,
        state: "open",
        observedAt: NOW,
        outside: true,
        fork: "anna",
      },
      { _tag: "origin-moved", branch: "mend/x", commits: 1 },
      { _tag: "changed-since-landing", files: 1 },
      { _tag: "refused", branch: "mend/x", message: "denied" },
      { _tag: "failed", message: "boom" },
      { _tag: "pull-request-failed", message: "boom" },
      { _tag: "agent-push", ref: "refs/heads/x", sha: sha("b") },
      { _tag: "not-landed", reason: "question" },
      { _tag: "intent-not-read" },
    ];
    for (const line of lines(every)) {
      expect(line).not.toMatch(/ready|safe|approved|passed|verified/i);
    }
  });
});

describe("observedAgo", () => {
  it("counts in the review page's units and never goes negative", () => {
    const ago = (ms: number) => observedAgo(new Date(NOW.getTime() - ms), NOW);
    expect(ago(40_000)).toBe("40 s ago");
    expect(ago(2 * 60_000)).toBe("2 min ago");
    expect(ago(3 * 3600_000)).toBe("3 h ago");
    expect(ago(2 * 86_400_000)).toBe("2 d ago");
    expect(ago(-5_000)).toBe("0 s ago");
  });
});

describe("landingFactsFromWire", () => {
  it("reads the facts the API encoded, with their timestamps as dates", () => {
    const facts: ReadonlyArray<LandingFact> = [
      { _tag: "pushed", branch: "mend/fix-login", sha: Sha.make("3f2a1c0".padEnd(40, "0")) },
      {
        _tag: "pull-request",
        number: 412,
        state: "open",
        observedAt: new Date(NOW.getTime() - 120_000),
        outside: false,
        fork: null,
      },
      { _tag: "not-landed", reason: "question" },
    ];
    const wire: unknown = JSON.parse(
      JSON.stringify(
        Schema.encodeUnknownSync(Schema.toCodecJson(Schema.Array(LandingFact)))(facts),
      ),
    );
    const read = landingFactsFromWire(wire);
    expect(read.map((fact) => landingFactLine(fact, NOW))).toEqual([
      "pushed · mend/fix-login · 3f2a1c0 · observed",
      "pull request #412 · open · observed 2 min ago",
      "changes not landed · the request read as a question",
    ]);
  });

  it("refuses a shape it cannot read", () => {
    expect(() => landingFactsFromWire([{ _tag: "merged" }])).toThrow();
    expect(() => landingFactsFromWire(null)).toThrow();
  });
});

describe("parseRefUpdate", () => {
  it("reads `<old> <new> <ref>` for sha-1 and sha-256 repositories", () => {
    expect(parseRefUpdate(`${"a".repeat(40)} ${"b".repeat(40)} refs/heads/main`)).toEqual({
      ref: "refs/heads/main",
      sha: "b".repeat(40),
    });
    expect(parseRefUpdate(`${"a".repeat(64)} ${"c".repeat(64)} refs/tags/v1`)).toEqual({
      ref: "refs/tags/v1",
      sha: "c".repeat(64),
    });
    expect(parseRefUpdate("abc def refs/heads/main")).toBeNull();
  });
});

describe("request intent (docs/adr/0007, Questions do not open pull requests)", () => {
  it("holds back only a request that read as a question", () => {
    expect(intentAllowsLanding({ intent: "change" })).toBe(true);
    expect(intentAllowsLanding({ intent: "question" })).toBe(false);
    // Unread, or never read: treated as a change.
    expect(intentAllowsLanding({ intent: null })).toBe(true);
  });

  it("decodes an intent with its source, or none with `unread`, and nothing in between", () => {
    const decode = Schema.decodeUnknownSync(RequestIntentReading);
    expect(decode({ intent: "question", source: "read" })).toEqual({
      intent: "question",
      source: "read",
    });
    expect(decode({ intent: "change", source: "option" })).toEqual({
      intent: "change",
      source: "option",
    });
    expect(decode({ intent: null, source: "unread" })).toEqual({ intent: null, source: "unread" });
    expect(() => decode({ intent: "change", source: "unread" })).toThrow();
    expect(() => decode({ intent: null, source: "read" })).toThrow();
  });
});

describe("resolveAutoLand (docs/adr/0007, When it is on)", () => {
  const web = { origin: "mend" as const, slack: true, session: null };
  const slack = { origin: "slack" as const, settings: false, session: null };

  it("is off for web and CLI sessions unless the project or Settings turn it on", () => {
    expect(resolveAutoLand({ ...web, project: "inherit", settings: false })).toBe(false);
    expect(resolveAutoLand({ ...web, project: "inherit", settings: true })).toBe(true);
    expect(resolveAutoLand({ ...web, project: "on", settings: false })).toBe(true);
  });

  it("lets one web or CLI session override its project, except a project set to off", () => {
    expect(resolveAutoLand({ ...web, project: "inherit", settings: false, session: true })).toBe(
      true,
    );
    expect(resolveAutoLand({ ...web, project: "on", settings: true, session: false })).toBe(false);
    expect(resolveAutoLand({ ...web, project: "off", settings: true, session: true })).toBe(false);
  });

  it("is on for Slack by default, follows the Slack app and autopr=, and yields to the project's off", () => {
    expect(resolveAutoLand({ ...slack, project: "inherit", slack: true })).toBe(true);
    expect(resolveAutoLand({ ...slack, project: "inherit", slack: false })).toBe(false);
    expect(resolveAutoLand({ ...slack, project: "inherit", slack: true, session: false })).toBe(
      false,
    );
    expect(resolveAutoLand({ ...slack, project: "inherit", slack: false, session: true })).toBe(
      true,
    );
    expect(resolveAutoLand({ ...slack, project: "off", slack: true, session: true })).toBe(false);
    // Settings speaks for sessions people run themselves, not for Slack.
    expect(resolveAutoLand({ ...slack, project: "inherit", settings: true, slack: false })).toBe(
      false,
    );
  });
});

describe("a turn's landing decision, as facts (docs/adr/0007, Questions do not open pull requests)", () => {
  const endedAt = new Date(NOW.getTime() - 60_000);
  const observe = (latestTurn: DecidedTurn | null, landings: ReadonlyArray<ChangeLanding> = []) =>
    lines(landingFacts({ landings, ...nothingObserved, agentRefUpdates: [], latestTurn }));

  it("says a question's changes were not landed, until a landing after the turn answers it", () => {
    const asked = { landing: "question", intentSource: "read", endedAt } as const;
    expect(observe(asked)).toEqual(["changes not landed · the request read as a question"]);
    const earlier = landing({ createdAt: new Date(endedAt.getTime() - 1_000) });
    expect(observe(asked, [earlier])).toContain(
      "changes not landed · the request read as a question",
    );
    const answered = landing({ createdAt: new Date(endedAt.getTime() + 1_000) });
    expect(observe(asked, [answered])).not.toContain(
      "changes not landed · the request read as a question",
    );
  });

  it("names every reason a completed turn did not land", () => {
    expect(observe({ landing: "option", intentSource: "option", endedAt })).toEqual([
      "changes not landed · the request said autopr=false",
    ]);
    expect(observe({ landing: "off", intentSource: null, endedAt })).toEqual([
      "changes not landed · automatic landing is off",
    ]);
    expect(observe({ landing: "not-owner", intentSource: null, endedAt })).toEqual([
      "changes not landed · the turn was not sent by the owner",
    ]);
  });

  it("says an automatic landing's request was not read, and nothing for a skipped turn", () => {
    expect(observe({ landing: "attempted", intentSource: "unread", endedAt }, [landing()])).toEqual(
      ["pushed · mend/fix-login · 3333333 · observed", "intent not read"],
    );
    expect(observe({ landing: "attempted", intentSource: "read", endedAt })).toEqual([]);
    expect(observe({ landing: "skipped", intentSource: null, endedAt })).toEqual([]);
    expect(observe(null)).toEqual([]);
  });

  it("reads a reason only from a not-landed decision", () => {
    expect(notLandedReasonOf("question")).toBe("question");
    expect(notLandedReasonOf("attempted")).toBeNull();
    expect(notLandedReasonOf("skipped")).toBeNull();
    expect(notLandedReasonOf(null)).toBeNull();
  });
});

describe("latestDecidedTurn", () => {
  it("is the decided turn that ended last, and null when none is decided", () => {
    const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
    const turns = [
      { id: "t1", landing: "attempted", endedAt: at(1), createdAt: at(0) },
      { id: "t2", landing: "question", endedAt: at(3), createdAt: at(2) },
      { id: "t3", landing: null, endedAt: at(5), createdAt: at(4) },
      { id: "t4", landing: "skipped", endedAt: null, createdAt: at(2.5) },
    ] as const;
    expect(latestDecidedTurn(turns)?.id).toBe("t2");
    expect(latestDecidedTurn(turns.slice(2))?.id).toBe("t4");
    expect(latestDecidedTurn([turns[2]])).toBeNull();
  });
});

describe("the prompt guard (docs/adr/0007, Questions do not open pull requests)", () => {
  it("rides after the request and says what the ADR says", () => {
    const guarded = withLandingGuard("  why does the login test flake?  ");
    expect(guarded).toBe(`  why does the login test flake?\n\n${LANDING_GUARD}`);
    expect(LANDING_GUARD).toContain("answer it and change no files");
    expect(LANDING_GUARD).toContain("Change code only when the request asks for a change.");
    expect(LANDING_GUARD).toContain("Never push and never open a pull request.");
    expect(LANDING_GUARD).toContain("Committing is fine.");
    expect(LANDING_GUARD).not.toMatch(/ready to merge|safe|verified/i);
  });

  it("leaves an empty prompt empty, and gives back what the requester wrote", () => {
    expect(withLandingGuard("")).toBe("");
    expect(requestOfTurn(withLandingGuard("fix the flaky test"))).toBe("fix the flaky test");
    expect(requestOfTurn("fix the flaky test")).toBe("fix the flaky test");
  });
});

describe("pull requests opened outside Mend (docs/adr/0007, open question 4)", () => {
  const pr367 = (state: "open" | "merged") => ({
    number: 367,
    url: "https://github.com/sealant-sh/mend/pull/367",
    state,
    observedAt: new Date(NOW.getTime() - 120_000),
  });
  const adopted = (fork: string | null, state: "open" | "merged" = "open") =>
    landing({
      id: ChangeLandingId.make("l-adopted"),
      trigger: "adopted",
      outcome: "adopted",
      pushedSha: null,
      checkpointRef: null,
      checkpointSha: null,
      remoteBranch: "chore/bump-deps-tailwind-v4",
      pullRequest: pr367(state),
      pullRequestCrossRepository: fork !== null,
      pullRequestHeadOwner: fork,
    });

  it("says a pull request was opened outside Mend, and from whose fork", () => {
    expect(
      lines(
        landingFacts({
          landings: [adopted("anna", "merged")],
          ...nothingObserved,
          agentRefUpdates: [],
        }),
      ),
    ).toEqual([
      "pull request #367 · merged · observed 2 min ago · opened outside Mend · from anna's fork",
    ]);
    // An adoption pushed nothing: no push fact, no failure.
    expect(
      lines(landingFacts({ landings: [adopted(null)], ...nothingObserved, agentRefUpdates: [] })),
    ).toEqual(["pull request #367 · open · observed 2 min ago · opened outside Mend"]);
  });

  it("keeps saying so after Mend's own landing updated it", () => {
    const updated = landing({
      id: ChangeLandingId.make("l-2"),
      outcome: "pull-request",
      remoteBranch: "chore/bump-deps-tailwind-v4",
      pullRequest: pr367("open"),
    });
    expect(
      lines(
        landingFacts({
          landings: [updated, adopted(null)],
          ...nothingObserved,
          agentRefUpdates: [],
        }),
      ),
    ).toContain("pull request #367 · open · observed 2 min ago · opened outside Mend");
  });

  it("updates an open pull request on origin, never one from a fork", () => {
    expect(pullRequestToUpdate([adopted(null)])?.number).toBe(367);
    expect(pullRequestToUpdate([adopted("anna")])).toBeNull();
    expect(pullRequestToUpdate([adopted(null, "merged")])).toBeNull();
    expect(openForkPullRequest([adopted("anna")])).toEqual({ number: 367, owner: "anna" });
    expect(openForkPullRequest([adopted(null)])).toBeNull();
    expect(forkPullRequestReason({ number: 367, owner: "anna" })).toBe(
      "pull request #367 is from anna's fork · Mend pushes to origin only",
    );
  });

  it("reads the branches the agent pushed, newest first, without deletions or tags", () => {
    const zero = "0".repeat(40);
    expect(
      agentPushedBranches([
        `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/chore/bump-deps-tailwind-v4`,
        `${zero} ${"a".repeat(40)} refs/heads/chore/bump-deps-tailwind-v4`,
        `${"c".repeat(40)} ${zero} refs/heads/old`,
        `${zero} ${"d".repeat(40)} refs/tags/v1`,
        "not a ref update",
      ]),
    ).toEqual(["chore/bump-deps-tailwind-v4"]);
  });

  it("picks the next landing's branch: asked, landed, the agent's, an adopted head, the worktree's", () => {
    const base = {
      requested: null,
      landings: [],
      agentBranches: [],
      worktreeBranch: "mend/update-deps",
      protectedBranches: ["main"],
    };
    expect(nextLandingBranch(base)).toBe("mend/update-deps");
    expect(nextLandingBranch({ ...base, requested: "mine" })).toBe("mine");
    expect(nextLandingBranch({ ...base, landings: [adopted(null)] })).toBe(
      "chore/bump-deps-tailwind-v4",
    );
    // A fork's branch is not on origin: the worktree's own is pushed.
    expect(nextLandingBranch({ ...base, landings: [adopted("anna")] })).toBe("mend/update-deps");
    expect(nextLandingBranch({ ...base, agentBranches: ["main", "wip"] })).toBe("wip");
    expect(
      nextLandingBranch({
        ...base,
        landings: [landing({ remoteBranch: "landed" })],
        agentBranches: ["wip"],
      }),
    ).toBe("landed");
  });

  it("reads a pull request fact from a server that predates adoption", () => {
    const [fact] = landingFactsFromWire([
      { _tag: "pull-request", number: 412, state: "open", observedAt: NOW.toISOString() },
    ]);
    expect(fact).toEqual({
      _tag: "pull-request",
      number: 412,
      state: "open",
      observedAt: NOW,
      outside: false,
      fork: null,
    });
  });
});
