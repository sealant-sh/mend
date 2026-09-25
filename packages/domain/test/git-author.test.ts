import { describe, expect, it } from "vitest";

import { gitAuthorIssue, normalizeGitAuthor } from "../src/workbench/git-author.ts";

describe("git author", () => {
  it("accepts a name and an address, trimmed", () => {
    expect(gitAuthorIssue({ name: " Anna Example ", email: " anna@example.com " })).toBeNull();
    expect(normalizeGitAuthor({ name: " Anna Example ", email: " anna@example.com " })).toEqual({
      name: "Anna Example",
      email: "anna@example.com",
    });
    expect(
      gitAuthorIssue({ name: "anna", email: "1234+anna@users.noreply.github.com" }),
    ).toBeNull();
  });

  it("says why a value cannot be the one git commits", () => {
    expect(gitAuthorIssue({ name: "  ", email: "a@b.c" })).toBe("the name is empty");
    expect(gitAuthorIssue({ name: "Anna", email: "" })).toBe("the email is empty");
    expect(gitAuthorIssue({ name: "Anna <anna@b.c>", email: "a@b.c" })).toBe(
      "the name contains <, > or a line break",
    );
    expect(gitAuthorIssue({ name: "Anna\nEvil", email: "a@b.c" })).toBe(
      "the name contains <, > or a line break",
    );
    expect(gitAuthorIssue({ name: "Anna", email: "anna" })).toBe(
      "the email is not an address like you@example.com",
    );
    expect(gitAuthorIssue({ name: "Anna", email: "anna @example.com" })).toBe(
      "the email is not an address like you@example.com",
    );
    expect(gitAuthorIssue({ name: "x".repeat(201), email: "a@b.c" })).toBe(
      "the name is longer than 200 characters",
    );
  });
});
