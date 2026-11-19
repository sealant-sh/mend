import { ProjectPreviewView } from "@mend/api-contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  changedWords,
  currentChoice,
  previewChoices,
  previewHost,
  previewLine,
} from "./project-services.ts";

const day = (d: number) => new Date(2026, 10, d);

const choices = previewChoices({
  defaultBranch: "main",
  worktrees: [
    { id: "wt-old", name: "old-spike", branch: "mend/old-spike", updatedAt: day(2) },
    { id: "wt-retry", name: "fix-retry", branch: "mend/fix-checkout-retry", updatedAt: day(10) },
    { id: "wt-refunds", name: "refunds", branch: "mend/refund-keys", updatedAt: day(5) },
  ],
  sessions: [
    {
      worktreeId: "wt-retry",
      label: "Fix flaky checkout retry",
      status: "completed",
      ownerUserId: "ada",
      updatedAt: day(10),
    },
    {
      worktreeId: "wt-refunds",
      label: "Add idempotency keys to refunds",
      status: "running",
      ownerUserId: "ada",
      updatedAt: day(5),
    },
    // An older session in the same worktree doesn't name it.
    {
      worktreeId: "wt-refunds",
      label: "Earlier try",
      status: "stopped",
      ownerUserId: "grace",
      updatedAt: day(3),
    },
  ],
  members: [{ userId: "ada", name: "Ada Lovelace" }],
});

/** The preview read for a project, decoded as the API's answer is. */
const read = (over: Record<string, unknown>): ProjectPreviewView =>
  Schema.decodeUnknownSync(ProjectPreviewView)({
    configured: true,
    fixed: null,
    url: null,
    target: null,
    status: [],
    open: null,
    canManage: true,
    ...over,
  });
/** A fixed address that shows `targetId`, picked as a worktree or as the default branch. */
const fixedOn = (mode: "default" | "worktree", targetId: string) =>
  read({
    url: "https://checkout-api.preview.northwind.dev/",
    fixed: {
      targetMode: mode,
      preview: {
        id: "pv-1",
        serviceName: "web",
        label: "aaaaaaaaaaaaaaaaaaaaaaaaaa",
        scope: "worktree",
        projectId: "p-1",
        worktreeId: targetId,
        state: "kept",
      },
    },
    target: { id: targetId, name: "fix-retry", branch: "mend/fix-checkout-retry" },
  });

describe("Change worktree…'s choices", () => {
  it("puts worktrees with a live session first, then the newest, and the default branch last", () => {
    expect(choices.map((choice) => (choice.kind === "default" ? "default" : choice.id))).toEqual([
      "wt-refunds",
      "wt-retry",
      "wt-old",
      "default",
    ]);
  });

  it("names a worktree by its newest session, with who started it and where it stands", () => {
    expect(choices[0]).toEqual({
      kind: "worktree",
      id: "wt-refunds",
      label: "Add idempotency keys to refunds",
      branch: "mend/refund-keys",
      facts: "Ada Lovelace · Running",
    });
    expect(choices[2]).toMatchObject({ label: "old-spike", facts: null });
  });
});

describe("the fixed preview address", () => {
  it("names the host, the Service and the worktree it shows", () => {
    expect(previewHost("https://checkout-api.preview.northwind.dev/")).toBe(
      "checkout-api.preview.northwind.dev",
    );
    expect(previewLine(fixedOn("worktree", "wt-retry"), choices)).toBe(
      'checkout-api.preview.northwind.dev always shows web from the worktree of "Fix flaky checkout retry". Each session also has its own preview address.',
    );
    expect(currentChoice(fixedOn("worktree", "wt-retry"))).toBe("wt-retry");
  });

  it("says when it shows the default branch", () => {
    expect(currentChoice(fixedOn("default", "wt-keep"))).toBe("default");
    expect(previewLine(fixedOn("default", "wt-keep"), choices)).toContain(
      "from the default branch, main, in a worktree Mend keeps for the preview.",
    );
  });

  it("says how to get one when the file declares none, and that none is picked yet", () => {
    expect(previewLine(read({ configured: false }), choices)).toMatch(
      /^The project has no fixed preview address\. To give it one, name an HTTP Service/,
    );
    expect(currentChoice(read({}))).toBeNull();
    expect(previewLine(read({}), choices)).toMatch(
      /^Mend gives the project its fixed address when/,
    );
  });

  it("confirms the change in a toast", () => {
    expect(changedWords(choices[0] ?? { kind: "default", branch: "main" })).toBe(
      'The preview address now shows "Add idempotency keys to refunds".',
    );
    expect(changedWords({ kind: "default", branch: "main" })).toBe(
      "The preview address now shows the default branch, main.",
    );
  });
});
