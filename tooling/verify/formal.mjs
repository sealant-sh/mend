#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
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
// - The check: `check.sh --quick`, or the full bounds with --full, each within the area's budget
//   (COVERAGE's budget-quick and budget-full, in minutes). A check that runs past it is stopped and
//   fails naming the model, rather than running on to the CI job's limit.
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

// Why a sync commit can be missing. CI's checkout holds branches and tags, no pull request ref, and
// a squash merge puts none of a pull request's own commits on main.
const WHY_SYNC_VANISHES =
  "A squash merge puts none of a pull request's own commits on main. Once its branch is deleted, only GitHub's pull request ref holds its last pushed head and the commits under it, and verify formal fetches those by SHA. A commit that a rebase or force-push replaced before the merge, or one never pushed, is held by nothing";

/** Whether this clone has `sha`, fetching it from origin by SHA when it does not. */
export const fetchCommit = (root, sha) => {
  if (hasCommit(root, sha)) return true;
  try {
    execFileSync("git", ["fetch", "--quiet", "--no-tags", "origin", sha], {
      cwd: root,
      stdio: "ignore",
      timeout: 120_000,
    });
  } catch {
    return false;
  }
  return hasCommit(root, sha);
};

const reaches = (root, head, sha) => {
  try {
    git(root, ["merge-base", "--is-ancestor", sha, head]);
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

/**
 * The guard for one area over a diff's files; `base` is where the diff starts and `head` where it
 * ends. A sync commit the diff moves must be one `head` reaches, so that main or the pull
 * request's last pushed head still holds it after the squash merge.
 */
export const guard = (root, coverage, { files, base, head = "HEAD" }) => {
  const before = base ? syncAt(root, coverage, base) : null;
  if (before !== null && before !== coverage.sync && !reaches(root, head, coverage.sync))
    return {
      status: "failed",
      detail: `${coverageFile(coverage)} moves sync to ${coverage.sync.slice(0, 10)}, which this branch does not reach: a commit that a rebase or force-push replaced, one from another branch, or one never pushed. After the squash merge GitHub keeps only main and this pull request's last pushed head, so the commit would vanish. Name a commit on main, or this branch's commit that holds the code you checked, as pushed, and re-point it after every rebase`,
    };
  const code = files.filter((path) => coverage.paths.includes(path));
  if (code.length === 0) return { status: "passed", detail: "no covered code changed" };
  const model = files.filter((path) => coverage.model.includes(path));
  if (model.length > 0)
    return { status: "passed", detail: `covered code and the model changed (${model.join(", ")})` };
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

/**
 * Covered files that changed since the sync commit, at `head`. A sync commit this clone lacks is
 * fetched from origin; `known` is false when origin does not serve it either.
 */
export const drift = (root, coverage, head, fetch = fetchCommit) => {
  if (!fetch(root, coverage.sync)) return { known: false, files: [] };
  const files = git(root, ["diff", "--name-only", coverage.sync, head, "--", ...coverage.paths])
    .split("\n")
    .filter(Boolean);
  return { known: true, files };
};

/** Where docs/formal/tlx.sh puts the tlx it pins, built or not. */
export const tlxPath = (root, env) => {
  const pin = readFileSync(join(root, "docs/formal/tlx.sh"), "utf8").match(
    /^TLX_COMMIT=([0-9a-f]{40})$/m,
  );
  if (!pin) throw new Error("docs/formal/tlx.sh names no TLX_COMMIT");
  const cache = env.XDG_CACHE_HOME || join(env.HOME ?? "", ".cache");
  return join(cache, "mend-formal", `tlx-${pin[1]}`, "tlx");
};

/**
 * What check.sh needs. With tlx, its default: a build in MEND_TLX, the pinned build tlx.sh made
 * already, or cargo or Nix for tlx.sh to make it. With TLC (MEND_FORMAL_ENGINE=tlc): Nix, or java
 * and curl, or a jar named by TLA2TOOLS_JAR.
 */
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
  built = () => false,
) => {
  if ((env.MEND_FORMAL_ENGINE ?? "tlx") === "tlc") {
    if (env.TLA2TOOLS_JAR || has("nix")) return null;
    const missing = ["java", "curl"].filter((tool) => !has(tool));
    return missing.length === 0 ? null : `check.sh needs Nix, or ${missing.join(" and ")}`;
  }
  if (env.MEND_TLX || built() || has("cargo") || has("nix")) return null;
  return "check.sh needs tlx: cargo or Nix to build it (docs/formal/tlx.sh), or MEND_TLX naming a build";
};

/**
 * Runs a command in its own process group, so a budget that runs out stops the checker it started
 * (bash, then java or tlx) and not only bash. Resolves to the exit code, or "timeout".
 */
export const runBudgeted = (command, args, { cwd, env, stdio, budgetMs, onStart }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio, detached: true });
    onStart?.(child);
    let timedOut = false;
    let killer = null;
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        // The group has already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      killer = setTimeout(() => signal("SIGKILL"), 10_000);
    }, budgetMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(127);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve(timedOut ? "timeout" : (code ?? 1));
    });
  });

