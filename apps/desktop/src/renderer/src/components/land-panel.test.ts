import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LandPanelView, type LandPanelViewProps } from "#/components/land-panel";
import { landingFixture, landingsFixture } from "#/lib/fixtures";

const NOW = new Date("2026-08-20T00:02:00.000Z");
const SHA = `3f2a1c0${"c".repeat(33)}`;

const noop = () => undefined;

const render = (patch: Partial<LandPanelViewProps> = {}): string =>
  renderToStaticMarkup(
    createElement(LandPanelView, {
      view: landingsFixture(),
      probed: null,
      worktreeBranch: "mend/fix-login",
      base: "main",
      defaultTitle: "Fix the flaky login test",
      draft: { title: "", body: "" },
      pending: null,
      report: null,
      check: null,
      error: null,
      now: NOW,
      onDraft: noop,
      onLand: noop,
      onProbe: noop,
      onRefresh: noop,
      onCheck: noop,
      onOpenPullRequest: noop,
      ...patch,
    }),
  );

const LANDED = landingsFixture({
  landings: [landingFixture()],
  facts: [
    { _tag: "pushed", branch: "mend/fix-login", sha: SHA },
    {
      _tag: "pull-request",
      number: 412,
      state: "open",
      observedAt: "2026-08-20T00:00:00.000Z",
      outside: false,
      fork: null,
    },
  ],
});

describe("the Land panel", () => {
  it("offers the owner one button that opens the pull request, into the session's base", () => {
    const markup = render();
    expect(markup).toContain("push mend/fix-login to origin · pull request into main");
    expect(markup).toContain("not landed · nothing pushed from Mend yet");
    expect(markup).toContain("Push and open pull request");
    expect(markup).toContain("Fix the flaky login test");
    expect(markup).not.toContain("Check origin");
  });

  it("states what was pushed and what GitHub last said, and updates the same pull request", () => {
    const markup = render({ view: LANDED });
    expect(markup).toContain("pushed · mend/fix-login · 3f2a1c0 · observed");
    expect(markup).toContain("pull request #412 · open · observed 2 min ago");
    expect(markup).toContain("Push and update pull request");
    expect(markup).toContain("Refresh pull request");
    expect(markup).toContain("Open #412 on GitHub");
    expect(markup).toContain("manual · 2 min ago");
  });

  it("never gives a verdict, and never offers to merge", () => {
    const markup = render({ view: LANDED });
    expect(markup).not.toMatch(/ready to merge|safe to|approve|merge now/i);
    expect(markup).toContain("merging stays on GitHub");
  });

  it("shows anyone else the facts and not the form", () => {
    const markup = render({ view: { ...LANDED, land: false } });
    expect(markup).toContain("pull request #412 · open · observed 2 min ago");
    expect(markup).toContain("only the change&#x27;s owner lands it");
    expect(markup).not.toContain("Push and");
    expect(markup).not.toContain("Refresh pull request");
    expect(markup).toContain("Check origin");
  });

  it("says a question was not landed, and keeps the button for the owner", () => {
    const markup = render({
      view: landingsFixture({ facts: [{ _tag: "not-landed", reason: "question" }] }),
    });
    expect(markup).toContain("changes not landed · the request read as a question");
    expect(markup).toContain("A completed turn left changes that Mend did not land.");
    expect(markup).toContain("Push and open pull request");
  });

  it("pushes only, with the reason, where origin is not on GitHub", () => {
    const markup = render({
      view: landingsFixture({
        pullRequest: {
          available: false,
          reason: "pull request unavailable · origin is on gitlab.com, not GitHub",
        },
      }),
    });
    expect(markup).toContain("pull request unavailable · origin is on gitlab.com, not GitHub");
    expect(markup).toContain("Push to origin");
    expect(markup).not.toContain("Pull request title");
  });

  it("reports a refused push in the remote's words", () => {
    const refused = landingFixture({
      outcome: "refused",
      pushedSha: null,
      pullRequest: null,
      message: "non-fast-forward",
    });
    const markup = render({
      view: landingsFixture({
        landings: [refused],
        facts: [{ _tag: "refused", branch: "mend/fix-login", message: "non-fast-forward" }],
      }),
    });
    expect(markup).toContain("push refused · mend/fix-login · non-fast-forward");
    expect(markup).toContain("Push and open pull request");
  });

  it("lets the owner check GitHub, and says what a fork's pull request means", () => {
    expect(render()).toContain("Check GitHub");
    const markup = render({
      view: landingsFixture({
        landings: [
          landingFixture({
            trigger: "adopted",
            outcome: "adopted",
            pushedSha: null,
            commitSha: null,
            remoteBranch: "fix-login",
            pullRequest: {
              number: 367,
              url: "https://github.com/acme/app/pull/367",
              state: "open",
              observedAt: "2026-08-20T00:00:00.000Z",
            },
            pullRequestCrossRepository: true,
            pullRequestHeadOwner: "anna",
          }),
        ],
      }),
      check: { outcome: "adopted", reason: null, landing: null },
    });
    expect(markup).toContain(
      "pull request #367 is from anna&#x27;s fork · Mend pushes to origin only",
    );
    expect(markup).toContain("Push to origin");
    expect(markup).toContain("pull request #367 · open · opened outside Mend · fix-login");
    expect(markup).toContain("pull request recorded · opened outside Mend");
  });
});
