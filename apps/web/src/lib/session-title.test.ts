import { describe, expect, it } from "vitest";

import { sessionTitleOf } from "./session-title.ts";

describe("what the web calls a session", () => {
  it("is its inbox row's title, which the server words", () => {
    expect(sessionTitleOf({ title: "tell me a joke" }, null)).toBe("tell me a joke");
  });

  it("is its label, else New session, until its row arrives: never its worktree or branch", () => {
    expect(sessionTitleOf(null, "repository overview")).toBe("repository overview");
    expect(sessionTitleOf(undefined, null)).toBe("New session");
    expect(sessionTitleOf(null, undefined)).toBe("New session");
  });
});
