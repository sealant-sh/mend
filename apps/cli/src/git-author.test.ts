import { describe, expect, it } from "vitest";

import { gitAuthorLine, parseGitAuthorArgs } from "./git-author.ts";

describe("mend git-author", () => {
  it("shows, sets and clears", () => {
    expect(parseGitAuthorArgs([])).toEqual({ kind: "show" });
    expect(parseGitAuthorArgs(["--clear"])).toEqual({ kind: "clear" });
    expect(parseGitAuthorArgs([" Anna Example ", "anna@example.com"])).toEqual({
      kind: "set",
      name: "Anna Example",
      email: "anna@example.com",
    });
  });

  it("refuses what the server would, before asking it", () => {
    expect(parseGitAuthorArgs(["Anna"])).toEqual({ kind: "usage" });
    expect(parseGitAuthorArgs(["Anna", "anna@example.com", "extra"])).toEqual({ kind: "usage" });
    expect(parseGitAuthorArgs(["--clear", "Anna"])).toEqual({ kind: "usage" });
    expect(parseGitAuthorArgs(["Anna", "anna"])).toEqual({
      kind: "invalid",
      message: "git author not saved · the email is not an address like you@example.com",
    });
  });

  it("says where the author comes from", () => {
    expect(gitAuthorLine({ name: "Anna", email: "anna@example.com", source: "account" })).toBe(
      "Anna <anna@example.com> · your account's name and email",
    );
    expect(gitAuthorLine({ name: "Anna", email: "anna@example.com", source: "setting" })).toBe(
      "Anna <anna@example.com> · your setting",
    );
  });
});
