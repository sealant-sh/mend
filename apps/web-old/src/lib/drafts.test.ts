// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { clearSentDraft, readDraft, reviewDraftKey, writeDraft } from "./drafts";

const scope = { userId: "alice", changeId: "change-1", sliceId: "slice-1" };

beforeEach(() => sessionStorage.clear());

describe("review comment drafts", () => {
  it("keep one draft per account, change, slice and anchor", () => {
    writeDraft(reviewDraftKey(scope, "src/a.ts:4-4"), "An unknown tab should 404.");
    writeDraft(reviewDraftKey({ ...scope, sliceId: "slice-2" }, "src/a.ts:4-4"), "Later slice.");
    writeDraft(reviewDraftKey({ ...scope, userId: "bob" }, "src/a.ts:4-4"), "Bob's words.");
    expect(readDraft(reviewDraftKey(scope, "src/a.ts:4-4"))).toBe("An unknown tab should 404.");
    expect(readDraft(reviewDraftKey(scope, "whole"))).toBe("");
  });

  it("go once sent, unless they were edited while the send was out", () => {
    const key = reviewDraftKey(scope, "whole");
    writeDraft(key, "Add a test.");
    clearSentDraft(key, "Add a test.");
    expect(readDraft(key)).toBe("");
    writeDraft(key, "Add a test for the old link.");
    clearSentDraft(key, "Add a test.");
    expect(readDraft(key)).toBe("Add a test for the old link.");
  });

  it("go at sign-out with the message drafts", () => {
    writeDraft(reviewDraftKey(scope, "whole"), "Words.");
    expect(Object.keys(sessionStorage).some((key) => key.startsWith("mend.message."))).toBe(true);
  });
});
