// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { draftKeys, dropAllDrafts, readDraft, writeDraft, writeDrafts } from "./drafts.ts";

beforeEach(() => sessionStorage.clear());

describe("message drafts", () => {
  it("keep each key's words apart, and an empty value drops the key", () => {
    writeDrafts([
      ["alice.s-1.text", "Also cover partial refunds."],
      ["bob.s-1.text", "Bob's words."],
    ]);
    expect(readDraft("alice.s-1.text")).toBe("Also cover partial refunds.");
    writeDraft("alice.s-1.text", "");
    expect(readDraft("alice.s-1.text")).toBe("");
    expect(draftKeys()).toEqual(["bob.s-1.text"]);
  });

  it("all go at sign-out, and nothing else in the tab's storage does", () => {
    sessionStorage.setItem("other", "kept");
    writeDraft("alice.s-1.text", "Words.");
    dropAllDrafts();
    expect(draftKeys()).toEqual([]);
    expect(sessionStorage.getItem("other")).toBe("kept");
  });
});
