import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Schema } from "effect";
import * as fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";

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
  it("authors a first commit as the person, trimmed", () => {
    expect(firstCommitAuthor({ name: " Anna Ng ", email: " anna@example.com " })).toEqual({
      name: "Anna Ng",
      email: "anna@example.com",
    });
  });
  describe("authors a first commit with a name the real git binary stores unchanged", () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), "mend-first-commit-author-"));
    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: repository,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    execFileSync("git", ["init", "--quiet", "--bare", repository], { env });
    const tree = execFileSync("git", ["mktree"], { cwd: repository, env, input: "" })
      .toString()
      .trim();
    /** The author name git stores for `name`, or null when git refuses it. */
    const storedByGit = (name: string): string | null => {
      const ident = { GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_EMAIL: "a@example.com" };
      const result = spawnSync("git", ["commit-tree", tree, "-m", "probe"], {
        cwd: repository,
        env: { ...env, ...ident, GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name },
      });
      if (result.status !== 0) return null;
      const commit = result.stdout.toString().trim();
      return execFileSync("git", ["log", "-1", "--format=%an", commit], { cwd: repository, env })
        .toString()
        .replace(/\n$/, "");
    };
    afterAll(() => fs.rmSync(repository, { recursive: true, force: true }));

    it.each([
      [":", "jane.doe@example.com", "jane.doe"],
      [";", "jane.doe@example.com", "jane.doe"],
      [",", "jane.doe@example.com", "jane.doe"],
      ["Alice:", "alice@example.com", "Alice"],
      ["Alice;", "alice@example.com", "Alice"],
      ["<>", "jane.doe@example.com", "jane.doe"],
      ["Jane <Team>", "jane.doe@example.com", "Jane Team"],
      ["Jane\nDoe", "jane.doe@example.com", "JaneDoe"],
      [" .Anna Ng. ", "anna@example.com", ".Anna Ng."],
      ['"Anna", ', "anna@example.com", "Anna"],
      ["", "Cleo.Q+mend@example.com", "Cleo.Q+mend"],
      ["  ", "'cleo'@example.com", "cleo"],
      [":", ":;,@example.com", "person"],
      ["", "", "person"],
    ])("%j with email %j as %j", (name, email, expected) => {
      const author = firstCommitAuthor({ name, email });
      expect(author.name).toBe(expected);
      expect(storedByGit(author.name)).toBe(author.name);
      const git = storedByGit(name.trim());
      if (git !== null) expect(author.name).toBe(git);
    });
    it("keeps a long name git stores whole", () => {
      const name = "x".repeat(201);
      expect(firstCommitAuthor({ name, email: "x@example.com" }).name).toBe(name);
      expect(storedByGit(name)).toBe(name);
    });
  });
});
