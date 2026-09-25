import { ChangeId, ChangeLandingId, ProjectId, SessionId, Sha } from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ChangeLandingDto, ChangeLandingsDto, LandingReportDto } from "#/lib/api";
import {
  autoLandFact,
  autoLandItems,
  descriptionPreview,
  factsWithProbe,
  headlineFact,
  landButtonLabel,
  landingBase,
  landingReportLine,
  landRequestOf,
  nextRemoteBranch,
  pullRequestToUpdate,
  remoteLine,
} from "#/lib/landing";

const now = new Date("2026-09-24T12:00:00Z");
const pushedSha = Sha.make("3f2a1c0d9e8b7a6f5e4d3c2b1a0f9e8d7c6b5a49");

const landing = (overrides: Partial<ChangeLandingDto> = {}): ChangeLandingDto => ({
  id: ChangeLandingId.make("landing-1"),
  changeId: ChangeId.make("change-1"),
  sessionId: SessionId.make("session-1"),
  projectId: ProjectId.make("project-1"),
  checkpointId: null,
  checkpointRef: null,
  checkpointSha: null,
  commitSha: null,
  remoteBranch: "mend/fix-login",
  pushedSha,
  trigger: "manual",
  pullRequest: null,
  pullRequestCrossRepository: false,
  pullRequestHeadOwner: null,
  outcome: "pushed",
  message: null,
  userId: "alice",
  createdAt: new Date("2026-09-24T11:50:00Z"),
  ...overrides,
});

const view = (overrides: Partial<ChangeLandingsDto> = {}): ChangeLandingsDto => ({
  changeId: ChangeId.make("change-1"),
  sessionId: SessionId.make("session-1"),
  land: true,
  landings: [],
  facts: [],
  remote: null,
  remoteFailure: null,
  pullRequest: { available: true, reason: null },
  nextBranch: null,
  ...overrides,
});

const openPullRequest = {
  number: 412,
  url: "https://github.com/acme/app/pull/412",
  state: "open" as const,
  observedAt: new Date("2026-09-24T11:58:00Z"),
};

describe("where the next landing goes", () => {
  it("pushes to the branch the change landed on before, else the worktree's own", () => {
    expect(nextRemoteBranch(view(), "mend/fix-login")).toBe("mend/fix-login");
    expect(
      nextRemoteBranch(
        view({ landings: [landing({ remoteBranch: "fix/login" })] }),
        "mend/fix-login",
      ),
    ).toBe("fix/login");
    // The server's own choice wins: the agent's pushed branch, an adopted pull request's head.
    expect(nextRemoteBranch(view({ nextBranch: "chore/bump-deps" }), "mend/fix-login")).toBe(
      "chore/bump-deps",
    );
  });

  it("updates the recorded pull request only while it is open", () => {
    expect(pullRequestToUpdate([])).toBeNull();
    expect(pullRequestToUpdate([landing({ pullRequest: openPullRequest })])?.number).toBe(412);
    expect(
      pullRequestToUpdate([landing({ pullRequest: { ...openPullRequest, state: "merged" } })]),
    ).toBeNull();
  });

  it("names the base as a branch, falling back to the project's default", () => {
    expect(landingBase("origin/release/2.0", "main")).toBe("release/2.0");
    expect(landingBase(null, "main")).toBe("main");
  });

  it("labels the one button by what it will do", () => {
    expect(landButtonLabel({ pullRequestAvailable: true, updates: false })).toBe(
      "Push and open pull request",
    );
    expect(landButtonLabel({ pullRequestAvailable: true, updates: true })).toBe(
      "Push and update pull request",
    );
    expect(landButtonLabel({ pullRequestAvailable: false, updates: false })).toBe("Push to origin");
  });
});

describe("the land request", () => {
  it("sends empty fields as null, so Mend keeps what GitHub has", () => {
    expect(landRequestOf({ title: "  ", body: "\n" })).toEqual({
      branch: null,
      pullRequest: true,
      title: null,
      body: null,
    });
    expect(landRequestOf({ title: " Fix the login loop ", body: "Context\n" })).toEqual({
      branch: null,
      pullRequest: true,
      title: "Fix the login loop",
      body: "Context\n",
    });
  });
});

describe("the description preview", () => {
  it("is Mend's section with links to this install, the owner's words above it", () => {
    const preview = descriptionPreview({
      ownerText: "Closes #12.",
      tour: { summary: "Fixes the login loop.", approach: null },
      files: [
        {
          path: "src/login.ts",
          oldPath: null,
          status: "modified",
          additions: 12,
          deletions: 3,
          binary: false,
        },
      ],
      webOrigin: "https://mend.test/",
      sessionId: "session-1",
      changeId: "change-1",
    });
    expect(preview.startsWith("Closes #12.\n\n<!-- mend:landing:start -->")).toBe(true);
    expect(preview).toContain("Fixes the login loop.");
    expect(preview).toContain("- `src/login.ts` · +12 −3");
    expect(preview).toContain("[session](https://mend.test/sessions/session-1)");
    expect(preview).toContain("[review](https://mend.test/changes/change-1)");
    expect(preview).toContain("- Landed checkpoint: taken when this lands");
  });
});

