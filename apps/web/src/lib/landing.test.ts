import {
  ChangeId,
  ChangeLandingId,
  CheckpointId,
  ProjectId,
  ProofArtifactId,
  SessionId,
  Sha,
} from "@mend/domain";
import { describe, expect, it } from "vitest";

import type { ChangeLandingDto, ChangeLandingsDto, LandingReportDto } from "#/lib/api";
import {
  descriptionPreview,
  factsWithProbe,
  landButtonLabel,
  landedSentence,
  landingBase,
  landingMarks,
  landingProblem,
  landRequestOf,
  nextRemoteBranch,
  originPlace,
  pullRequestToUpdate,
  remoteLine,
  reportProblem,
  stillEditing,
  toolbarLanding,
  unavailableWords,
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
  oneOff: false,
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
  title: null,
  observedAt: new Date("2026-09-24T11:58:00Z"),
};

const landedInto412 = landing({ outcome: "pull-request", pullRequest: openPullRequest });

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
    expect(landButtonLabel({ pullRequestAvailable: true, updates: false, fork: true })).toBe(
      "Push to origin",
    );
  });

  it("names origin by its host and path, whatever form its address takes", () => {
    expect(originPlace("git@github.com:northwind/checkout-api.git")).toBe(
      "github.com/northwind/checkout-api",
    );
    expect(originPlace("https://github.com/northwind/checkout-api.git")).toBe(
      "github.com/northwind/checkout-api",
    );
    expect(originPlace("ssh://git@git.example.com:2222/team/app")).toBe(
      "git.example.com:2222/team/app",
    );
    expect(originPlace(null)).toBe("origin");
  });

  it("says why no pull request opens, in a sentence", () => {
    expect(unavailableWords("pull request unavailable · origin is on gitlab.com, not GitHub")).toBe(
      "No pull request: origin is on gitlab.com, not GitHub.",
    );
    expect(unavailableWords(null)).toBe("Mend can't open a pull request for this project.");
  });
});

describe("the land request", () => {
  it("sends a title left as Mend wrote it, and an empty description, as null", () => {
    expect(landRequestOf({ title: "  ", body: "\n", startTitle: "Fix the login loop" })).toEqual({
      branch: null,
      pullRequest: true,
      title: null,
      body: null,
    });
    expect(
      landRequestOf({ title: "Fix the login loop ", body: "", startTitle: "Fix the login loop" })
        .title,
    ).toBeNull();
    expect(
      landRequestOf({ title: " Stop the login loop ", body: "Context\n", startTitle: "Fix it" }),
    ).toEqual({
      branch: null,
      pullRequest: true,
      title: "Stop the login loop",
      body: "Context\n",
    });
  });
});

