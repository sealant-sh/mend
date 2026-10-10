// Says whether a newer t3code changed the contracts this package vendors (docs/adr/0012, phase 4:
// the drift job). Reads the newest nightly tag (or --tag), lists the files under the vendored
// sources at its commit by git blob id, and compares them with t3code.pin.json. Nothing is written
// to this package.
//
//   node scripts/drift.ts [--tag <t3code tag>] [--out <report.md>]
//
// Exit 0: no drift. Exit 1: drift, the report says what. Exit 2: it could not tell.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  driftOf,
  hasDrift,
  newestNightly,
  parseLsTree,
  reportOf,
  type PinnedFile,
} from "./drift-lib.ts";
import { REPOSITORY, SOURCES } from "./sources.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const git = (cwd: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .trim();

const { values } = parseArgs({
  options: {
    tag: { type: "string" },
    out: { type: "string" },
    repository: { type: "string", default: REPOSITORY },
  },
});

const isPin = (value: unknown): value is { tag: string; files: Record<string, PinnedFile> } =>
  typeof value === "object" &&
  value !== null &&
  "tag" in value &&
  typeof value.tag === "string" &&
  "files" in value &&
  typeof value.files === "object" &&
  value.files !== null;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mend-t3code-drift-"));
try {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "t3code.pin.json"), "utf8"),
  );
  if (!isPin(parsed)) throw new Error("t3code.pin.json has no tag and files");
  const tag =
    values.tag ??
    newestNightly(
      git(scratch, ["ls-remote", "--tags", "--refs", values.repository, "refs/tags/v*-nightly.*"])
        .split("\n")
        .map((line) => line.slice(line.indexOf("refs/tags/") + "refs/tags/".length)),
    );
  if (tag === null || tag === undefined) throw new Error(`no nightly tag at ${values.repository}`);
  git(scratch, ["init", "--quiet"]);
  git(scratch, [
    "fetch",
    "--quiet",
    "--depth=1",
    values.repository,
    `refs/tags/${tag}:refs/tags/${tag}`,
  ]);
  const commit = git(scratch, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  const listing = parseLsTree(
    git(scratch, ["ls-tree", "-r", commit, "--", ...SOURCES.map((source) => source.upstream)]),
  );
  const drift = driftOf(parsed.files, listing);
  const report = reportOf({ pinnedTag: parsed.tag, tag, commit, drift });
  if (values.out === undefined) process.stdout.write(report);
  else fs.writeFileSync(values.out, report);
  process.stdout.write(
    hasDrift(drift)
      ? `drift: ${drift.changed.length} changed, ${drift.added.length} new, ${drift.removed.length} gone at ${tag}\n`
      : `no drift at ${tag}\n`,
  );
  process.exitCode = hasDrift(drift) ? 1 : 0;
} catch (error) {
  process.stderr.write(
    `could not tell: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 2;
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