describe("the facts", () => {
  it("adds origin-moved only from the owner's last fetch", () => {
    const facts = [{ _tag: "pushed" as const, branch: "mend/fix-login", sha: pushedSha }];
    expect(factsWithProbe(facts, null)).toEqual(facts);
    const probed = view({
      facts: [...facts, { _tag: "origin-moved", branch: "mend/fix-login", commits: 2 }],
    });
    expect(factsWithProbe(facts, probed).map((fact) => fact._tag)).toEqual([
      "pushed",
      "origin-moved",
    ]);
  });

  it("puts a held-back change first on the session page, then failures, then the pull request", () => {
    expect(headlineFact([])).toBeNull();
    expect(
      headlineFact([
        { _tag: "pushed", branch: "mend/fix-login", sha: pushedSha },
        {
          _tag: "pull-request",
          number: 412,
          state: "open",
          observedAt: now,
          outside: false,
          fork: null,
        },
      ])?._tag,
    ).toBe("pull-request");
    expect(
      headlineFact([
        {
          _tag: "pull-request",
          number: 412,
          state: "open",
          observedAt: now,
          outside: false,
          fork: null,
        },
        { _tag: "not-landed", reason: "question" },
      ]),
    ).toEqual({ _tag: "not-landed", reason: "question" });
  });

  it("states what the fetch saw of origin, or why it could not run", () => {
    expect(remoteLine(view(), now)).toBeNull();
    expect(
      remoteLine(
        view({
          remote: {
            remoteBranch: "mend/fix-login",
            remoteSha: pushedSha,
            unseen: 0,
            ahead: 0,
            holds: true,
            observedAt: new Date("2026-09-24T11:59:00Z"),
          },
        }),
        now,
      ),
    ).toBe("origin mend/fix-login at 3f2a1c0 · holds the landed commit · checked 1 min ago");
    expect(remoteLine(view({ remoteFailure: "Permission denied (publickey)" }), now)).toBe(
      "origin could not be checked · Permission denied (publickey)",
    );
  });
});

describe("what a landing just did", () => {
  const report = (overrides: Partial<LandingReportDto> = {}): LandingReportDto => ({
    landing: landing({ outcome: "pull-request", pullRequest: openPullRequest }),
    pullRequest: { _tag: "opened", pullRequest: openPullRequest },
    ...overrides,
  });

  it("names the branch, the sha and the pull request", () => {
    expect(landingReportLine(report())).toBe(
      "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened",
    );
  });

  it("says a refusal and a failure in the remote's words", () => {
    expect(
      landingReportLine(
        report({
          landing: landing({
            outcome: "refused",
            pushedSha: null,
            message: "origin has moved · mend/fix-login has 1 commit Mend has not seen",
          }),
          pullRequest: { _tag: "not-reached" },
        }),
      ),
    ).toBe(
      "push refused · mend/fix-login · origin has moved · mend/fix-login has 1 commit Mend has not seen",
    );
    expect(
      landingReportLine(
        report({
          landing: landing({ outcome: "pushed" }),
          pullRequest: { _tag: "failed", message: "gh: no GitHub account connected" },
        }),
      ),
    ).toBe(
      "pushed · mend/fix-login · 3f2a1c0 · pull request step failed · gh: no GitHub account connected",
    );
  });
});

describe("Land when a turn completes", () => {
  it("offers following the project, on and off, and says what following means", () => {
    const { items, summary } = autoLandItems({
      override: null,
      project: "inherit",
      settings: true,
    });
    expect(items.map((item) => [item.key, item.detail, item.selected])).toEqual([
      ["follow", "on", true],
      ["on", null, false],
      ["off", null, false],
    ]);
    expect(summary).toBeNull();
    expect(autoLandItems({ override: false, project: "on", settings: false }).summary).toBe(
      "no land",
    );
  });

  it("offers nothing to override when the project turned it off", () => {
    const { items } = autoLandItems({ override: null, project: "off", settings: true });
    expect(items).toEqual([
      {
        key: "follow",
        label: "Off for this project",
        detail: null,
        selected: true,
        override: null,
      },
    ]);
  });

  it("shows the project's setting with what inherit resolves to", () => {
    expect(autoLandFact("inherit", false)).toBe("inherit · off");
    expect(autoLandFact("inherit", undefined)).toBe("inherit · …");
    expect(autoLandFact("on", false)).toBe("on");
  });
});