describe("the description preview", () => {
  it("keeps the stored native attachments in the preview", () => {
    const preview = descriptionPreview({
      ownerText: "",
      tour: null,
      files: [],
      webOrigin: "https://mend.test",
      sessionId: "session",
      changeId: "change",
      media: [
        {
          artifactId: ProofArtifactId.make("video"),
          kind: "video",
          label: "Board · checkpoint #2 · observed 14:02 UTC",
          checkpointOrdinal: 2,
          ref: { url: "https://github.com/user-attachments/assets/video" },
        },
      ],
    });
    expect(preview).toContain("\n\nhttps://github.com/user-attachments/assets/video\n");
    expect(preview).not.toContain("![](");
  });

  it("is the owner's words, then Mend's section between its markers, linking to this install", () => {
    const preview = descriptionPreview({
      ownerText: "Closes #12.",
      tour: { summary: "Fixes the login loop.", approach: "Reproduced it with a test first." },
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
    expect(preview.trimEnd().endsWith("<!-- mend:landing:end -->")).toBe(true);
    expect(preview).toContain("## Summary\n\nFixes the login loop.");
    expect(preview).toContain("## Approach\n\nReproduced it with a test first.");
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

describe("the Change view's toolbar", () => {
  const toolbar = (overrides: Partial<ChangeLandingsDto>, landedOrdinal: number | null = 9) =>
    toolbarLanding({
      view: view(overrides),
      landedOrdinal,
      currentOrdinal: 10,
      hasFiles: true,
    });

  it("offers Land… before anything landed, and says nothing", () => {
    expect(toolbar({})).toEqual({ line: null, pullRequest: null, action: "land" });
    expect(
      toolbarLanding({ view: view(), landedOrdinal: null, currentOrdinal: 0, hasFiles: false })
        .action,
    ).toBeNull();
  });

  it("names the checkpoint in the pull request, with no button when nothing is new", () => {
    const landed = toolbar({ landings: [landedInto412] });
    expect(landed.line).toBe("Checkpoint 9 is in pull request #412.");
    expect(landed.pullRequest?.number).toBe(412);
    expect(landed.action).toBe("landed");
  });

  it("says a newer checkpoint isn't in the pull request yet, and offers Land again…", () => {
    const moved = toolbar({
      landings: [landedInto412],
      facts: [{ _tag: "changed-since-landing", files: 1 }],
    });
    expect(moved.line).toBe("Checkpoint 10 isn't in pull request #412 yet.");
    expect(moved.action).toBe("land-again");
  });

  it("offers Land again… after a refused push, and Land… when nothing ever pushed", () => {
    const refused = landing({ outcome: "refused", pushedSha: null, message: "protected" });
    expect(toolbar({ landings: [refused, landedInto412] }).action).toBe("land-again");
    expect(toolbar({ landings: [refused] }).action).toBe("land");
    expect(toolbar({ landings: [refused] }).line).toBeNull();
  });

  it("names the branch on origin when no pull request is possible", () => {
    expect(toolbar({ landings: [landing()] }, null).line).toBe(
      "The change is on origin as mend/fix-login.",
    );
  });

  it("shows anyone but the owner what landed, with no way to land", () => {
    expect(toolbar({ land: false, landings: [landedInto412] }).action).toBe("landed");
    expect(toolbar({ land: false }).action).toBeNull();
  });
});

const row = (
  id: string,
  status: string,
  owner: string | null,
  activity: { kind: string; subject: string | null } | null = null,
) => ({
  session: { id, status, ownerUserId: owner },
  title: `Session ${id}`,
  activity,
});

describe("another session still editing", () => {
  it("names each other running session, and says what happens to what it writes next", () => {
    const editing = stillEditing(
      [
        row("mine", "completed", "grace"),
        row("ada", "running", "ada", { kind: "command", subject: "pnpm test" }),
        row("done", "stopped", "grace"),
        row("other", "running", "grace"),
      ],
      "mine",
      "grace",
    );
    expect(editing.map((each) => each.heading)).toEqual([
      "Session ada is still editing",
      "Session other is still editing",
    ]);
    expect(editing[0]?.body).toBe(
      "It's another session in this workspace, and it's running pnpm test now. Mend pushes the files as they are now. Edits it makes after that stay in the workspace until you land again.",
    );
    expect(editing[1]?.body.startsWith("It's your other session in this workspace.")).toBe(true);
  });
});

describe("a landing that didn't go through", () => {
  it("states a refused push in the remote's own words", () => {
    const problem = landingProblem(
      landing({ outcome: "refused", pushedSha: null, message: "GH006: Protected branch" }),
      true,
    );
    expect(problem?.heading).toBe("GitHub refused the push");
    expect(problem?.words).toBe("GH006: Protected branch");
    expect(problem?.next).toBe(
      "Nothing was pushed, and no pull request was opened. Sort out what GitHub says, then try again.",
    );
    expect(landingProblem(landing({ outcome: "refused", pushedSha: null }), false)?.heading).toBe(
      "Origin refused the push",
    );
    expect(landingProblem(landedInto412, true)).toBeNull();
  });

  it("says a pull request step that failed after the push", () => {
    const report: LandingReportDto = {
      landing: landing({ outcome: "pushed" }),
      pullRequest: { _tag: "failed", message: "gh: no GitHub account connected" },
    };
    expect(reportProblem(report, true)).toEqual({
      heading: "The pull request wasn't opened",
      words: "gh: no GitHub account connected",
      next: "Mend pushed mend/fix-login. Try again to open the pull request.",
    });
    expect(landedSentence(report)).toBeNull();
  });
});

describe("what a landing just did", () => {
  it("says it in a sentence, with the captures it delivered", () => {
    expect(
      landedSentence({
        landing: landedInto412,
        pullRequest: { _tag: "opened", pullRequest: openPullRequest },
      }),
    ).toBe("Pushed mend/fix-login and opened pull request #412.");
    expect(
      landedSentence({
        landing: landedInto412,
        pullRequest: {
          _tag: "updated",
          pullRequest: openPullRequest,
          media: { delivered: 1, reused: 1, failed: [] },
        },
      }),
    ).toBe("Pushed mend/fix-login to pull request #412. 2 captures in the pull request.");
    expect(
      landedSentence({
        landing: landing(),
        pullRequest: { _tag: "unavailable", reason: "origin is on gitlab.com" },
      }),
    ).toBe("Pushed mend/fix-login to origin.");
  });
});

describe("the conversation's landing marks", () => {
  const checkpoints = [{ id: CheckpointId.make("cp-9"), ordinal: 9 }];

  it("marks the session's first landing into a pull request, then each one added to it", () => {
    const first = landing({
      id: ChangeLandingId.make("l1"),
      checkpointId: CheckpointId.make("cp-9"),
      outcome: "pull-request",
      pullRequest: openPullRequest,
      createdAt: new Date("2026-09-24T11:00:00Z"),
    });
    const refused = landing({
      id: ChangeLandingId.make("l2"),
      outcome: "refused",
      pushedSha: null,
      createdAt: new Date("2026-09-24T11:30:00Z"),
    });
    const again = landing({
      id: ChangeLandingId.make("l3"),
      outcome: "pull-request",
      pullRequest: openPullRequest,
      createdAt: new Date("2026-09-24T11:45:00Z"),
    });
    const elsewhere = landing({
      id: ChangeLandingId.make("l4"),
      sessionId: SessionId.make("session-2"),
      createdAt: new Date("2026-09-24T11:50:00Z"),
    });
    const marks = landingMarks([elsewhere, again, refused, first], checkpoints, "session-1");
    expect(marks.map((mark) => mark.label)).toEqual([
      "Checkpoint 9 landed as pull request #412",
      "Added to pull request #412",
    ]);
    expect(marks[0]?.sha).toBe("3f2a1c0");
    expect(marks[0]?.pullRequest?.url).toBe(openPullRequest.url);
  });
});
