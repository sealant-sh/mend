import { Sha } from "@mend/domain";
import { landingFactLine, type LandingFact } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import type { LandingFactDto } from "#/lib/api";
import { landingFixture, landingsFixture } from "#/lib/fixtures";
import {
  autoLandItems,
  autoLandToSend,
  factLine,
  factsWithProbe,
  factTone,
  headlineFact,
  heldBack,
  landButtonLabel,
  landingRecordLine,
  landingRecordMeta,
  landingReportLine,
  landRequestOf,
  nextRemoteBranch,
  projectAutoLand,
  pullRequestToUpdate,
  remoteLine,
  settingsAutoLand,
  type PullRequestDto,
} from "#/lib/landing";

const NOW = new Date("2026-08-20T00:02:00.000Z");
const OBSERVED = "2026-08-20T00:00:00.000Z";
const SHA = `3f2a1c0${"c".repeat(33)}`;
const PULL_REQUEST: PullRequestDto = {
  number: 412,
  url: "https://github.com/acme/app/pull/412",
  state: "open",
  observedAt: OBSERVED,
};

/** Every fact the contract declares, as the wire carries it and as the domain holds it. */
const FACTS: ReadonlyArray<readonly [LandingFactDto, LandingFact]> = [
  [
    { _tag: "pushed", branch: "mend/fix-login", sha: SHA },
    { _tag: "pushed", branch: "mend/fix-login", sha: Sha.make(SHA) },
  ],
  [
    { _tag: "pull-request", number: 412, state: "open", observedAt: OBSERVED },
    { _tag: "pull-request", number: 412, state: "open", observedAt: new Date(OBSERVED) },
  ],
  [
    { _tag: "origin-moved", branch: "mend/fix-login", commits: 2 },
    { _tag: "origin-moved", branch: "mend/fix-login", commits: 2 },
  ],
  [
    { _tag: "changed-since-landing", files: 1 },
    { _tag: "changed-since-landing", files: 1 },
  ],
  [
    { _tag: "refused", branch: "mend/fix-login", message: "protected branch" },
    { _tag: "refused", branch: "mend/fix-login", message: "protected branch" },
  ],
  [
    { _tag: "failed", message: "no change" },
    { _tag: "failed", message: "no change" },
  ],
  [
    { _tag: "pull-request-failed", message: "gh: not logged in" },
    { _tag: "pull-request-failed", message: "gh: not logged in" },
  ],
  [
    { _tag: "agent-push", ref: "refs/heads/wip", sha: SHA },
    { _tag: "agent-push", ref: "refs/heads/wip", sha: Sha.make(SHA) },
  ],
  [
    { _tag: "agent-push", ref: "refs/heads/wip", sha: null },
    { _tag: "agent-push", ref: "refs/heads/wip", sha: null },
  ],
  [
    { _tag: "not-landed", reason: "question" },
    { _tag: "not-landed", reason: "question" },
  ],
  [
    { _tag: "not-landed", reason: "not-owner" },
    { _tag: "not-landed", reason: "not-owner" },
  ],
  [{ _tag: "intent-not-read" }, { _tag: "intent-not-read" }],
];

describe("landing facts", () => {
  it("say each fact in the domain's words", () => {
    for (const [wire, domain] of FACTS) {
      expect(factLine(wire, NOW)).toBe(landingFactLine(domain, NOW));
    }
  });

  it("read as observations, never a verdict", () => {
    const lines = FACTS.map(([wire]) => factLine(wire, NOW)).join("\n");
    expect(lines).toContain("pull request #412 · open · observed 2 min ago");
    expect(lines).toContain("pushed · mend/fix-login · 3f2a1c0 · observed");
    expect(lines).not.toMatch(/ready|safe|merge now|approved/i);
  });

  it("tone a push and a pull request as observed, a refusal as a failure", () => {
    expect(factTone({ _tag: "pushed", branch: "b", sha: SHA })).toBe("observed");
    expect(factTone({ _tag: "refused", branch: "b", message: "m" })).toBe("failure");
    expect(factTone({ _tag: "not-landed", reason: "question" })).toBe("neutral");
  });

  it("headline what held a change back before the pull request", () => {
    const facts: ReadonlyArray<LandingFactDto> = [
      { _tag: "pushed", branch: "mend/fix-login", sha: SHA },
      { _tag: "pull-request", number: 412, state: "open", observedAt: OBSERVED },
      { _tag: "not-landed", reason: "question" },
    ];
    expect(headlineFact(facts)?._tag).toBe("not-landed");
    expect(headlineFact(facts.slice(0, 2))?._tag).toBe("pull-request");
    expect(headlineFact([])).toBeNull();
    expect(heldBack(facts)).toBe(true);
    expect(heldBack(facts.slice(0, 2))).toBe(false);
  });

  it("take origin's movement only from a fetch the viewer asked for", () => {
    const stale: LandingFactDto = { _tag: "origin-moved", branch: "b", commits: 5 };
    const fresh: LandingFactDto = { _tag: "origin-moved", branch: "b", commits: 1 };
    expect(factsWithProbe([stale], null)).toEqual([]);
    expect(factsWithProbe([stale], landingsFixture({ facts: [fresh] }))).toEqual([fresh]);
  });
});

