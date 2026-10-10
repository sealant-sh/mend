// Copy t3code's contracts into this package, byte for byte, from one tag.
//
//   node scripts/sync.ts --tag v0.0.46-nightly.20261003.2623 [--source /path/to/t3code]
//
// Without --source it fetches the tag from GitHub into a temporary repository. Either way the
// files are read from the tag's commit (`git show <sha>:<path>`), never from a working tree, so a
// dirty checkout cannot leak into the copy. The previous copy is removed first, and
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

try {
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

  for (const source of SOURCES) {
    fs.rmSync(path.join(packageRoot, source.local), { recursive: true, force: true });
  }

  const files: Record<string, { upstream: string; blob: string; sha256: string }> = {};
  for (const entry of entries) {
    const bytes = git(repo, ["show", `${commit}:${entry.upstream}`]);
    const target = path.join(packageRoot, entry.local);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    files[entry.local] = {
      upstream: entry.upstream,
      blob: gitBlobId(bytes),
      sha256: sha256(bytes),
    };
  }

  const pin = { repository: values.repository, tag, commit, files };
  fs.writeFileSync(path.join(packageRoot, "t3code.pin.json"), `${JSON.stringify(pin, null, 2)}\n`);
  process.stdout.write(`${entries.length} files from t3code ${tag} (${commit})\n`);
} finally {
  if (scratch !== undefined) fs.rmSync(scratch, { recursive: true, force: true });
}
