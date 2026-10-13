import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FastCheck } from "effect/testing";
import { describe, expect, it } from "vitest";

import { diffMessages, splitDiff } from "./format.ts";

const withGit = (work: (repo: string, git: (...args: string[]) => string) => void) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mend-split-diff-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  try {
    git("init", "-q");
    git("config", "core.quotePath", "true");
    git("config", "core.fileMode", "true");
    work(repo, git);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
};
const write = (repo: string, name: string, content: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  fs.writeFileSync(path.join(repo, name), content);
};
const commit = (git: (...args: string[]) => string) => {
  git("add", "--all");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base");
};
const patch = (git: (...args: string[]) => string, ...options: string[]) =>
  git("diff", "--no-ext-diff", "--no-textconv", "--no-color", ...options, "HEAD");

const names = [
  "plain.txt",
  "naïve.txt",
  "emoji-🚀.txt",
  'quote"file.txt',
  "slash\\file.txt",
  "tab\tfile.txt",
  "line\nfile.txt",
  "carriage\rfile.txt",
  "controls-\x07\x08\x0b\x0c.txt",
  " space .txt",
  "folder b/file.txt",
];

describe("splitDiff through real Git filename output", () => {
  // Forty real Git repositories exceeded the default five-second guard on the shared CI runner.
  it(
    "preserves generated UTF-8 filenames through Git quoting and exact patch association",
    { timeout: 30_000 },
    () => {
      const segment = FastCheck.array(
        FastCheck.constantFrom("a", "Z", " ", "界", "🚀", "ñ", "\t", "\n", '"', "\\", "\ufeff"),
        { minLength: 1, maxLength: 14 },
      ).map((parts) => `generated-${parts.join("")}.txt`);
      FastCheck.assert(
        FastCheck.property(segment, (name) =>
          withGit((repo, git) => {
            write(repo, name, "before\n");
            commit(git);
            write(repo, name, "after\n");
            const diff = patch(git);
            expect([...splitDiff(diff)]).toEqual([[name, diff.trimEnd()]]);
          }),
        ),
        { numRuns: 40, seed: 822858 },
      );
    },
  );
  it("keeps a leading UTF-8 BOM in a quoted rename destination", () =>
    withGit((repo, git) => {
      const oldName = "old.txt",
        newName = "\ufeffname.txt";
      write(repo, oldName, "same\n");
      commit(git);
      fs.renameSync(path.join(repo, oldName), path.join(repo, newName));
      git("add", "--all");
      const diff = patch(git, "--find-renames");
      expect([...splitDiff(diff)]).toEqual([[newName, diff.trimEnd()]]);
    }));
  it("does not invent a filename from malformed quoted path labels", () => {
    for (const name of ['"a/bad\\q.txt"', '"a/bad\\400.txt"', '"a/bad\\377.txt"', '"a/no-close']) {
      const diff = `diff --git ${name} ${name}\n--- ${name}\n+++ ${name}\n@@ -1 +1 @@\n-before\n+after\n`;
      expect([...splitDiff(diff)]).toEqual([]);
    }
  });

  for (const quotePath of [true, false]) {
    for (const name of names) {
      it(`keeps the exact text patch for ${JSON.stringify(name)} with core.quotePath=${quotePath}`, () =>
        withGit((repo, git) => {
          git("config", "core.quotePath", String(quotePath));
          write(repo, name, "before\n");
          commit(git);
          write(repo, name, "after\n");
          const diff = patch(git);
          const parts = splitDiff(diff);
          expect([...parts.keys()]).toEqual([name]);
          expect(parts.get(name)).toBe(diff.trimEnd());
          const rendered = diffMessages(
            [{ path: name, additions: 1, deletions: 1, diff: parts.get(name) ?? null }],
            "https://mend.example.test/change",
          );
          const block = rendered[0]?.blocks[0];
          expect(block?.type === "markdown" ? block.text : "").toContain("```diff\n");
          expect(block?.type === "markdown" ? block.text : "").not.toContain("No text diff.");
        }));
    }
  }
  for (const mode of ["add", "delete", "mode", "binary"]) {
    it(`associates a quoted ${mode} patch with the actual filename`, () =>
      withGit((repo, git) => {
        const name = 'naïve " b/file.txt';
        write(repo, "keep.txt", "keep\n");
        if (mode !== "add")
          write(repo, name, mode === "binary" ? new Uint8Array([0, 1, 2]) : "before\n");
        commit(git);
        if (mode === "add") {
          write(repo, name, "after\n");
          git("add", "--all");
        }
        if (mode === "delete") fs.rmSync(path.join(repo, name));
        if (mode === "mode") fs.chmodSync(path.join(repo, name), 0o755);
        if (mode === "binary") write(repo, name, new Uint8Array([0, 3, 4]));
        const diff = patch(git);
        expect([...splitDiff(diff)]).toEqual([[name, diff.trimEnd()]]);
      }));
  }
  for (const edited of [false, true]) {
    it(`uses the actual destination for a quoted rename with edited=${edited}`, () =>
      withGit((repo, git) => {
        const oldName = "old-ñ.txt",
          newName = 'new b/quote".txt';
        const content = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
        write(repo, oldName, content);
        commit(git);
        fs.mkdirSync(path.dirname(path.join(repo, newName)), { recursive: true });
        fs.renameSync(path.join(repo, oldName), path.join(repo, newName));
        if (edited) write(repo, newName, content + "new line\n");
        git("add", "--all");
        const diff = patch(git, "--find-renames");
        expect(diff).toContain("rename to ");
        expect([...splitDiff(diff)]).toEqual([[newName, diff.trimEnd()]]);
      }));
  }
  it("uses the actual destination for a quoted copy-only patch", () =>
    withGit((repo, git) => {
      const oldName = "old-ñ.txt",
        newName = 'new b/copy".txt';
      write(repo, oldName, "same content\n");
      commit(git);
      write(repo, newName, "same content\n");
      git("add", "--all");
      const diff = patch(git, "--find-copies", "--find-copies-harder");
      expect(diff).toContain("copy to ");
      expect([...splitDiff(diff)]).toEqual([[newName, diff.trimEnd()]]);
    }));
  it("keeps metadata-like hunk content in its own file", () =>
    withGit((repo, git) => {
      const name = "naïve.txt";
      write(repo, name, "-- a/decoy.txt\n++ b/other.txt\n");
      commit(git);
      write(repo, name, "++ b/phantom.txt\ndiff --git a/fake b/fake\n");
      const diff = patch(git);
      expect([...splitDiff(diff)]).toEqual([[name, diff.trimEnd()]]);
    }));
  it("uses the full same-path mode header when a filename contains the literal separator b/", () =>
    withGit((repo, git) => {
      const name = "folder b/file.txt";
      write(repo, name, "before\n");
      commit(git);
      fs.chmodSync(path.join(repo, name), 0o755);
      const diff = patch(git);
      expect([...splitDiff(diff)]).toEqual([[name, diff.trimEnd()]]);
    }));
});
