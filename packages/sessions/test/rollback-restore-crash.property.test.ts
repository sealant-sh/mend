import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import * as FastCheck from "fast-check";
import { afterEach, describe, expect, it } from "vitest";

import { rollbackFilesExec } from "../src/rollback-files.ts";

/**
 * Undo's file restore (`rollbackFilesExec`'s `restore`) after a crash at every step. Over generated
 * trees, the real helper saves the current files, then restores the target tree in a process that
 * is killed just before its k-th write, for every k it makes. The rule, worked out from the trees
 * the generator made and never from a run of the helper:
 *
 * - After the crash, every path holds what it held before the Undo or what the target holds, or is
 *   absent while the restore moves it: never bytes of neither, and the Git index is the old one or
 *   the new one.
 * - A second Undo (the same operation, its next generation, as the engine continues it) finishes
 *   the job: the files are exactly the target's, and the index is HEAD's.
 *
 * The crash is a `--require` hook (`CRASH_HOOK`) that SIGKILLs the helper before its k-th call that
 * writes: no `finally` runs, as in a lost workspace process.
 *
 * Today the rule breaks in the ways `KNOWN` names (SLNT-1025, SLNT-1026). A crash outcome passes
 * only when it keeps the rule or matches one of those exactly; any other outcome fails.
 */

const exec = promisify(execFile);
/** SLNT-1025: what every continuation answers after a crash while the helper wrote its lock owner. */
const STUCK = "The previous execution lock contains unknown evidence";
const SEED = 1017;
const RUNS = 4;
const PARALLEL = 4;
/**
 * Where the cases live when the host has it. The helper fsyncs every write, and a SIGKILL never
 * needs one (the page cache outlives the killed process), so a disk adds only its latency: on a CI
 * runner sharing its disk with other suites, that more than doubled the file's time (SLNT-1029).
 */
const TMPFS = "/dev/shm";

const GIT_ENV = {
  PATH: process.env["PATH"],
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fake",
  GIT_AUTHOR_EMAIL: "fake@example.invalid",
  GIT_COMMITTER_NAME: "Fake",
  GIT_COMMITTER_EMAIL: "fake@example.invalid",
};

/** Kills the helper before its CRASH_AT-th write; with CRASH_COUNT, writes how many it made. */
const CRASH_HOOK = String.raw`
const fs = require("node:fs"), cp = require("node:child_process");
const at = Number(process.env.CRASH_AT || 0), countFile = process.env.CRASH_COUNT;
let writes = 0;
const step = () => { writes += 1; if (writes === at) process.kill(process.pid, "SIGKILL"); };
const writing = flags => typeof flags === "string" ? /[wax+]/.test(flags) : typeof flags === "number" && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0;
for (const name of ["writeFileSync", "writeSync", "renameSync", "unlinkSync", "rmdirSync", "rmSync", "mkdirSync", "linkSync", "symlinkSync", "fchmodSync", "fchownSync", "lchownSync", "chmodSync", "chownSync"]) {
  const original = fs[name];
  fs[name] = function (...args) { step(); return original.apply(this, args); };
}
const open = fs.openSync;
fs.openSync = function (file, flags, ...rest) { if (writing(flags)) step(); return open.call(this, file, flags, ...rest); };
const run = cp.execFileSync;
cp.execFileSync = function (file, args, ...rest) { if (file === "git" && Array.isArray(args) && args.includes("read-tree")) step(); return run.call(this, file, args, ...rest); };
if (countFile) process.on("exit", () => fs.writeFileSync.call(fs, countFile, String(writes)));
`;

/** A tree as a person sees it: each path a file (with its executable bit) or a symlink. */
type Node =
  | { readonly kind: "file"; readonly bytes: string; readonly executable: boolean }
  | { readonly kind: "link"; readonly target: string };
type Tree = ReadonlyMap<string, Node>;

const PATHS = ["x", "y", "a/x", "a/y", "a/b/x", "c/x", "a", "c"] as const;

/** No path is both a file and the directory of another in one tree. */
const consistent = (tree: Tree) =>
  [...tree.keys()].every((p) => [...tree.keys()].every((q) => !q.startsWith(`${p}/`)));

