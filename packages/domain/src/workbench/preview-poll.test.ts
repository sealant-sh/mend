import { describe, expect, it } from "vitest";

import { makePreviewPoll, PREVIEW_POLL_MS, PREVIEW_POLL_STALL_MS } from "./preview-poll.ts";

const said = (starting: boolean, facts: ReadonlyArray<unknown>) => ({
  previews: [{ preview: { id: "pv-web" }, facts }],
  unprepared: null,
  starting,
});
const setup = () => said(true, [{ _tag: "Starting", service: "web", phase: "setup" }]);
const service = () => said(true, [{ _tag: "Starting", service: "web", phase: "service" }]);
const settled = () =>
  said(false, [
    { _tag: "Observed", service: "web", reachable: true, httpStatus: 200, observedAt: new Date() },
  ]);

describe("when the previews read is read again", () => {
  it("polls while a start is under way and stops once it settles", () => {
    const poll = makePreviewPoll();
    expect(poll("worktree-1", setup(), 0)).toBe(PREVIEW_POLL_MS);
    expect(poll("worktree-1", service(), 2_000)).toBe(PREVIEW_POLL_MS);
    expect(poll("worktree-1", settled(), 4_000)).toBe(false);
    expect(poll("worktree-1", undefined, 6_000)).toBe(false);
  });

  it("gives up on a start that has said the same thing for the stall limit, and resumes on a change", () => {
    const poll = makePreviewPoll();
    expect(poll("worktree-1", setup(), 0)).toBe(PREVIEW_POLL_MS);
    expect(poll("worktree-1", setup(), PREVIEW_POLL_STALL_MS - 1)).toBe(PREVIEW_POLL_MS);
    expect(poll("worktree-1", setup(), PREVIEW_POLL_STALL_MS)).toBe(false);
    expect(poll("worktree-1", service(), PREVIEW_POLL_STALL_MS + 1)).toBe(PREVIEW_POLL_MS);
  });

  it("counts an observation that only ages as the same thing", () => {
    const poll = makePreviewPoll();
    const ageing = (at: string) =>
      said(true, [
        { _tag: "Starting", service: "web", phase: "setup" },
        { _tag: "Observed", service: "docs", reachable: true, httpStatus: 200, observedAt: at },
      ]);
    expect(poll("worktree-1", ageing("2026-10-30T12:00:00.000Z"), 0)).toBe(PREVIEW_POLL_MS);
    expect(poll("worktree-1", ageing("2026-10-30T12:09:59.000Z"), PREVIEW_POLL_STALL_MS)).toBe(
      false,
    );
  });
});
