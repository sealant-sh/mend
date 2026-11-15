#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  coverageFile,
  parseCoverage,
  readCoverages,
  touches,
} from "../../scripts/formal-coverage.mjs";

// `verify formal`: run the models whose COVERAGE the diff touches, and say whether they still stand
// for the code (docs/formal/<area>/COVERAGE).
//
// - The guard (this diff): a change to covered code must move the model or the COVERAGE sync
//   commit, after the area's skill says the model still describes the code. Otherwise it fails.
// - Drift (since the sync commit): which covered files changed since the model was last confirmed.
//   It is reported, not failed: the guard holds each change to account as it lands.
// - The check: `check.sh --quick`, or the full bounds with --full.
//
// No dependency, so CI's `formal` job runs `node tooling/verify/formal.mjs ci …` without an install.

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

const hasCommit = (root, sha) => {
  try {
    git(root, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/** The sync commit COVERAGE named at `ref`, or null where it did not exist yet. */
const syncAt = (root, coverage, ref) => {
  try {
    return parseCoverage(git(root, ["show", `${ref}:${coverageFile(coverage)}`]), coverage.area)
      .sync;
  } catch {
    return null;
  }
};

/** The guard for one area over a diff's files; `base` is where the diff starts. */
export const guard = (root, coverage, { files, base }) => {
  const code = files.filter((path) => coverage.paths.includes(path));
  if (code.length === 0) return { status: "passed", detail: "no covered code changed" };
  const model = files.filter((path) => coverage.model.includes(path));
  if (model.length > 0)
    return { status: "passed", detail: `covered code and the model changed (${model.join(", ")})` };
  const before = base ? syncAt(root, coverage, base) : null;
  if (before !== null && before !== coverage.sync)
    return {
      status: "passed",
      detail: `covered code changed and the sync commit moved to ${coverage.sync.slice(0, 10)}`,
    };
  return {
    status: "failed",
    detail: `${code.join(", ")} changed, and neither the model nor COVERAGE's sync commit moved. Follow .agents/skills/${coverage.area} step 1: account for each hunk in the model, run the full check, then move the sync line in ${coverageFile(coverage)}`,
  };
};

/** Covered files that changed since the sync commit, at `head`. */
export const drift = (root, coverage, head) => {
  if (!hasCommit(root, coverage.sync)) return { known: false, files: [] };
  const files = git(root, ["diff", "--name-only", coverage.sync, head, "--", ...coverage.paths])
    .split("\n")
    .filter(Boolean);
  return { known: true, files };
};

/** What check.sh needs: Nix, or java and curl, or a jar named by TLA2TOOLS_JAR. */
export const checkerMissing = (
  env,
  has = (tool) => {
    try {
      execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
) => {
  if (env.TLA2TOOLS_JAR || has("nix")) return null;
  const missing = ["java", "curl"].filter((tool) => !has(tool));
  return missing.length === 0 ? null : `check.sh needs Nix, or ${missing.join(" and ")}`;
};

const runLogged = (command, args, { cwd, env, log }) =>
  new Promise((resolve) => {
    mkdirSync(join(log, ".."), { recursive: true });
    const out = createWriteStream(log);
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.once("error", () => resolve(127));
    child.once("close", (code) => out.end(() => resolve(code ?? 1)));
  });

/**
 * The steps for every area the files touch (or every area with `all`): its guard, with drift
 * reported, then its check.
 */
export const formalSteps = async (
  root,
  { files, base, head, all = false, full = false, env = process.env, run = runLogged, logs },
) => {
  const steps = [];
  const areas = readCoverages(root).filter(
    (coverage) => all || files.some((path) => touches(coverage, path)),
  );
  if (areas.length === 0) {
    return [
      {
        id: "models",
        title: "Models whose coverage the change touches",
        status: "passed",
        detail: "none",
      },
    ];
  }
  for (const coverage of areas) {
    const verdict =
      base === null
        ? { status: "passed", detail: "no base: the guard needs a diff" }
        : guard(root, coverage, { files, base });
    const moved = drift(root, coverage, head);
    steps.push({
      id: `${coverage.area}-guard`,
      title: `${coverage.area}: covered code changes move the model or its sync commit`,
      status: verdict.status,
      detail: `${verdict.detail}. Drift since ${coverage.sync.slice(0, 10)}: ${
        moved.known
          ? moved.files.length === 0
            ? "none"
            : moved.files.join(", ")
          : "the sync commit is not in this clone"
      }`,
    });
    const missing = checkerMissing(env);
    if (missing) {
      steps.push({
        id: `${coverage.area}-check`,
        title: `${coverage.area}: model check`,
        status: "blocked_by_prerequisite",
        detail: missing,
      });
      continue;
    }
    const log = join(logs, `formal-${coverage.area}.log`);
    const args = [join(coverage.dir, "check.sh"), ...(full ? [] : ["--quick"])];
    const code = await run("bash", args, { cwd: root, env, log });
    steps.push({
      id: `${coverage.area}-check`,
      title: `${coverage.area}: model check, ${full ? "full" : "quick"} bounds`,
      status: code === 0 ? "passed" : "failed",
      command: `bash ${args.join(" ")}`,
      log,
      detail:
        code === 0
          ? "every row as expected"
          : "a row is NOT AS EXPECTED; the log names it, and the skill's step 3 classifies it",
    });
  }
  return steps;
};

// CI: `node tooling/verify/formal.mjs ci <base sha|-> <head sha> [--full]`. With `-` (a push to
// main, the nightly run) there is no diff: every area runs and the guard is not asked.
const ci = async (argv) => {
  const [base, head, ...flags] = argv;
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const diffBase = base === "-" ? null : base;
  const files =
    diffBase === null
      ? []
      : git(root, ["diff", "--name-only", "--no-renames", `${diffBase}...${head}`])
          .split("\n")
          .filter(Boolean);
  const steps = await formalSteps(root, {
    files,
    base: diffBase === null ? null : git(root, ["merge-base", diffBase, head]).trim(),
    head,
    all: diffBase === null,
    full: flags.includes("--full"),
    logs: join(root, ".verify/logs"),
    run: (command, args, options) =>
      new Promise((resolve) => {
        const child = spawn(command, args, {
          cwd: options.cwd,
          env: options.env,
          stdio: "inherit",
        });
        child.once("close", (code) => resolve(code ?? 1));
      }),
  });
  for (const step of steps) console.log(`${step.status.padEnd(24)} ${step.id}: ${step.detail}`);
  const bad = steps.filter((step) => step.status !== "passed");
  if (bad.length > 0) console.log(`::error::${bad.map((step) => step.id).join(", ")} did not pass`);
  return bad.length === 0 ? 0 : 1;
};

if (import.meta.main && process.argv[2] === "ci")
  process.exitCode = await ci(process.argv.slice(3));
else if (import.meta.main) {
  process.stderr.write(
    "usage: node tooling/verify/formal.mjs ci <base sha|-> <head sha> [--full]\n",
  );
  process.exitCode = 2;
}
