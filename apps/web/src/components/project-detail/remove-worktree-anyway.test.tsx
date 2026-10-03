import { ProjectId, Sha, WorktreeId } from "@mend/domain";
import { worktreeRemovalRefusalOf } from "@mend/domain/workbench";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorktreeDto } from "#/lib/api";

import { type RefusedRemoval, RemoveWorktreeAnywayBody } from "./remove-worktree-anyway.tsx";

const worktree: WorktreeDto = {
  id: WorktreeId.make("worktree-1"),
  projectId: ProjectId.make("project-1"),
  name: "fix-login",
  directory: "/store/worktrees/fix-login",
  branch: "mend/fix-login",
  baseRef: "main",
  baseSha: Sha.make("0123456789abcdef0123456789abcdef01234567"),
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

const NEVER_LANDED =
  "This worktree holds a change that was never landed · 10 files · +0 −0 · a.ts +0 −0, b.ts +0 −0, c.ts +0 −0, d.ts +0 −0, e.ts +0 −0, 5 more. Land it or discard it before removal, or pass force=true to remove it anyway.";

const SAVING =
  "not removed · 1 capture saving · the worktree stays until its workspaces have saved and ended, or their owner discards what is unsaved";

const refused = (words: string, sessions = 2): RefusedRemoval => ({
  worktree,
  name: "fix-login",
  sessions,
  refusal: worktreeRemovalRefusalOf(words),
});

const render = (words: string, pending = false) =>
  renderToStaticMarkup(
    <RemoveWorktreeAnywayBody
      refused={refused(words)}
      pending={pending}
      onKeep={() => undefined}
      onRemoveAnyway={() => undefined}
    />,
  );

describe("RemoveWorktreeAnywayBody", () => {
  it("shows the server's words verbatim, what the change holds, and the second step", () => {
    const markup = render(NEVER_LANDED);
    expect(markup).toContain(NEVER_LANDED);
    expect(markup).toContain("10 files");
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) expect(markup).toContain(path);
    expect(markup).toContain("5 more files");
    expect(markup).toContain("Remove anyway");
    expect(markup).toContain("2 sessions, the change and its review go with it.");
    expect(markup).toContain("Keep worktree");
  });

  it("offers no second step for a refusal force does not lift", () => {
    const markup = render(SAVING);
    expect(markup).toContain(SAVING);
    expect(markup).not.toContain("Remove anyway");
    expect(markup).not.toContain("Not on origin");
    expect(markup).toContain("Keep worktree");
  });

  it("says it is removing while the forced removal is in flight", () => {
    const markup = render(NEVER_LANDED, true);
    expect(markup).toContain("Removing…");
    expect(markup).toContain("disabled");
  });
});
