import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { Store, StoreConfig } from "./store.ts";

const tempDirs: Array<string> = [];

const makeTempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();

const makeBareRepo = (
  populate: (work: string) => void,
): { readonly bare: string; readonly head: string } => {
  const root = makeTempDir("mend-subtree-blobs-");
  const work = path.join(root, "work");
  const bare = path.join(root, "bare.git");
  fs.mkdirSync(work);
  runGit(work, ["init", "-q", "-b", "main"]);
  populate(work);
  runGit(work, ["add", "-A"]);
  runGit(work, ["commit", "-q", "-m", "init"]);
  runGit(root, ["clone", "--bare", "-q", work, bare]);
  const head = runGit(bare, ["rev-parse", "HEAD"]);
  return { bare, head };
};

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Store.listSubtreeBlobs", () => {
  it("lists regular blobs under the prefix with exact sizes and skips symlinks", async () => {
    const { bare, head } = makeBareRepo((work) => {
      fs.writeFileSync(path.join(work, "README.md"), "root\n");
      const skill = path.join(work, ".agents/skills/linear");
      fs.mkdirSync(path.join(skill, "references"), { recursive: true });
      fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: linear\n---\nBody\n");
      fs.writeFileSync(path.join(skill, "references/notes.md"), "hello");
      fs.symlinkSync("/etc/passwd", path.join(skill, "escape.md"));
    });

    const entries = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.listSubtreeBlobs(bare, head, ".agents/skills", 100);
      }).pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.dirname(bare))))),
      ),
    );

    expect(entries).toEqual([
      { path: ".agents/skills/linear/SKILL.md", size: 26 },
      { path: ".agents/skills/linear/references/notes.md", size: 5 },
    ]);
  });

  it("returns an empty list when the prefix is absent and enforces the limit", async () => {
    const { bare, head } = makeBareRepo((work) => {
      fs.writeFileSync(path.join(work, "README.md"), "root\n");
      const a = path.join(work, ".agents/skills/a");
      const b = path.join(work, ".agents/skills/b");
      fs.mkdirSync(a, { recursive: true });
      fs.mkdirSync(b, { recursive: true });
      fs.writeFileSync(path.join(a, "SKILL.md"), "a");
      fs.writeFileSync(path.join(b, "SKILL.md"), "b");
    });

    const layer = Store.layer.pipe(Layer.provide(StoreConfig.layerFor(path.dirname(bare))));
    const [absent, capped] = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Store;
        const none = yield* store.listSubtreeBlobs(bare, head, ".agents/missing", 100);
        const one = yield* store.listSubtreeBlobs(bare, head, ".agents/skills", 1);
        return [none, one] as const;
      }).pipe(Effect.provide(layer)),
    );

    expect(absent).toEqual([]);
    expect(capped).toEqual([{ path: ".agents/skills/a/SKILL.md", size: 1 }]);
  });
});
