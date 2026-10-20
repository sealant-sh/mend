import { describe, expect, it } from "vitest";

import {
  openFolderOptions,
  reduceOpen,
  statusText,
  stepLabel,
  workspaceNeed,
  type OpenState,
  type OpenStep,
} from "./open-flow.js";
import { SESSION_STATUSES, type SessionStatus } from "./types.js";

const resuming: OpenStep = { kind: "resuming" };

describe("workspaceNeed", () => {
  const expected: Record<SessionStatus, { readonly withId: string; readonly withoutId: string }> = {
    starting: { withId: "have", withoutId: "wait" },
    running: { withId: "have", withoutId: "wait" },
    waiting: { withId: "have", withoutId: "wait" },
    idle: { withId: "have", withoutId: "wait" },
    stopping: { withId: "wait", withoutId: "wait" },
    completed: { withId: "resume", withoutId: "resume" },
    failed: { withId: "resume", withoutId: "resume" },
    stopped: { withId: "resume", withoutId: "resume" },
  };

  it.each(SESSION_STATUSES)("reads %s", (status) => {
    expect(workspaceNeed({ status, sealantWorkspaceId: "ws" })).toBe(expected[status].withId);
    expect(workspaceNeed({ status, sealantWorkspaceId: null })).toBe(expected[status].withoutId);
  });
});

describe("openFolderOptions", () => {
  it("passes nothing for Open and forces a window for Open in New Window", () => {
    expect(openFolderOptions("follow-setting")).toEqual({});
    expect(openFolderOptions("new-window")).toEqual({ forceNewWindow: true });
  });
});

describe("the open's words", () => {
  it("counts whole seconds since the step began", () => {
    expect(statusText({ kind: "awaitingWorkspace", since: 1_000 }, "add-rate-limit", 21_900)).toBe(
      "starting add-rate-limit's workspace · 20 s",
    );
    expect(
      statusText(
        { kind: "preparing", step: { kind: "settingUpWorkspaceSsh" }, since: 0 },
        "add-rate-limit",
        2_000,
      ),
    ).toBe("setting up workspace SSH · 2 s");
    expect(stepLabel({ kind: "installingRemoteSsh" }, "add-rate-limit")).toBe(
      "installing Remote-SSH",
    );
  });

  it("says it is opening, and nothing once done, failed or asking", () => {
    expect(statusText({ kind: "opening", workspaceId: "ws" }, "add-rate-limit", 0)).toBe(
      "opening add-rate-limit",
    );
    expect(statusText({ kind: "done" }, "add-rate-limit", 0)).toBeNull();
    expect(statusText({ kind: "awaitingConsent" }, "add-rate-limit", 0)).toBeNull();
    expect(
      statusText({ kind: "failed", reason: "no", action: "Retry" }, "add-rate-limit", 0),
    ).toBeNull();
  });
});

describe("reduceOpen", () => {
  it("walks a stopped session's open, the clock carried from the resume into the wait", () => {
    let state: OpenState = { kind: "idle" };
    state = reduceOpen(state, { kind: "step", step: resuming, at: 1_000 });
    expect(state).toEqual({ kind: "preparing", step: resuming, since: 1_000 });
    state = reduceOpen(state, { kind: "waiting", at: 3_000 });
    expect(state).toEqual({ kind: "awaitingWorkspace", since: 1_000 });
    state = reduceOpen(state, { kind: "workspace", workspaceId: "ws" });
    expect(state).toEqual({ kind: "opening", workspaceId: "ws" });
    state = reduceOpen(state, { kind: "opened" });
    expect(state).toEqual({ kind: "done" });
  });

  it("starts the wait's clock when nothing was resumed", () => {
    expect(reduceOpen({ kind: "idle" }, { kind: "waiting", at: 5_000 })).toEqual({
      kind: "awaitingWorkspace",
      since: 5_000,
    });
  });

  it("restarts the clock for a new step and keeps it for the same one", () => {
    const setUp: OpenStep = { kind: "settingUpWorkspaceSsh" };
    const installing: OpenState = {
      kind: "preparing",
      step: { kind: "installingRemoteSsh" },
      since: 0,
    };
    expect(
      reduceOpen(installing, { kind: "step", step: { kind: "installingRemoteSsh" }, at: 9 }),
    ).toBe(installing);
    expect(reduceOpen(installing, { kind: "step", step: setUp, at: 9 })).toEqual({
      kind: "preparing",
      step: setUp,
      since: 9,
    });
  });

  it("goes back to idle when she declines, and takes nothing after a run ends", () => {
    expect(reduceOpen({ kind: "awaitingConsent" }, { kind: "cancelled" })).toEqual({
      kind: "idle",
    });
    const failed: OpenState = { kind: "failed", reason: "refused", action: "Retry" };
    expect(reduceOpen(failed, { kind: "workspace", workspaceId: "ws" })).toBe(failed);
    expect(reduceOpen({ kind: "done" }, { kind: "waiting", at: 1 })).toEqual({ kind: "done" });
  });
});
