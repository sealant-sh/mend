import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HiddenEndedSessionsNotice } from "./hidden-ended-sessions-notice";
import { ProjectWorktreeContent } from "./worktree-tree";

const renderProjectContent = (hiddenEndedSessions: number, worktreeCount: number): string =>
  renderToStaticMarkup(
    <ProjectWorktreeContent
      hiddenEndedSessions={hiddenEndedSessions}
      worktreeCount={worktreeCount}
      onCreate={() => undefined}
    >
      <p>No visible sessions</p>
    </ProjectWorktreeContent>,
  );

describe("HiddenEndedSessionsNotice", () => {
  it("renders nothing when every session is visible", () => {
    expect(renderToStaticMarkup(<HiddenEndedSessionsNotice count={0} />)).toBe("");
  });

  it("states the captured fact for one ended session", () => {
    expect(renderToStaticMarkup(<HiddenEndedSessionsNotice count={1} />)).toContain(
      "1 ended session hidden because Mend did not capture a transcript.",
    );
  });

  it("renders the multiple-session count", () => {
    expect(renderToStaticMarkup(<HiddenEndedSessionsNotice count={2} />)).toContain(
      "2 ended sessions hidden because Mend did not capture a transcript.",
    );
  });
});

describe("ProjectWorktreeContent", () => {
  it("renders the ordinary empty-project path without a transcript warning", () => {
    const markup = renderProjectContent(0, 0);

    expect(markup).toContain("No worktrees yet");
    expect(markup).not.toContain("transcript");
    expect(markup).not.toContain("No visible sessions");
  });

  it("keeps the capture warning visible when all sessions in a worktree are hidden", () => {
    const markup = renderProjectContent(2, 1);

    expect(markup).toContain("2 ended sessions hidden because Mend did not capture a transcript.");
    expect(markup).toContain("No visible sessions");
    expect(markup).not.toContain("No worktrees yet");
  });
});
