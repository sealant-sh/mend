import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { restoreCheckpointExec, restoreFailureWords } from "../src/checkpoint-restore.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
const git = (cwd: string, args: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...extra,
    },
  })
    .toString("utf8")
    .trim();

const write = (repo: string, file: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const read = (repo: string, file: string) =>
  fs.existsSync(path.join(repo, file)) ? fs.readFileSync(path.join(repo, file), "utf8") : null;

/** A checkpoint as Mend takes one: the files, untracked included, as a commit off any ref. */
const checkpoint = (repo: string): string => {
  const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mend-cp-")), "index");
  dirs.push(path.dirname(index));
  git(repo, ["add", "-A"], { GIT_INDEX_FILE: index });
  const tree = git(repo, ["write-tree"], { GIT_INDEX_FILE: index });
  return git(repo, ["commit-tree", tree, "-p", "HEAD", "-m", "checkpoint"]);
};

const run = (repo: string, commit: string, pack: string | null = null) => {
  const [command, ...args] = restoreCheckpointExec({ repository: repo, commit, pack });
  const ran = spawnSync(command ?? "node", args, { cwd: repo, env, encoding: "utf8" });
  return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr };
};

const fixture = () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mend-restore-"));
  dirs.push(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, ".gitignore", "build/\n");
  write(repo, "kept.txt", "base\n");
  write(repo, "gone-later.txt", "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "base"]);
  return repo;
};

describe("going back to a checkpoint in the workspace", () => {
  it("puts tracked and untracked files back, removes newer ones, and leaves ignored files, HEAD and the branch alone", () => {
    const repo = fixture();
    write(repo, "kept.txt", "at the checkpoint\n");
    write(repo, "notes/untracked.md", "untracked at the checkpoint\n");
    const at = checkpoint(repo);
    // After the checkpoint: an edit, a new file in a new directory, a deletion, a commit, staging.
    write(repo, "kept.txt", "later\n");
    write(repo, "added/deep/new.ts", "later\n");
    fs.rmSync(path.join(repo, "notes/untracked.md"));
    git(repo, ["rm", "-q", "gone-later.txt"]);
    git(repo, ["commit", "-q", "-m", "later"]);
    write(repo, "build/out.js", "ignored\n");
    git(repo, ["add", "kept.txt"]);
    const head = git(repo, ["rev-parse", "HEAD"]);

    const ran = run(repo, at);

    expect(ran.exitCode).toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({ kind: "restored", removed: 1 });
    expect(read(repo, "kept.txt")).toBe("at the checkpoint\n");
    expect(read(repo, "gone-later.txt")).toBe("base\n");
    expect(read(repo, "notes/untracked.md")).toBe("untracked at the checkpoint\n");
    expect(read(repo, "added/deep/new.ts")).toBeNull();
    expect(fs.existsSync(path.join(repo, "added"))).toBe(false);
    expect(read(repo, "build/out.js")).toBe("ignored\n");
    expect(git(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    // Staging is back to HEAD: nothing staged.
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });

  it("changes nothing when the workspace lacks the checkpoint, and says so", () => {
    const repo = fixture();
    write(repo, "kept.txt", "unsaved\n");

    const ran = run(repo, "f".repeat(40));

    expect(ran.exitCode).toBe(3);
    expect(restoreFailureWords(ran.stderr)).toBe(
      "This workspace doesn't have the checkpoint's files.",
    );
    expect(read(repo, "kept.txt")).toBe("unsaved\n");
  });

  it("reads the checkpoint's objects from a pack placed beside the repository", () => {
    const source = fixture();
    write(source, "kept.txt", "from the pack\n");
    const at = checkpoint(source);
    const base = git(source, ["rev-parse", "HEAD"]);
    // The workspace has the base, as every workspace of the worktree does, but not the checkpoint.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mend-restore-clone-"));
    dirs.push(repo);
    git(os.tmpdir(), ["clone", "-q", source, repo]);
    const objects = git(source, ["rev-list", "--objects", at, "--not", base]);
    const pack = path.join(repo, "..", `${path.basename(repo)}.pack`);
    fs.writeFileSync(
      pack,
      execFileSync("git", ["pack-objects", "--stdout"], { cwd: source, input: `${objects}\n` }),
    );
    dirs.push(pack);

    const ran = run(repo, at, pack);

    expect(ran.exitCode).toBe(0);
    expect(read(repo, "kept.txt")).toBe("from the pack\n");
  });
});
