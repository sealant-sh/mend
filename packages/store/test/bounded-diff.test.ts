import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Effect } from "effect";
import * as FastCheck from "effect/testing/FastCheck";
import { describe, expect, it } from "vitest";

import { type DiffFileFact, Store, StoreConfig } from "../src/store.ts";

const withRepository = async (
  work: (
    root: string,
    git: (...args: string[]) => string,
    run: <A, E>(effect: Effect.Effect<A, E, Store>) => Promise<A>,
  ) => Promise<void>,
) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mend-bounded-diff-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.test",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.test",
      },
    });
  const run = <A, E>(effect: Effect.Effect<A, E, Store>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(Store.layer), Effect.provide(StoreConfig.layerFor(root))),
    );
  try {
    git("init", "-qb", "main");
    git("config", "core.quotePath", "true");
    await work(root, git, run);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const write = (root: string, file: string, bytes: string | Uint8Array) =>
  fs.writeFileSync(path.join(root, file), bytes);

const commit = (git: (...args: string[]) => string) => {
  git("add", "--all");
  git("commit", "-qm", "fixture");
};

const modified = (name: string): DiffFileFact => ({
  oldPath: name,
  newPath: name,
  status: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
});

describe("bounded review over real Git", () => {
  it(
    "preserves generated literal names and refuses their incomplete UTF-8 records",
    { timeout: 30_000 },
    async () => {
      const filename = FastCheck.array(
        FastCheck.constantFrom(
          "a",
          "界",
          "ñ",
          "🚀",
          "*",
          "?",
          "[",
          "]",
          " ",
          "\t",
          "\n",
          '"',
          "\\",
        ),
        { minLength: 1, maxLength: 12 },
      ).map((parts) => `generated-${parts.join("")}.txt`);
      await FastCheck.assert(
        FastCheck.asyncProperty(filename, async (name) =>
          withRepository(async (root, git, run) => {
            write(root, name, "before\n");
            write(root, "sibling.txt", "before\n");
            commit(git);
            write(root, name, "after\n");
            write(root, "sibling.txt", "after\n");
            commit(git);
            const completeBytes = Math.max(
              Buffer.byteLength(`M\0${name}\0`),
              Buffer.byteLength(`1\t1\t${name}\0`),
            );
            const actual = await run(
              Effect.gen(function* () {
                const store = yield* Store;
                return {
                  incomplete: yield* store.diffFileFactsBounded(root, "HEAD~1", "HEAD", {
                    paths: [name],
                    maxBytes: completeBytes - 1,
                  }),
                  complete: yield* store.diffFileFactsBounded(root, "HEAD~1", "HEAD", {
                    paths: [name],
                    maxBytes: completeBytes,
                  }),
                };
              }),
            );
            expect(actual).toEqual({
              incomplete: { facts: [], cut: true },
              complete: { facts: [modified(name)], cut: false },
            });
          }),
        ),
        { numRuns: 30, seed: 860012 },
      );
    },
  );

  it(
    "returns only complete matching records when either NUL listing is cut",
    { timeout: 30_000 },
    async () =>
      withRepository(async (root, git, run) => {
        write(root, "a.txt", "before\n");
        write(root, "b-old.txt", "rename content\n");
        write(root, "e-delete.txt", "gone\n");
        commit(git);
        write(root, "a.txt", "after\n");
        fs.renameSync(path.join(root, "b-old.txt"), path.join(root, "b-new.txt"));
        write(root, "c-界.txt", "new one\nnew two\n");
        write(root, "d-binary.dat", new Uint8Array([0, 1, 2]));
        fs.rmSync(path.join(root, "e-delete.txt"));
        commit(git);

        // Literal protocol records and facts follow the fixture's edits, not a parser under test.
        const records = [
          { names: "M\0a.txt\0", counts: "1\t1\ta.txt\0", fact: modified("a.txt") },
          {
            names: "R100\0b-old.txt\0b-new.txt\0",
            counts: "0\t0\t\0b-old.txt\0b-new.txt\0",
            fact: {
              oldPath: "b-old.txt",
              newPath: "b-new.txt",
              status: "renamed",
              additions: 0,
              deletions: 0,
              binary: false,
            },
          },
          {
            names: "A\0c-界.txt\0",
            counts: "2\t0\tc-界.txt\0",
            fact: {
              oldPath: null,
              newPath: "c-界.txt",
              status: "added",
              additions: 2,
              deletions: 0,
              binary: false,
            },
          },
          {
            names: "A\0d-binary.dat\0",
            counts: "-\t-\td-binary.dat\0",
            fact: {
              oldPath: null,
              newPath: "d-binary.dat",
              status: "added",
              additions: 0,
              deletions: 0,
              binary: true,
            },
          },
          {
            names: "D\0e-delete.txt\0",
            counts: "0\t1\te-delete.txt\0",
            fact: {
              oldPath: "e-delete.txt",
              newPath: null,
              status: "deleted",
              additions: 0,
              deletions: 1,
              binary: false,
            },
          },
        ] satisfies ReadonlyArray<{ names: string; counts: string; fact: DiffFileFact }>;
        const names = records.map((record) => record.names).join("");
        const counts = records.map((record) => record.counts).join("");
        expect(git("diff", "--name-status", "-z", "--find-renames", "HEAD~1", "HEAD")).toBe(names);
        expect(git("diff", "--numstat", "-z", "--find-renames", "HEAD~1", "HEAD")).toBe(counts);
        let namesBytes = 0,
          countsBytes = 0;
        const completeAt = records.map((record) => {
          namesBytes += Buffer.byteLength(record.names);
          countsBytes += Buffer.byteLength(record.counts);
          return Math.max(namesBytes, countsBytes);
        });
        // Every byte position includes cuts inside status, count, rename source/destination and UTF-8.
        for (let maxBytes = 0; maxBytes <= Math.max(namesBytes, countsBytes) + 1; maxBytes++) {
          const actual = await run(
            Effect.flatMap(Store, (store) =>
              store.diffFileFactsBounded(root, "HEAD~1", "HEAD", { maxBytes }),
            ),
          );
          expect(actual, `byte budget ${maxBytes}`).toEqual({
            facts: records
              .filter((_, index) => (completeAt[index] ?? Infinity) <= maxBytes)
              .map(({ fact }) => fact),
            cut: maxBytes < Math.max(namesBytes, countsBytes),
          });
        }
        expect(
          await run(
            Effect.flatMap(Store, (store) =>
              store.diffFileFactsBounded(root, "HEAD", "HEAD", { maxBytes: 0 }),
            ),
          ),
        ).toEqual({ facts: [], cut: false });
      }),
  );

  it("keeps metacharacter paths literal, excludes matching siblings and pairs whitespace options", async () =>
    withRepository(async (root, git, run) => {
      const pairs = [
        ["star*.txt", "star-other.txt"],
        ["bracket[1].txt", "bracket1.txt"],
        ["question?.txt", "questionX.txt"],
        [":(glob)*.txt", "ordinary.txt"],
        ["naïve界.txt", "naïve-other.txt"],
      ];
      const names = pairs.flat();
      for (const name of names) write(root, name, "before\n");
      write(root, "whitespace.txt", "one two\n");
      commit(git);
      for (const name of names) write(root, name, "after\n");
      write(root, "whitespace.txt", "one  two\n");
      commit(git);
      for (const pair of pairs) {
        const [selected, sibling] = pair;
        if (selected === undefined || sibling === undefined)
          throw new Error("Missing fixture path");
        const actual = await run(
          Effect.gen(function* () {
            const store = yield* Store;
            return {
              patch: yield* store.diffRange(root, "HEAD~1", "HEAD", {
                paths: [selected],
                maxBytes: 4096,
              }),
              listing: yield* store.diffFileFactsBounded(root, "HEAD~1", "HEAD", {
                paths: [selected],
                maxBytes: 4096,
              }),
            };
          }),
        );
        const expected = git(
          "--literal-pathspecs",
          "diff",
          "--find-renames",
          "HEAD~1",
          "HEAD",
          "--",
          selected,
        ).replace(/\n$/, "");
        expect(actual.patch).toBe(expected);
        expect(actual.patch).toContain("+after");
        expect(actual.patch).not.toContain(sibling);
        expect(actual.listing).toEqual({ facts: [modified(selected)], cut: false });
      }
      for (const ignoreWhitespace of [false, true]) {
        const actual = await run(
          Effect.gen(function* () {
            const store = yield* Store;
            const options = { paths: ["whitespace.txt"], maxBytes: 4096, ignoreWhitespace };
            return {
              patch: yield* store.diffRange(root, "HEAD~1", "HEAD", options),
              listing: yield* store.diffFileFactsBounded(root, "HEAD~1", "HEAD", options),
            };
          }),
        );
        expect(actual.listing).toEqual({
          facts: ignoreWhitespace ? [] : [modified("whitespace.txt")],
          cut: false,
        });
        if (ignoreWhitespace) expect(actual.patch).toBe("");
        else expect(actual.patch).toContain("+one  two");
      }
    }));

  it("drops a partly rendered file while retaining complete earlier patches and matching facts", async () =>
    withRepository(async (root, git, run) => {
      write(root, "a.txt", "first before\n");
      write(root, "b-界.txt", "second before\n");
      commit(git);
      write(root, "a.txt", "first after\n");
      write(root, "b-界.txt", "second after\n" + "large tail\n".repeat(100));
      commit(git);
      const first = git("diff", "--find-renames", "HEAD~1", "HEAD", "--", "a.txt");
      const second = git("diff", "--find-renames", "HEAD~1", "HEAD", "--", "b-界.txt");
      const full = first + second;
      expect(git("diff", "--find-renames", "HEAD~1", "HEAD")).toBe(full);
      const maxBytes =
        Buffer.byteLength(first) + Buffer.byteLength(second.slice(0, second.indexOf("@@") + 20));
      const actual = await run(
        Effect.gen(function* () {
          const store = yield* Store;
          return {
            partialFirst: yield* store.diffRange(root, "HEAD~1", "HEAD", { maxBytes: 10 }),
            bounded: yield* store.diffRange(root, "HEAD~1", "HEAD", { maxBytes }),
            full: yield* store.diffRange(root, "HEAD~1", "HEAD", {
              maxBytes: Buffer.byteLength(full),
            }),
            retained: yield* store.diffFileFactsBounded(root, "HEAD~1", "HEAD", {
              paths: ["a.txt"],
              maxBytes: 4096,
            }),
          };
        }),
      );
      expect(actual.partialFirst).toBe("");
      expect(actual.bounded).toBe(first.replace(/\n$/, ""));
      expect(actual.bounded).not.toContain("second after");
      expect(actual.full).toBe(full.replace(/\n$/, ""));
      expect(actual.retained).toEqual({ facts: [modified("a.txt")], cut: false });
      // The retained complete patch is independently applicable to the original tree.
      git("checkout", "--detach", "-q", "HEAD~1");
      execFileSync("git", ["apply", "-"], { cwd: root, input: actual.bounded + "\n" });
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("first after\n");
      expect(fs.readFileSync(path.join(root, "b-界.txt"), "utf8")).toBe("second before\n");
    }));
});
