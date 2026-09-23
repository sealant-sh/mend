import type { AutomationChoice } from "@mend/domain/workbench";
import { GitError } from "@mend/store";
import { describe, expect, it } from "vitest";

import { readFailureAnnotations, reviewPassesFor } from "../src/review-prep.ts";

/**
 * The review-prep warning must be diagnosable from the log line alone (observed facts, never a
 * verdict): git's command and stderr, the worktree, and the chain head the read was to come
 * from with its verification state. The cluster's first session logged
 * `Cause([Fail(GitError)])` and named nothing.
 */
describe("review prep: read failure annotations", () => {
  it("carries git's words and the capture the read was to come from", () => {
    const error = new GitError({
      args: ["diff", "--numstat", "4780782", "b4c737f7"],
      cwd: "/var/lib/mend/store/_cache/runner/proj/repo.git",
      exitCode: 128,
      stderr: "fatal: unable to read tree (345a070a)\n",
    });
    const annotations = readFailureAnnotations(error, {
      sessionId: "sess-1",
      worktreeId: "wt-1",
      changeId: "change-1",
      head: { n: 5, id: "cap-5", gitFsck: "failed" },
    });
    expect(annotations).toEqual({
      sessionId: "sess-1",
      worktreeId: "wt-1",
      changeId: "change-1",
      captureN: 5,
      captureId: "cap-5",
      gitFsck: "failed",
      git: "git diff --numstat 4780782 b4c737f7",
      exitCode: 128,
      stderr: "fatal: unable to read tree (345a070a)",
    });
    expect(JSON.stringify(annotations)).not.toContain("Cause(");
  });

  it("says when there is no chain head to name (the co-located store)", () => {
    const error = new GitError({ args: ["status"], cwd: "/wt", exitCode: null, stderr: "" });
    const annotations = readFailureAnnotations(error, {
      sessionId: "s",
      worktreeId: "w",
      changeId: "c",
      head: null,
    });
    expect(annotations["captureN"]).toBeNull();
    expect(annotations["captureId"]).toBeNull();
    expect(annotations["gitFsck"]).toBeNull();
    expect(annotations["git"]).toBe("git status");
  });
});

describe("review prep: which passes a settled session queues", () => {
  const off: { readonly autoTour: AutomationChoice; readonly autoSuggest: AutomationChoice } = {
    autoTour: "off",
    autoSuggest: "off",
  };
  const settingsOff = { autoTour: false, autoSuggest: false };

  it("resolves each switch, the project's choice first and Settings under inherit", () => {
    expect(reviewPassesFor({ origin: "mend", project: off, settings: settingsOff })).toEqual({
      tour: false,
      suggest: false,
    });
    expect(
      reviewPassesFor({
        origin: "mend",
        project: { autoTour: "inherit", autoSuggest: "on" },
        settings: { autoTour: true, autoSuggest: false },
      }),
    ).toEqual({ tour: true, suggest: true });
    expect(
      reviewPassesFor({
        origin: "mend",
        project: { autoTour: "off", autoSuggest: "inherit" },
        settings: { autoTour: true, autoSuggest: true },
      }),
    ).toEqual({ tour: false, suggest: true });
  });

  it("queues the tour for a session started from Slack even with the switch off", () => {
    expect(reviewPassesFor({ origin: "slack", project: off, settings: settingsOff })).toEqual({
      tour: true,
      suggest: false,
    });
  });
});