const node = FastCheck.oneof(
  {
    weight: 4,
    arbitrary: FastCheck.record({
      kind: FastCheck.constant("file" as const),
      bytes: FastCheck.constantFrom("one\n", "two\n", "three\n", ""),
      executable: FastCheck.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: FastCheck.record({
      kind: FastCheck.constant("link" as const),
      target: FastCheck.constantFrom("x", "../x", "missing"),
    }),
  },
);

const tree = FastCheck.dictionary(FastCheck.constantFrom(...PATHS), node, {
  minKeys: 1,
  maxKeys: 5,
})
  .map((entries): Tree => new Map(Object.entries(entries)))
  .filter(consistent);

/** The target, and the current tree as an agent left it. */
const scenario = FastCheck.record({ target: tree, current: tree });

/**
 * How the agent left the index, cycled by case rather than drawn, so the few cases always include a
 * staged index the restore must put back to HEAD's (no shrinking, so the cycle stays put).
 */
const STAGING = ["staged", "committed", "untouched"] as const;

const roots: Array<string> = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const writeTree = async (repo: string, files: Tree) => {
  for (const name of await fs.readdir(repo))
    if (name !== ".git") await fs.rm(path.join(repo, name), { recursive: true });
  for (const [p, entry] of files) {
    const full = path.join(repo, p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    if (entry.kind === "link") await fs.symlink(entry.target, full);
    else {
      await fs.writeFile(full, entry.bytes);
      await fs.chmod(full, entry.executable ? 0o755 : 0o644);
    }
  }
};

/** What is in the worktree now, outside `.git`: files, symlinks and directories. */
const observe = async (repo: string) => {
  const seen = new Map<string, string>();
  const walk = async (dir: string) => {
    for (const name of (await fs.readdir(path.join(repo, dir))).toSorted()) {
      const p = dir === "" ? name : `${dir}/${name}`;
      if (p === ".git") continue;
      const stat = await fs.lstat(path.join(repo, p));
      if (stat.isSymbolicLink()) seen.set(p, `link ${await fs.readlink(path.join(repo, p))}`);
      else if (stat.isDirectory()) {
        seen.set(p, "directory");
        await walk(p);
      } else
        seen.set(
          p,
          `file ${(stat.mode & 0o111) !== 0 ? "x" : "-"} ${await fs.readFile(path.join(repo, p), "utf8")}`,
        );
    }
  };
  await walk("");
  return seen;
};

/** A tree as `observe` reads it, directories included. */
const expected = (files: Tree) => {
  const seen = new Map<string, string>();
  for (const [p, entry] of files) {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i += 1) seen.set(parts.slice(0, i).join("/"), "directory");
    seen.set(
      p,
      entry.kind === "link"
        ? `link ${entry.target}`
        : `file ${entry.executable ? "x" : "-"} ${entry.bytes}`,
    );
  }
  return new Map([...seen].toSorted(([a], [b]) => a.localeCompare(b)));
};

const sorted = (map: ReadonlyMap<string, string>) =>
  new Map([...map].toSorted(([a], [b]) => a.localeCompare(b)));

/** A repository at the current tree, its target commit, and the save already taken. */
const prepare = async (
  root: string,
  target: Tree,
  current: Tree,
  index: "untouched" | "staged" | "committed",
) => {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  const git = (...args: Array<string>) => exec("git", args, { cwd: repo, env: GIT_ENV });
  await git("init", "-q");
  await writeTree(repo, target);
  await git("add", "-A");
  await git("commit", "-qm", "target", "--allow-empty");
  const targetSha = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeTree(repo, current);
  if (index !== "untouched") await git("add", "-A");
  if (index === "committed") await git("commit", "-qm", "agent", "--allow-empty");
  const native = path.join(root, "native", ".codex", "sessions");
  await fs.mkdir(native, { recursive: true });
  await fs.writeFile(path.join(native, "conversation.jsonl"), "native\n");
  await helper(root, targetSha, "save", 1);
  return targetSha;
};

const helper = async (
  root: string,
  target: string,
  action: "save" | "restore",
  generation: number,
  crash: { readonly at?: number; readonly countFile?: string } = {},
) => {
  const [program, ...args] = rollbackFilesExec({
    action,
    operationId: "operation",
    generation,
    previousExecutionExited: generation > 1,
    repository: path.join(root, "repo"),
    journalRoot: path.join(root, "history"),
    nativeRoot: path.join(root, "native"),
    nativePaths: [".codex/sessions"],
    target,
  });
  if (program === undefined) throw new Error("Missing helper command");
  const hook = path.join(root, "..", `crash-hook.cjs`);
  return exec(program, ["--require", hook, ...args], {
    env: {
      ...GIT_ENV,
      HOME: root,
      ...(crash.at === undefined ? {} : { CRASH_AT: String(crash.at) }),
      ...(crash.countFile === undefined ? {} : { CRASH_COUNT: crash.countFile }),
    },
    maxBuffer: 16 * 1024 * 1024,
  }).then(
    () => "exited" as const,
    (error: unknown) => {
      if (error instanceof Error && "signal" in error && error.signal === "SIGKILL")
        return "killed" as const;
      throw error;
    },
  );
};

/** What the helper printed to stderr, from a failed exec. */
const stderrOf = (error: unknown) =>
  typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr) : "";

/** Whether the index stages exactly HEAD's tree: what a restore promises to leave. */
const indexIsHead = async (root: string) => {
  const run = (...args: Array<string>) =>
    exec("git", args, { cwd: path.join(root, "repo"), env: GIT_ENV }).then((out) => out.stdout);
  const staged = (await run("ls-files", "-s"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/ 0\t/, " "));
  const head = (await run("ls-tree", "-r", "HEAD"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/ blob /, " ").replace("\t", " "));
  return JSON.stringify(staged) === JSON.stringify(head);
};

const indexBytes = (root: string) => fs.readFile(path.join(root, "repo", ".git", "index"));

/**
 * The known ways a crash breaks the rule, each with its ticket. A crash outcome counts as one only
 * when it matches that ticket's shape exactly; anything else fails the test. Each must still be
 * observed (the seed is fixed): when one is fixed, its count drops to 0 and the test says to remove
 * its tolerance.
 */
const KNOWN = {
  /** `install` creates the file, then writes it: a crash between leaves a prefix of the new bytes. */
  "SLNT-1026 torn file in the worktree": 0,
  /** The same tear in the journal's copy of an original. */
  "SLNT-1026 torn copy of an original": 0,
  /** A crash while the helper wrote its lock owner leaves `owner.json.next-*` behind. */
  "SLNT-1025 lock owner temp file": 0,
};
type Known = keyof typeof KNOWN;

/** `file x bytes` as its bytes, or null for a link or a directory. */
const fileBytes = (seen: string | undefined) =>
  seen?.startsWith("file ") === true ? seen.slice("file x ".length) : null;

/** A crash outcome the tickets above name, or a message saying what broke the rule. */
const classify = async (input: {
  readonly root: string;
  readonly at: number;
  readonly before: ReadonlyMap<string, string>;
  readonly restored: ReadonlyMap<string, string>;
  readonly live: ReadonlyMap<string, string>;
  readonly stderr: string | null;
}): Promise<{ readonly known: ReadonlyArray<Known> } | { readonly broken: string }> => {
  const { root, at, before, restored, live, stderr } = input;
  const known: Array<Known> = [];
  const torn: Array<string> = [];
  for (const p of new Set([...before.keys(), ...restored.keys(), ...live.keys()])) {
    const now = live.get(p);
    if (
      now === undefined ||
      now === "directory" ||
      now === before.get(p) ||
      now === restored.get(p)
    )
      continue;
    const bytes = fileBytes(now);
    const wanted = fileBytes(restored.get(p));
    if (bytes === null || wanted === null || !wanted.startsWith(bytes))
      return {
        broken: `after a crash before write ${at}, ${p} holds neither its old nor its new content (${now})`,
      };
    torn.push(p);
  }
  if (torn.length > 0) known.push("SLNT-1026 torn file in the worktree");
  if (stderr === null) return { known };
  const operation = path.join(root, "history", "operation");
  const appeared = /A new path appeared during restore: (\S+)/.exec(stderr)?.[1];
  if (appeared !== undefined && torn.includes(appeared)) return { known };
  if (stderr.includes("Moved original differs from saved bytes")) {
    const originals = path.join(operation, "restore-originals");
    for (const name of await fs.readdir(originals)) {
      const original = Buffer.from(name, "hex").toString("utf8");
      const stat = await fs.lstat(path.join(originals, name));
      const old = fileBytes(before.get(original));
      if (stat.isFile() && old?.startsWith(await fs.readFile(path.join(originals, name), "utf8")))
        return { known: [...known, "SLNT-1026 torn copy of an original"] };
    }
  }
  if (stderr.includes(STUCK)) {
    const left = await fs.readdir(path.join(operation, "worker.lock"));
    if (left.length > 0 && left.every((name) => name.startsWith("owner.json.next-")))
      return { known: [...known, "SLNT-1025 lock owner temp file"] };
  }
  return { broken: `a second Undo after a crash before write ${at} refused: ${stderr.trim()}` };
};

describe("Undo's file restore under a crash at every step", () => {
  it("leaves each path as before or as restored, and a second Undo finishes it", async () => {
    const scratch = await fs.access(TMPFS, fs.constants.W_OK).then(
      () => TMPFS,
      () => os.tmpdir(),
    );
    const base = await fs.mkdtemp(path.join(scratch, "mend-restore-crash."));
    roots.push(base);
    await fs.writeFile(path.join(base, "crash-hook.cjs"), CRASH_HOOK);
    const seen: Record<Known, number> = { ...KNOWN };
    let cases = 0;
    let crashes = 0;
    await FastCheck.assert(
      FastCheck.asyncProperty(scenario, async ({ target, current }) => {
        const staging = STAGING[cases % STAGING.length] ?? "staged";
        cases += 1;
        const pristine = path.join(base, `case-${cases}`);
        await fs.mkdir(pristine);
        const targetSha = await prepare(pristine, target, current, staging);
        const before = sorted(await observe(path.join(pristine, "repo")));
        const restored = expected(target);
        const oldIndex = await indexBytes(pristine);

        // One whole restore, to learn how many writes it makes and the index it installs.
        const counted = `${pristine}-counted`;
        await fs.cp(pristine, counted, { recursive: true, verbatimSymlinks: true });
        const countFile = path.join(base, `count-${cases}`);
        expect(await helper(counted, targetSha, "restore", 1, { countFile })).toBe("exited");
        expect(sorted(await observe(path.join(counted, "repo")))).toEqual(restored);
        expect(await indexIsHead(counted), "a whole restore left the index other than HEAD's").toBe(
          true,
        );
        const newIndex = await indexBytes(counted);
        const writes = Number(await fs.readFile(countFile, "utf8"));
        await fs.rm(counted, { recursive: true });

        const crashAt = async (at: number) => {
          const root = `${pristine}-crash-${at}`;
          await fs.cp(pristine, root, { recursive: true, verbatimSymlinks: true });
          expect(await helper(root, targetSha, "restore", 1, { at })).toBe("killed");
          crashes += 1;
          const live = await observe(path.join(root, "repo"));
          const index = await indexBytes(root);
          expect(
            index.equals(oldIndex) || index.equals(newIndex),
            `after a crash before write ${at}, the index is neither the old one nor the new one`,
          ).toBe(true);

          const stderr = await helper(root, targetSha, "restore", 2).then(
            () => null,
            (error: unknown) => {
              const printed = stderrOf(error);
              if (printed === "") throw error;
              return printed;
            },
          );
          const outcome = await classify({ root, at, before, restored, live, stderr });
          if ("broken" in outcome) throw new Error(outcome.broken);
          for (const kind of outcome.known) seen[kind] += 1;
          if (stderr === null) {
            expect(
              sorted(await observe(path.join(root, "repo"))),
              `a second Undo after a crash before write ${at} left the files short of the target`,
            ).toEqual(restored);
            expect(
              await indexIsHead(root),
              `a second Undo after a crash before write ${at} left the index other than HEAD's`,
            ).toBe(true);
          }
          await fs.rm(root, { recursive: true });
        };
        // Each crash runs on its own copy; PARALLEL at a time keeps the helper processes few.
        for (let first = 1; first <= writes; first += PARALLEL)
          await Promise.all(
            Array.from({ length: Math.min(PARALLEL, writes - first + 1) }, (_, i) =>
              crashAt(first + i),
            ),
          );
        await fs.rm(pristine, { recursive: true });
      }),
      { seed: SEED, numRuns: RUNS, endOnFailure: true },
    );
    expect(crashes).toBeGreaterThan(RUNS * 10);
    for (const [kind, count] of Object.entries(seen))
      expect(count, `${kind} no longer happens: remove it from KNOWN`).toBeGreaterThan(0);
  }, 600_000);
});