describe("the next landing", () => {
  it("pushes to the branch the change landed on before, else its own", () => {
    expect(nextRemoteBranch([], "mend/worktree-1")).toBe("mend/worktree-1");
    expect(nextRemoteBranch([landingFixture({ remoteBranch: "fix/login" })], "mend/w")).toBe(
      "fix/login",
    );
  });

  it("updates the pull request while GitHub last said it was open", () => {
    expect(pullRequestToUpdate([landingFixture()])?.number).toBe(412);
    const merged = landingFixture({
      pullRequest: { number: 412, url: "u", state: "merged", observedAt: OBSERVED },
    });
    expect(pullRequestToUpdate([merged])).toBeNull();
    expect(pullRequestToUpdate([])).toBeNull();
  });

  it("names the button by what it does", () => {
    expect(landButtonLabel({ pullRequestAvailable: true, updates: false })).toBe(
      "Push and open pull request",
    );
    expect(landButtonLabel({ pullRequestAvailable: true, updates: true })).toBe(
      "Push and update pull request",
    );
    expect(landButtonLabel({ pullRequestAvailable: false, updates: false })).toBe("Push to origin");
  });

  it("sends null for fields left empty, so Mend keeps what GitHub has", () => {
    expect(landRequestOf({ title: "  ", body: "" })).toEqual({
      branch: null,
      pullRequest: true,
      title: null,
      body: null,
    });
    expect(landRequestOf({ title: " Fix login ", body: "Context\n" })).toEqual({
      branch: null,
      pullRequest: true,
      title: "Fix login",
      body: "Context\n",
    });
  });
});

describe("recorded landings", () => {
  it("say what was pushed and what GitHub last said", () => {
    expect(landingRecordLine(landingFixture())).toBe(
      "pushed · mend/fix-login · 3f2a1c0 · pull request #412 · open · observed",
    );
    expect(landingRecordLine(landingFixture({ pullRequest: null, outcome: "pushed" }))).toBe(
      "pushed · mend/fix-login · 3f2a1c0 · observed",
    );
    expect(
      landingRecordLine(
        landingFixture({
          outcome: "refused",
          pushedSha: null,
          pullRequest: null,
          message: "non-fast-forward",
        }),
      ),
    ).toBe("push refused · mend/fix-login · non-fast-forward");
    expect(
      landingRecordLine(
        landingFixture({ outcome: "failed", pullRequest: null, message: "gh: no account" }),
      ),
    ).toBe("pushed · mend/fix-login · 3f2a1c0 · pull request step failed · gh: no account");
    expect(landingRecordMeta(landingFixture({ trigger: "automatic" }), NOW)).toBe(
      "automatic · 2 min ago",
    );
  });

  it("report what one landing just did", () => {
    const landing = landingFixture();
    expect(
      landingReportLine({
        landing,
        pullRequest: { _tag: "opened", pullRequest: PULL_REQUEST },
      }),
    ).toBe("pushed · mend/fix-login · 3f2a1c0 · pull request #412 · opened");
    expect(
      landingReportLine({
        landing: landingFixture({ pullRequest: null, outcome: "pushed" }),
        pullRequest: { _tag: "unavailable", reason: "origin is on gitlab.com, not GitHub" },
      }),
    ).toBe("pushed · mend/fix-login · 3f2a1c0 · origin is on gitlab.com, not GitHub");
  });

  it("say when origin was checked, or why it could not be", () => {
    expect(remoteLine(landingsFixture(), NOW)).toBeNull();
    expect(remoteLine(landingsFixture({ remoteFailure: "permission denied" }), NOW)).toBe(
      "origin could not be checked · permission denied",
    );
    expect(
      remoteLine(
        landingsFixture({
          remote: {
            remoteBranch: "mend/fix-login",
            remoteSha: SHA,
            unseen: 0,
            ahead: 0,
            holds: true,
            observedAt: OBSERVED,
          },
        }),
        NOW,
      ),
    ).toBe("origin mend/fix-login at 3f2a1c0 · holds the landed commit · checked 2 min ago");
  });
});

describe("the composer's automatic landing", () => {
  it("follows the project, and says what following means", () => {
    const view = autoLandItems({ override: null, project: "inherit", settings: false });
    expect(view.items.map((item) => [item.label, item.detail, item.selected])).toEqual([
      ["As the project", "off", true],
      ["Land", null, false],
      ["Do not land", null, false],
    ]);
    expect(view.summary).toBeNull();
    expect(autoLandItems({ override: null, project: "on", settings: false }).items[0]?.detail).toBe(
      "on",
    );
    expect(
      autoLandItems({ override: null, project: "inherit", settings: null }).items[0]?.detail,
    ).toBe("…");
  });

  it("summarizes an override in the pill", () => {
    expect(autoLandItems({ override: true, project: "inherit", settings: false }).summary).toBe(
      "land",
    );
    expect(autoLandItems({ override: false, project: "on", settings: true }).summary).toBe(
      "no land",
    );
  });

  it("offers nothing to override where the project is off", () => {
    const view = autoLandItems({ override: true, project: "off", settings: true });
    expect(view.items.map((item) => item.label)).toEqual(["Off for this project"]);
    expect(view.summary).toBeNull();
  });

  it("sends an override only for a conversation in a project that allows it", () => {
    expect(autoLandToSend({ override: true, project: "inherit", conversation: true })).toBe(true);
    expect(autoLandToSend({ override: true, project: "inherit", conversation: false })).toBeNull();
    expect(autoLandToSend({ override: false, project: "off", conversation: true })).toBeNull();
    expect(autoLandToSend({ override: null, project: "on", conversation: true })).toBeNull();
  });

  it("reads a server from before landing as having no stance to offer", () => {
    expect(projectAutoLand({ autoLand: undefined })).toBeNull();
    expect(projectAutoLand({ autoLand: "on" })).toBe("on");
    expect(settingsAutoLand(undefined)).toBeNull();
    expect(settingsAutoLand({ autoLand: undefined })).toBeNull();
    expect(settingsAutoLand({ autoLand: true })).toBe(true);
  });
});
