import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { git, GitError, gitExitUnexplained, gitQuiet, gitRejectsContent } from "../src/git.ts";

/**
 * Review 2026-09-28 (13) #1: a git run the Mend host could not finish says nothing about the
 * content it read. Only git's own words rejecting a pack or naming a missing object do.
 */
/** A failed git run, as `git` reports one. */
const error = (fields: Partial<ConstructorParameters<typeof GitError>[0]>) =>
  new GitError({ args: ["index-pack"], cwd: "/", exitCode: 128, stderr: "", ...fields });

/** Run git in `cwd` under a fixed identity, answering its trimmed stdout. */
const gitIn = (args: ReadonlyArray<string>, cwd: string, input?: string) =>
  execFileSync("git", [...args], {
    cwd,
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  })
    .toString()
    .trim();

describe("git failures: the content's, or the host's", () => {
  it("reads git rejecting a pack's bytes or a closure's objects as content", () => {
    for (const stderr of [
      "error: inflate: data stream error (invalid code lengths set)\nfatal: pack has bad object at offset 12: inflate returned -3",
      "fatal: pack is corrupted (SHA1 mismatch)",
      "fatal: pack has junk at the end",
      "fatal: pack signature mismatch",
      "fatal: early EOF",
      "fatal: sha1 file 'c4.idx' validation error",
      "fatal: missing blob object '613a5a04d58ce6fd557db792297674aa76e0872f'",
      "fatal: bad tree object 44f4aed0942f0934ed60da67d18598414ddffab6",
      "fatal: bad object e7bb271b2a588a548903499331d3571e7e26eb5a",
    ]) {
      expect(gitRejectsContent(error({ stderr })), stderr).toBe(true);
    }
  });

  it("reads a signal, Node's own failure, a local resource or words it does not know as the host's", () => {
    for (const fields of [
      { exitCode: null, signal: "SIGKILL", stderr: "" },
      {
        exitCode: null,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stderr: "stdout maxBuffer length exceeded",
      },
      { exitCode: null, code: "ENOENT", stderr: "spawn git ENOENT" },
      { stderr: "fatal: unable to create temporary file: No space left on device" },
      { stderr: "fatal: Out of memory, malloc failed (tried to allocate 1048576 bytes)" },
      { stderr: "fatal: mmap failed: Cannot allocate memory" },
      { stderr: "fatal: could not read 'objects/pack/x.pack': Input/output error" },
      { stderr: "fatal: pack has bad object at offset 12: Too many open files" },
      { stderr: "fatal: Cannot open existing pack file 'nope.idx'" },
      { stderr: "fatal: something git never said before" },
      // A content word with a signal still ended by the signal.
      { exitCode: null, signal: "SIGTERM", stderr: "fatal: early EOF" },
    ]) {
      expect(gitRejectsContent(error(fields)), JSON.stringify(fields)).toBe(false);
    }
  });

  it("review 14 #4: reads a missing parent commit as content only on git's exit 128, with no signal and no host word", () => {
    const words =
      "error: Could not read daf69db00e0ab4928961803f6255bdc5baa40317\nfatal: Failed to traverse parents of commit edaa07f5acc3d303e75ab218585c00657f968e63";
    expect(gitRejectsContent(error({ stderr: words }))).toBe(true);
    expect(gitRejectsContent(error({ exitCode: 1, stderr: words }))).toBe(false);
    expect(gitRejectsContent(error({ exitCode: null, signal: "SIGKILL", stderr: words }))).toBe(
      false,
    );
    expect(gitRejectsContent(error({ stderr: `${words}\nfatal: Input/output error` }))).toBe(false);
    // A 64-hex id (SHA-256) as well.
    expect(gitRejectsContent(error({ stderr: `error: Could not read ${"a".repeat(64)}` }))).toBe(
      true,
    );
  });

  it("review 14 #4: an exit git chose in words neither list knows is unexplained; a signal, a host word or a content word is not", () => {
    expect(gitExitUnexplained(error({ stderr: "fatal: something git never said before" }))).toBe(
      true,
    );
    expect(gitExitUnexplained(error({ exitCode: null, signal: "SIGKILL", stderr: "" }))).toBe(
      false,
    );
    expect(
      gitExitUnexplained(error({ stderr: "fatal: unable to write: No space left on device" })),
    ).toBe(false);
    expect(gitExitUnexplained(error({ stderr: "fatal: bad tree object abc" }))).toBe(false);
  });

  describe("review 14 #4: a closure missing a parent commit, walked by real git", () => {
    let repo = "";
    let tip = "";
    beforeAll(() => {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), "mend-miss-parent-work-"));
      gitIn(["init", "-q"], work);
      fs.writeFileSync(path.join(work, "a.txt"), "one\n");
      gitIn(["add", "a.txt"], work);
      gitIn(["commit", "-q", "-m", "one"], work);
      fs.writeFileSync(path.join(work, "a.txt"), "two\n");
      gitIn(["commit", "-q", "-am", "two"], work);
      tip = gitIn(["rev-parse", "HEAD"], work);
      const tree = gitIn(["rev-parse", "HEAD^{tree}"], work);
      const blob = gitIn(["rev-parse", "HEAD:a.txt"], work);
      // The tip's commit, tree and blob — and not its parent commit.
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "mend-miss-parent-"));
      execFileSync("git", ["init", "-q", "--bare", repo]);
      const pack = execFileSync("git", ["pack-objects", "-q", "--stdout"], {
        cwd: work,
        input: `${tip}\n${tree}\n${blob}\n`,
      });
      execFileSync("git", ["index-pack", "--stdin"], { cwd: repo, input: pack });
      fs.rmSync(work, { recursive: true, force: true });
    });
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

    it("is git's word on the content, not a host fault", async () => {
      const walked = await Effect.runPromise(
        Effect.flip(
          gitQuiet(["rev-list", "--objects", "--missing=error", "--no-object-names", tip], repo),
        ),
      );
      expect(walked.exitCode).toBe(128);
      expect(walked.stderr).toMatch(/failed to traverse parents/i);
      // Before: false — read as the Mend host's fault, and every plan of it waited for good.
      expect(gitRejectsContent(walked)).toBe(true);
    });
  });

  describe("output past the buffer", () => {
    let repo = "";
    let blob = "";
    // More than `git`'s 64 MiB buffer: what `rev-list --objects` prints for ~1.7M objects.
    const bytes = 70 * 1024 * 1024;
    beforeAll(() => {
      repo = fs.mkdtempSync(path.join(os.tmpdir(), "mend-git-quiet-"));
      execFileSync("git", ["init", "-q", "--bare", repo]);
      const file = path.join(repo, "big");
      fs.writeFileSync(file, Buffer.alloc(bytes, 0x61));
      blob = execFileSync("git", ["hash-object", "-w", file], { cwd: repo }).toString().trim();
      fs.rmSync(file);
    });
    afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

    it("`git` is killed past its buffer, and that is the host's failure", async () => {
      const result = await Effect.runPromise(Effect.flip(git(["cat-file", "blob", blob], repo)));
      expect(result.exitCode).toBeNull();
      expect(result.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      expect(gitRejectsContent(result)).toBe(false);
    });

    it("`gitQuiet` counts what git prints and never buffers it", async () => {
      expect(await Effect.runPromise(gitQuiet(["cat-file", "blob", blob], repo))).toBe(bytes);
    });

    it("`gitQuiet` keeps git's exit, words and signal when it fails", async () => {
      const missing = await Effect.runPromise(
        Effect.flip(gitQuiet(["rev-list", "--objects", "--missing=error", "0".repeat(40)], repo)),
      );
      expect(missing.exitCode).toBe(128);
      expect(missing.stderr).toMatch(/bad object/);
      expect(gitRejectsContent(missing)).toBe(true);
    });
  });
});
