import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import * as FastCheck from "fast-check";
import { describe, expect, it } from "vitest";

import { Store, StoreConfig } from "../src/store.ts";

const withStore = async (
  work: (
    root: string,
    git: (...args: string[]) => string,
    run: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>,
  ) => Promise<void>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-changed-paths-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  const run = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(Store.layer), Effect.provide(StoreConfig.layerFor(root))),
    );
  try {
    git("init", "-q");
    git("config", "core.quotePath", "true");
    git("config", "core.fileMode", "true");
    await work(root, git, run);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};
const write = (root: string, file: string, bytes: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), bytes);
};
const commit = (git: (...args: string[]) => string) => {
  git("add", "--all");
  git(
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  );
};
const sorted = <A extends { readonly path: string }>(rows: ReadonlyArray<A>) =>
  rows.toSorted((a, b) => a.path.localeCompare(b.path));
const filenames = [
  "plain.txt",
  "naïve.txt",
  'quote"file.txt',
  "slash\\file.txt",
  "line\nfile.txt",
  "tab\tfile.txt",
];

describe("changedFiles path identity through real Git", () => {
  // This property creates thirty real Git repositories; it is not a latency assertion.
  it(
    "preserves generated actual names and counts in Git's NUL-delimited protocol",
    { timeout: 30_000 },
    async () => {
      const filename = FastCheck.array(
        FastCheck.constantFrom("a", "Z", " ", "ñ", "界", "🚀", "\t", "\n", '"', "\\"),
        { minLength: 1, maxLength: 14 },
      ).map((parts) => `generated-${parts.join("")}.txt`);
      await FastCheck.assert(
        FastCheck.asyncProperty(filename, async (name) =>
          withStore(async (root, git, run) => {
            write(root, name, "before\n");
            commit(git);
            write(root, name, "after\n");
            expect(
              await run(Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD", null))),
            ).toEqual([{ path: name, additions: 1, deletions: 1 }]);
          }),
        ),
        { numRuns: 30, seed: 858822 },
      );
    },
  );

  for (const quotePath of [true, false])
    it(`returns actual tracked filenames with core.quotePath=${quotePath}`, async () =>
      withStore(async (root, git, run) => {
        git("config", "core.quotePath", String(quotePath));
        for (const name of filenames) write(root, name, "before\n");
        commit(git);
        for (const name of filenames) write(root, name, "after\n");
        const actual = await run(
          Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD", null)),
        );
        expect(sorted(actual)).toEqual(
          sorted(filenames.map((name) => ({ path: name, additions: 1, deletions: 1 }))),
        );
      }));
  for (const edited of [true, false])
    it(`returns the real renamed destination with edited=${edited} in an immutable range`, async () =>
      withStore(async (root, git, run) => {
        const oldName = "old-ñ.txt",
          newName = 'new b/quote".txt';
        const content = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
        write(root, oldName, content);
        commit(git);
        fs.mkdirSync(path.dirname(path.join(root, newName)), { recursive: true });
        fs.renameSync(path.join(root, oldName), path.join(root, newName));
        if (edited) write(root, newName, content + "added\n");
        commit(git);
        const actual = await run(
          Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD~1", "HEAD")),
        );
        expect(actual).toEqual([{ path: newName, additions: edited ? 1 : 0, deletions: 0 }]);
        expect(git("diff", "--numstat", "-z", "HEAD~1", "HEAD")).toContain(
          `\t\0${oldName}\0${newName}\0`,
        );
      }));
  it("reads native copy destination and counts when Git copy detection is enabled", async () =>
    withStore(async (root, git, run) => {
      const oldName = "old-ñ.txt",
        newName = 'copied b/name".txt';
      const content = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
      write(root, oldName, content);
      commit(git);
      git("config", "diff.renames", "copies");
      write(root, oldName, content + "added\n");
      write(root, newName, content);
      commit(git);
      expect(git("diff", "--numstat", "-z", "HEAD~1", "HEAD")).toContain(
        `0\t0\t\0${oldName}\0${newName}\0`,
      );
      expect(
        sorted(
          await run(Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD~1", "HEAD"))),
        ),
      ).toEqual(
        sorted([
          { path: oldName, additions: 1, deletions: 0 },
          { path: newName, additions: 0, deletions: 0 },
        ]),
      );
    }));
  it("preserves empty, deleted, binary and mode-only counts and exact paths", async () =>
    withStore(async (root, git, run) => {
      write(root, "naïve.txt", "before\n");
      write(root, "binary-界.dat", new Uint8Array([0, 1, 2]));
      write(root, "mode b/file.sh", "before\n");
      commit(git);
      expect(
        await run(Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD", "HEAD"))),
      ).toEqual([]);
      fs.rmSync(path.join(root, "naïve.txt"));
      write(root, "binary-界.dat", new Uint8Array([0, 3, 4]));
      fs.chmodSync(path.join(root, "mode b/file.sh"), 0o755);
      expect(
        sorted(await run(Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD", null)))),
      ).toEqual(
        sorted([
          { path: "naïve.txt", additions: 0, deletions: 1 },
          { path: "binary-界.dat", additions: 0, deletions: 0 },
          { path: "mode b/file.sh", additions: 0, deletions: 0 },
        ]),
      );
    }));
  it("reads real untracked odd filenames for both counts and actual diff content", async () =>
    withStore(async (root, git, run) => {
      write(root, "keep.txt", "keep\n");
      commit(git);
      const name = "naïve\tline\n.txt";
      write(root, name, "untracked-odd-one\nuntracked-odd-two\n");
      write(root, "plain-new.txt", "plain-positive\n");
      const observed = await run(
        Effect.gen(function* () {
          const store = yield* Store;
          return {
            files: yield* store.changedFiles(root, "HEAD", null),
            patch: yield* store.diffWorktree(root, "HEAD"),
          };
        }),
      );
      expect(observed.patch).toContain("+plain-positive");
      expect(observed).toMatchObject({
        files: [
          { path: name, additions: 2, deletions: 0 },
          { path: "plain-new.txt", additions: 1, deletions: 0 },
        ],
        patch: expect.stringContaining("+untracked-odd-one"),
      });
      expect(observed.patch).toContain("+untracked-odd-two");
    }));
  // This boundary case launches 200 real Git processes; its deadline is not a latency assertion.
  it(
    "keeps exact untracked names, two-line counts and the 200-file render limit",
    { timeout: 30_000 },
    async () =>
      withStore(async (root, git, run) => {
        write(root, "keep.txt", "keep\n");
        commit(git);
        const names = Array.from(
          { length: 205 },
          (_, i) => `${String(i).padStart(3, "0")}-naïve\tline\n.txt`,
        );
        for (const name of names) write(root, name, "one\ntwo\n");
        const rows = await run(
          Effect.flatMap(Store, (store) => store.changedFiles(root, "HEAD", null)),
        );
        expect(rows.slice(0, 200)).toEqual(
          names.slice(0, 200).map((name) => ({ path: name, additions: 2, deletions: 0 })),
        );
        expect(rows.slice(200)).toEqual([
          { path: "… 5 more untracked files (not rendered)", additions: 0, deletions: 0 },
        ]);
      }),
  );
});
