import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { git, GitError, gitQuiet, gitRejectsContent } from "../src/git.ts";

/**
 * Review 2026-09-28 (13) #1: a git run the Mend host could not finish says nothing about the
 * content it read. Only git's own words rejecting a pack or naming a missing object do.
 */
/** A failed git run, as `git` reports one. */
const error = (fields: Partial<ConstructorParameters<typeof GitError>[0]>) =>
  new GitError({ args: ["index-pack"], cwd: "/", exitCode: 128, stderr: "", ...fields });

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
