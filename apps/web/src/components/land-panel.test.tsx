import { ChangeId, ChangeLandingId, ProjectId, SessionId, Sha } from "@mend/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChangeLandingDto, ChangeLandingsDto } from "#/lib/api";

import { LandPanelView, SessionLandingLineView, type LandPanelViewProps } from "./land-panel.tsx";

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

const render = (overrides: Partial<LandPanelViewProps> = {}) =>
  renderToStaticMarkup(
    <LandPanelView
      view={view()}
      probed={null}
      worktreeBranch="mend/fix-login"
      base="main"
      defaultTitle="Fix the login loop"
      preview="<!-- mend:landing:start -->"
      draft={{ title: "", body: "" }}
      previewOpen={false}
      pending={null}
      report={null}
      check={null}
      error={null}
      now={now}
      onDraft={() => undefined}
      onTogglePreview={() => undefined}
      onLand={() => undefined}
      onProbe={() => undefined}
      onRefresh={() => undefined}
      onCheck={() => undefined}
      {...overrides}
    />,
  );

const openPullRequest = {
  number: 412,
  url: "https://github.com/acme/app/pull/412",
  state: "open" as const,
  observedAt: new Date("2026-09-24T11:58:00Z"),
};

describe("the Land panel", () => {
  it("shows the owner the branch, the base, the title and the one button", () => {
    const markup = render();
    expect(markup).toContain('id="land"');
    expect(markup).toContain("push mend/fix-login to origin · pull request into main");
    expect(markup).toContain("not landed · nothing pushed from Mend yet");
    expect(markup).toContain('placeholder="Fix the login loop"');
    expect(markup).toContain("Push and open pull request</button>");
  });

  it("offers to update the pull request an earlier landing opened, and states its facts", () => {
    const markup = render({
      view: view({
        landings: [landing({ outcome: "pull-request", pullRequest: openPullRequest })],
        facts: [
          { _tag: "pushed", branch: "mend/fix-login", sha: pushedSha },
          {
            _tag: "pull-request",
            number: 412,
            state: "open",
            observedAt: openPullRequest.observedAt,
            outside: false,
            fork: null,
          },
          { _tag: "changed-since-landing", files: 3 },
          {
            _tag: "agent-push",
            ref: "refs/heads/wip",
            sha: Sha.make("91bd2e4f00000000000000000000000000000000"),
          },
        ],
      }),
    });
    expect(markup).toContain("Push and update pull request</button>");
    expect(markup).toContain("pushed · mend/fix-login · 3f2a1c0 · observed");
    expect(markup).toContain("pull request #412 · open · observed 2 min ago");
    expect(markup).toContain("changed since landing · 3 files");
    expect(markup).toContain("pushed by the agent · refs/heads/wip · 91bd2e4");
    expect(markup).toContain('placeholder="kept as it is on GitHub"');
    expect(markup).toContain("Refresh pull request");
    expect(markup).toContain('href="https://github.com/acme/app/pull/412"');
  });

  it("lets the owner check GitHub before anything landed", () => {
    expect(render()).toContain("Check GitHub</button>");
    expect(render({ view: view({ land: false }) })).not.toContain("Check GitHub");
    expect(
      render({
        check: { outcome: "none", reason: null, landing: null },
      }),
    ).toContain(
      "no pull request on GitHub for the change&#x27;s branches or the agent&#x27;s commit",
    );
  });

  it("updates a pull request the agent opened on origin", () => {
    const markup = render({
      view: view({
        landings: [
          landing({
            trigger: "adopted",
            outcome: "adopted",
            pushedSha: null,
            remoteBranch: "chore/bump-deps",
            pullRequest: { ...openPullRequest, number: 368 },
          }),
        ],
        nextBranch: "chore/bump-deps",
      }),
    });
    expect(markup).toContain("push mend/fix-login to origin as chore/bump-deps");
    expect(markup).toContain("Push and update pull request</button>");
  });

  it("says a fork's pull request is not Mend's to update, and pushes to origin only", () => {
    const markup = render({
      view: view({
        landings: [
          landing({
            trigger: "adopted",
            outcome: "adopted",
            pushedSha: null,
            remoteBranch: "fix-login",
            pullRequest: { ...openPullRequest, number: 367 },
            pullRequestCrossRepository: true,
            pullRequestHeadOwner: "anna",
          }),
        ],
      }),
    });
    expect(markup).toContain(
      "pull request #367 is from anna&#x27;s fork · Mend pushes to origin only",
    );
    expect(markup).toContain("Push to origin</button>");
  });

  it("shows the facts, and no button, to someone who does not own the session", () => {
    const markup = render({
      view: view({
        land: false,
        landings: [landing()],
        facts: [{ _tag: "pushed", branch: "mend/fix-login", sha: pushedSha }],
      }),
    });
    expect(markup).toContain("pushed · mend/fix-login · 3f2a1c0 · observed");
    expect(markup).not.toContain("Push and");
    expect(markup).not.toContain("Refresh pull request");
    expect(markup).toContain("only the change&#x27;s owner lands it");
  });

  it("says a question was not landed, and keeps the button for the owner", () => {
    const markup = render({
      view: view({ facts: [{ _tag: "not-landed", reason: "question" }] }),
    });
    expect(markup).toContain("changes not landed · the request read as a question");
    expect(markup).toContain("Push and open pull request</button>");
  });

  it("states why no pull request can open, and pushes only", () => {
    const markup = render({
      view: view({
        pullRequest: {
          available: false,
          reason: "pull request unavailable · origin is on gitlab.com, not GitHub",
        },
      }),
    });
    expect(markup).toContain("pull request unavailable · origin is on gitlab.com, not GitHub");
    expect(markup).toContain("Push to origin</button>");
    expect(markup).not.toContain("Pull request title");
  });

  it("uses no verdict words", () => {
    const markup = render({
      view: view({
        landings: [landing({ outcome: "pull-request", pullRequest: openPullRequest })],
        facts: [{ _tag: "pushed", branch: "mend/fix-login", sha: pushedSha }],
      }),
    });
    for (const verdict of [/ready/i, /\bsafe\b/i, /approve/i, /passed/i]) {
      expect(markup).not.toMatch(verdict);
    }
  });
});

describe("the session page's landing line", () => {
  const link = <a href="/changes/change-1#land">Land →</a>;

  it("shows the latest fact beside the link to the Land panel", () => {
    const markup = renderToStaticMarkup(
      <SessionLandingLineView
        facts={[
          { _tag: "pushed", branch: "mend/fix-login", sha: pushedSha },
          { _tag: "not-landed", reason: "question" },
        ]}
        land
        now={now}
        link={link}
      />,
    );
    expect(markup).toContain("changes not landed · the request read as a question");
    expect(markup).not.toContain("pushed · mend/fix-login");
    expect(markup).toContain('href="/changes/change-1#land"');
  });

  it("says nothing to a viewer when nothing was landed", () => {
    expect(
      renderToStaticMarkup(
        <SessionLandingLineView facts={[]} land={false} now={now} link={link} />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(<SessionLandingLineView facts={[]} land now={now} link={link} />),
    ).toContain("not landed");
  });
});