const runLogged = (command, args, { cwd, env, log, budgetMs }) => {
  mkdirSync(join(log, ".."), { recursive: true });
  const out = createWriteStream(log);
  return runBudgeted(command, args, {
    cwd,
    env,
    budgetMs,
    stdio: ["ignore", "pipe", "pipe"],
    onStart: (child) => {
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
    },
  }).then((code) => new Promise((resolve) => out.end(() => resolve(code))));
};

/**
 * The steps for every area the files touch (or every area with `all`): its guard, with drift
 * reported, then its check.
 */
export const formalSteps = async (
  root,
  {
    files,
    base,
    head,
    all = false,
    full = false,
    area = null,
    env = process.env,
    run = runLogged,
    logs,
  },
) => {
  const steps = [];
  const known = readCoverages(root);
  if (area !== null && !known.some((coverage) => coverage.area === area))
    throw new Error(`no model area ${area}: docs/formal/${area}/COVERAGE does not exist`);
  const areas = known.filter(
    (coverage) =>
      (area === null || coverage.area === area) &&
      (all || files.some((path) => touches(coverage, path))),
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
        : guard(root, coverage, { files, base, head });
    const moved = drift(root, coverage, head);
    if (!moved.known)
      steps.push({
        id: `${coverage.area}-sync`,
        title: `${coverage.area}: the sync commit in COVERAGE can be read`,
        status: "failed",
        detail: `${coverage.area}'s sync commit ${coverage.sync} is not in this clone, and origin does not serve it. ${WHY_SYNC_VANISHES}. Point the sync line in ${coverageFile(coverage)} at the commit on main that holds the code the model was last checked against (usually the squash commit of the pull request that set it: git log origin/main --format=%H -- ${coverageFile(coverage)}), and account for any covered hunk between the two as .agents/skills/${coverage.area} step 1 says`,
      });
    steps.push({
      id: `${coverage.area}-guard`,
      title: `${coverage.area}: covered code changes move the model or its sync commit`,
      status: verdict.status,
      detail: `${verdict.detail}. Drift since ${coverage.sync.slice(0, 10)}: ${
        moved.known
          ? moved.files.length === 0
            ? "none"
            : moved.files.join(", ")
          : "unknown, the sync commit cannot be read"
      }`,
    });
    const missing = checkerMissing(env, undefined, () => {
      try {
        return existsSync(tlxPath(root, env));
      } catch {
        return false;
      }
    });
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
    const bounds = full ? "full" : "quick";
    const minutes = coverage.budgets[bounds];
    const code = await run("bash", args, { cwd: root, env, log, budgetMs: minutes * 60_000 });
    steps.push({
      id: `${coverage.area}-check`,
      title: `${coverage.area}: model check, ${bounds} bounds`,
      status: code === 0 ? "passed" : "failed",
      command: `bash ${args.join(" ")}`,
      log,
      detail:
        code === 0
          ? "every row as expected"
          : code === "timeout"
            ? `${coverage.area} ran past its ${minutes}-minute budget at ${bounds} bounds and was stopped, so nothing it had left was checked. Either its state space grew or the runner was slow: the checker's last progress line gives the distinct states it reached, against the count check.sh pins for the row, and the states it generated a minute, against the rates README.md in ${coverage.dir} records. If the model grew, find what grew and change the budget-${bounds} line in ${coverageFile(coverage)} only with what the model then gives up written down`
            : "a row is NOT AS EXPECTED; the log names it, and the skill's step 3 classifies it",
    });
  }
  return steps;
};

// CI: `node tooling/verify/formal.mjs ci <base sha|-> <head sha> [--full] [--area <area>]`. With
// `-` (a push to main, the nightly run) there is no diff: every area runs and the guard is not
// asked. `--area` keeps to one model: CI runs one job per model.
const ci = async (argv) => {
  const [base, head, ...flags] = argv;
  const areaAt = flags.indexOf("--area");
  const area = areaAt === -1 ? null : (flags[areaAt + 1] ?? null);
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
    area,
    logs: join(root, ".verify/logs"),
    run: (command, args, options) =>
      runBudgeted(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: "inherit",
        budgetMs: options.budgetMs,
      }),
  });
  for (const step of steps) console.log(`${step.status.padEnd(24)} ${step.id}: ${step.detail}`);
  const bad = steps.filter((step) => step.status !== "passed");
  for (const step of bad) console.log(`::error title=${step.id} did not pass::${step.detail}`);
  return bad.length === 0 ? 0 : 1;
};

if (import.meta.main && process.argv[2] === "ci")
  process.exitCode = await ci(process.argv.slice(3));
else if (import.meta.main) {
  process.stderr.write(
    "usage: node tooling/verify/formal.mjs ci <base sha|-> <head sha> [--full] [--area <area>]\n",
  );
  process.exitCode = 2;
}
