import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  firstCommitAuthor,
  PROJECT_NAME_PATTERN,
  ProjectName,
  projectNameFrom,
  projectNameCandidates,
  scratchProjectName,
} from "../src/workbench/index.ts";

describe("project creation names", () => {
  it.each([
    ["My App", "my-app"],
    ["Café déjà vu", "cafe-deja-vu"],
    ["!!!", "project"],
    ["../../etc/passwd", "etc-passwd"],
    ["CON", "con-project"],
  ])("slugs %s like the pinned client", (input, expected) => {
    expect(projectNameFrom(input)).toBe(expected);
  });
  it("allocates exactly base and -2 through -100 within the stored name limit", () => {
    const names = projectNameCandidates(projectNameFrom("a".repeat(100)));
    expect(names[1]).toBe(`${"a".repeat(62)}-2`);
    expect(names[99]).toBe(`${"a".repeat(60)}-100`);
  });
  it("keeps any valid requested name as the stem, shortening it only to fit the suffix", () => {
    expect(projectNameCandidates(ProjectName.make("notes_")).slice(0, 3)).toEqual([
      "notes_",
      "notes_-2",
      "notes_-3",
    ]);
    expect(projectNameCandidates(ProjectName.make("notes."))[1]).toBe("notes.-2");
    expect(projectNameCandidates(ProjectName.make("notes-"))[1]).toBe("notes--2");
    fc.assert(
      fc.property(fc.stringMatching(PROJECT_NAME_PATTERN), (text) => {
        const base = ProjectName.make(text);
        const names = projectNameCandidates(base);
        expect(names).toHaveLength(100);
        expect(new Set(names).size).toBe(100);
        expect(names[0]).toBe(base);
        names.slice(1).forEach((name, index) => {
          const suffix = `-${index + 2}`;
          expect(name).toBe(`${base.slice(0, 64 - suffix.length)}${suffix}`);
          expect(Schema.is(ProjectName)(name)).toBe(true);
        });
      }),
    );
  });
  it("names scratch from the display name's slug, else the email local part's slug, else person", () => {
    expect(scratchProjectName({ name: "Yiannis Panagidis", email: "ignored@example.com" })).toBe(
      "scratch-yiannis-panagidis",
    );
    expect(scratchProjectName({ name: "", email: "Café+notes@example.com" })).toBe(
      "scratch-cafe-notes",
    );
    expect(scratchProjectName({ name: "", email: "" })).toBe("scratch-person");
    expect(scratchProjectName({ name: "!!!", email: "valid@example.com" })).toBe("scratch-valid");
    expect(scratchProjectName({ name: "🎱", email: "yiannis@example.com" })).toBe(
      "scratch-yiannis",
    );
    expect(scratchProjectName({ name: "🎱", email: "+@example.com" })).toBe("scratch-person");
    expect(scratchProjectName({ name: "a".repeat(200), email: "" })).toHaveLength(64);
  });
  it("authors a first commit as the person, falling back to the email's local part for an empty name", () => {
    expect(firstCommitAuthor({ name: " Anna Ng ", email: " anna@example.com " })).toEqual({
      name: "Anna Ng",
      email: "anna@example.com",
    });
    expect(firstCommitAuthor({ name: "  ", email: "Cleo.Q+mend@example.com" })).toEqual({
      name: "Cleo.Q+mend",
      email: "Cleo.Q+mend@example.com",
    });
  });
});
