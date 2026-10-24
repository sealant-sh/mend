// Copy t3code's contracts into this package, byte for byte, from one tag.
//
//   node scripts/sync.ts --tag v0.1.2 [--source /path/to/t3code]
//
// Without --source it fetches the tag from GitHub into a temporary repository. Either way the
// files are read from the tag's commit (`git show <sha>:<path>`), never from a working tree, so a
// dirty checkout cannot leak into the copy. Stage every file before replacing the previous copy;
// t3code.pin.json records the tag, the commit and a hash of every file it wrote. The vendored
// files are never edited by hand: run this again to move the pin.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { REPOSITORY, SOURCES } from "./sources.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd: string, args: ReadonlyArray<string>): Buffer =>
  execFileSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });

const gitText = (cwd: string, args: ReadonlyArray<string>): string =>
  git(cwd, args).toString("utf8").trim();

/** The id git gives the file's content, so the pin can be checked against `git ls-tree`. */
const gitBlobId = (bytes: Buffer): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    source: { type: "string" },
    repository: { type: "string", default: REPOSITORY },
  },
});
const tag = values.tag;
if (tag === undefined || tag === "") {
  process.stderr.write("usage: node scripts/sync.ts --tag <t3code tag> [--source <checkout>]\n");
  process.exit(2);
}

let repo = values.source;
let scratch: string | undefined;
let staging: string | undefined;
let retainBackup = false;

try {
  if (repo === undefined) {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-t3code-"));
    repo = scratch;
    git(repo, ["init", "--quiet"]);
    git(repo, [
      "fetch",
      "--quiet",
      "--depth=1",
      values.repository,
      `refs/tags/${tag}:refs/tags/${tag}`,
    ]);
  } else {
    repo = path.resolve(repo);
  }
  const commit = gitText(repo, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);

  const entries: Array<{ readonly upstream: string; readonly local: string }> = [];
  for (const source of SOURCES) {
    const listed = gitText(repo, ["ls-tree", "-r", "--name-only", commit, "--", source.upstream])
      .split("\n")
      .filter((line) => line !== "");
    if (listed.length === 0) {
      throw new Error(`${source.upstream} does not exist at ${tag} (${commit})`);
    }
    for (const upstream of listed) {
      const relative = upstream === source.upstream ? "" : upstream.slice(source.upstream.length);
      entries.push({ upstream, local: `${source.local}${relative}` });
    }
  }
  entries.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));

  staging = fs.mkdtempSync(path.join(packageRoot, ".sync-"));
  const prepared = path.join(staging, "new");
  const backup = path.join(staging, "previous");
  const files: Record<string, { upstream: string; blob: string; sha256: string }> = {};
  for (const entry of entries) {
    const bytes = git(repo, ["show", `${commit}:${entry.upstream}`]);
    const target = path.join(prepared, entry.local);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    files[entry.local] = {
      upstream: entry.upstream,
      blob: gitBlobId(bytes),
      sha256: sha256(bytes),
    };
  }

  const pin = { repository: values.repository, tag, commit, files };
  fs.writeFileSync(path.join(prepared, "t3code.pin.json"), `${JSON.stringify(pin, null, 2)}\n`);

  // Same-filesystem renames preserve the old objects until every new destination, including
  // the pin, is installed. Roll back ordinary publication errors in reverse order. This is
  // an exclusive maintenance operation, not an atomic multi-path commit for concurrent readers.
  const undo: Array<() => void> = [];
  const ensureParent = (dir: string): void => {
    if (dir === packageRoot || fs.lstatSync(dir, { throwIfNoEntry: false }) !== undefined) return;
    ensureParent(path.dirname(dir));
    fs.mkdirSync(dir);
    undo.push(() => fs.rmdirSync(dir));
  };
  try {
    for (const local of [...SOURCES.map((source) => source.local), "t3code.pin.json"]) {
      const target = path.join(packageRoot, local);
      const previous = path.join(backup, local);
      ensureParent(path.dirname(target));
      if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        fs.mkdirSync(path.dirname(previous), { recursive: true });
        fs.renameSync(target, previous);
        undo.push(() => fs.renameSync(previous, target));
      }
      fs.renameSync(path.join(prepared, local), target);
      undo.push(() => fs.rmSync(target, { recursive: true, force: true }));
    }
  } catch (failure) {
    const rollbackErrors: unknown[] = [];
    for (const restore of undo.toReversed()) {
      try {
        restore();
      } catch (error) {
        rollbackErrors.push(error);
      }
    }
    if (rollbackErrors.length > 0) {
      retainBackup = true;
      const rollbackFailure = new AggregateError(
        [failure, ...rollbackErrors],
        `Sync rollback failed; recover previous files from ${backup}`,
        { cause: failure },
      );
      throw rollbackFailure;
    }
    throw failure;
  }
  process.stdout.write(`${entries.length} files from t3code ${tag} (${commit})\n`);
} finally {
  if (staging !== undefined && !retainBackup) fs.rmSync(staging, { recursive: true, force: true });
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true, force: true });
}
