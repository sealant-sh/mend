import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isWorktreeRelativePath, parseGrep, Store, StoreConfig } from "../src/index.ts";

/**
 * Reading a worktree's files and searching its lines (ADR 0012, phase 3): a commit's tree through
 * `cat-file`, the worktree as it stands from disk without ever leaving it, and `git grep` with
 * untracked files in and ignored ones out.
 */

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
    cwd,
    stdio: "pipe",
  }).toString();

let tmp = "";
let repo = "";
let head = "";
let store: Store["Service"];
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.orDie(effect));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mend-worktree-contents-"));
  repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.ts"), "export const Hello = 1;\nconst helloWorld = 2;\n");
  fs.writeFileSync(path.join(repo, "image.bin"), Buffer.from([0x89, 0x00, 0x01, 0x02]));
  fs.writeFileSync(path.join(repo, "big.txt"), "x".repeat(100));
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  head = git(repo, "rev-parse", "HEAD").trim();
  // The worktree moves on: an edit, an untracked file, an ignored one, and a symlink out of it.
  fs.writeFileSync(path.join(repo, "app.ts"), "export const Hello = 3;\n");
  fs.writeFileSync(path.join(repo, "notes.md"), "hello from an untracked file\n");
  fs.mkdirSync(path.join(repo, "ignored"));
  fs.writeFileSync(path.join(repo, "ignored", "secret.txt"), "hello, ignored\n");
  fs.writeFileSync(path.join(tmp, "outside.txt"), "hello from outside the worktree\n");
  fs.symlinkSync(path.join(tmp, "outside.txt"), path.join(repo, "escape.txt"));
  store = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* Store;
    }).pipe(
      Effect.provide(
        Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.join(tmp, "store")))),
      ),
    ),
  );
});

afterAll(() => {
  if (tmp !== "") fs.rmSync(tmp, { recursive: true, force: true });
});

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("reading one file", () => {
  it("reads a commit's tree, whole or cut, and says when a file is binary", async () => {
    const atHead = await run(store.readBlob(repo, head, "app.ts", 1024));
    expect(text(atHead?.bytes)).toBe("export const Hello = 1;\nconst helloWorld = 2;\n");
    expect(atHead?.truncated).toBe(false);
    const cut = await run(store.readBlob(repo, head, "big.txt", 10));
    expect(cut).toMatchObject({ size: 100, truncated: true, binary: false });
    expect(cut?.bytes.byteLength).toBe(10);
    expect((await run(store.readBlob(repo, head, "image.bin", 1024)))?.binary).toBe(true);
    expect(await run(store.readBlob(repo, head, "missing.ts", 1024))).toBeNull();
    expect(await run(store.readBlob(repo, head, "notes.md", 1024))).toBeNull();
  });

  it("reads the worktree as it stands, untracked files too, and never outside it", async () => {
    const now = await run(store.readWorktreeFile(repo, "app.ts", 1024));
    expect(text(now?.bytes)).toBe("export const Hello = 3;\n");
    expect(text((await run(store.readWorktreeFile(repo, "notes.md", 1024)))?.bytes)).toContain(
      "untracked",
    );
    for (const refused of ["escape.txt", "../outside.txt", "/etc/hostname", ".git/config", "."]) {
      expect(await run(store.readWorktreeFile(repo, refused, 1024)), refused).toBeNull();
    }
  });

  it("takes only a path inside the worktree", () => {
    expect(isWorktreeRelativePath("src/app.ts")).toBe(true);
    for (const refused of ["", "/abs", "a/../b", "./a", "a//b", ".git/HEAD", "x/.git/config"]) {
      expect(isWorktreeRelativePath(refused), refused).toBe(false);
    }
  });
});

describe("searching lines", () => {
  it("finds lines in the worktree as it stands: untracked in, ignored out", async () => {
    const found = await run(
      store.grep(
        repo,
        null,
        { pattern: "hello", caseSensitive: false, wholeWord: false, regex: false },
        50,
      ),
    );
    const paths = found.matches.map((match) => match.path).toSorted();
    expect(paths).toEqual(["app.ts", "notes.md"]);
    expect(found.matches.find((match) => match.path === "app.ts")).toEqual({
      path: "app.ts",
      line: 1,
      text: "export const Hello = 3;",
    });
  });

  it("matches case, whole words and expressions as asked, in a commit's tree", async () => {
    const query = (
      pattern: string,
      options: { caseSensitive?: boolean; wholeWord?: boolean; regex?: boolean },
    ) =>
      run(
        store.grep(
          repo,
          head,
          {
            pattern,
            caseSensitive: options.caseSensitive ?? false,
            wholeWord: options.wholeWord ?? false,
            regex: options.regex ?? false,
          },
          50,
        ),
      );
    expect((await query("hello", { caseSensitive: true })).matches.map((m) => m.line)).toEqual([2]);
    expect((await query("hello", { wholeWord: true })).matches.map((m) => m.line)).toEqual([1]);
    expect((await query("Hello = [0-9]", { regex: true })).matches).toEqual([
      { path: "app.ts", line: 1, text: "export const Hello = 1;" },
    ]);
  });

  it("keeps at most the limit, and says so", () => {
    const out = ["a.ts\u00001\u0000one", "a.ts\u00002\u0000two", "b.ts\u00001\u0000three"].join(
      "\n",
    );
    expect(parseGrep(out, null, 2)).toEqual({
      matches: [
        { path: "a.ts", line: 1, text: "one" },
        { path: "a.ts", line: 2, text: "two" },
      ],
      truncated: true,
    });
    expect(parseGrep("abc:a.ts\u00001\u0000one", "abc", 5).matches[0]?.path).toBe("a.ts");
  });
});
