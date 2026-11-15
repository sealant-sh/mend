import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, matchesGlob } from "node:path";

import { parse } from "yaml";

import { extras } from "../../scripts/ci-scope.mjs";
import { readCoverages, touches } from "../../scripts/formal-coverage.mjs";

// What a change owes. Two sources, neither restating the other:
// - obligations.json maps paths to local obligations (box check, screenshots, models, gated suites);
// - CI's own scoping (scripts/ci-scope.mjs and the `if:` of each job in ci.yml) says which CI jobs
//   run. obligations.json only names CI's lanes, so the two cannot disagree on paths;
//   plan.test.mjs fails when a lane is added on one side and not the other.

export const loadMap = (root) =>
  JSON.parse(readFileSync(join(root, "tooling/verify/obligations.json"), "utf8"));

const KINDS = ["tests", "formal", "stack", "screenshots", "box-check", "harness", "external"];

/** Every way the map departs from its shape; empty when it is usable. */
export const validateMap = (map) => {
  const errors = [];
  const ids = new Set();
  for (const [index, entry] of (map.obligations ?? []).entries()) {
    const at = `obligations[${index}]`;
    if (typeof entry.id !== "string" || entry.id === "") errors.push(`${at}.id is required`);
    if (ids.has(entry.id)) errors.push(`${at}.id ${entry.id} is not unique`);
    ids.add(entry.id);
    if (!Array.isArray(entry.paths) || entry.paths.length === 0)
      errors.push(`${at}.paths must list globs`);
    if (typeof entry.why !== "string" || entry.why === "") errors.push(`${at}.why is required`);
    if (!Array.isArray(entry.owes) || entry.owes.length === 0)
      errors.push(`${at}.owes must list what a change owes`);
    for (const owe of entry.owes ?? []) {
      if (!KINDS.includes(owe.kind)) errors.push(`${at} owes unknown kind ${owe.kind}`);
      if (owe.command === undefined && owe.how === undefined)
        errors.push(`${at} ${owe.kind} needs a command or a how`);
    }
  }
  return errors;
};

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** Committed and uncommitted changes against the merge base, untracked files included. */
export const changedFiles = (root, mergeBase) => {
  const tracked = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "-z",
    mergeBase,
  ]);
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return [
    ...new Set([...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean)),
  ].toSorted();
};

// matchesGlob never lets `**` cross a dot segment (`.github/`, `.gitignore`); `**` alone means
// every path here.
const matches = (file, globs) => globs.some((glob) => glob === "**" || matchesGlob(file, glob));

/** The obligations a set of changed files carries, each owed. */
export const matchObligations = (map, files) =>
  map.obligations.flatMap((entry) => {
    const hit = files.filter(
      (file) => matches(file, entry.paths) && !matches(file, entry.exclude ?? []),
    );
    if (hit.length === 0) return [];
    return entry.owes.map((owe) => ({
      id: entry.owes.length === 1 ? entry.id : `${entry.id}:${owe.kind}`,
      ...owe,
      why: entry.why,
      status: "owed",
      paths: hit.slice(0, 20),
      ...(hit.length > 20 ? { morePaths: hit.length - 20 } : {}),
    }));
  });

/** A model's obligation, from its docs/formal/<area>/COVERAGE: the one record of what it covers. */
export const formalObligations = (root, files) =>
  readCoverages(root).flatMap((coverage) => {
    const hit = files.filter((path) => touches(coverage, path));
    if (hit.length === 0) return [];
    return [
      {
        id: `formal-${coverage.area}`,
        kind: "formal",
        model: coverage.area,
        verb: "formal",
        command: "pnpm verify formal",
        how: `.agents/skills/${coverage.area}`,
        why: `The ${coverage.area} model stands for this code (${coverage.dir}/COVERAGE)`,
        status: "owed",
        paths: hit,
      },
    ];
  });

/** The `changes` output each job's `if:` reads, or null for a job every PR runs. */
const laneOf = (job) => /needs\.changes\.outputs\.(\w+)/.exec(job.if ?? "")?.[1] ?? null;

export const readCiJobs = (root) => {
  const workflow = parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"));
  return Object.entries(workflow.jobs).map(([job, body]) => ({ job, lane: laneOf(body) }));
};

/** Which CI jobs a pull request with these files runs, decided by CI's own code. */
export const ciPlan = (root, files, map) => {
  const scope = extras(files);
  const commands = new Map(map.ciLanes.map((lane) => [lane.lane, lane.command]));
  return readCiJobs(root).map(({ job, lane }) => ({
    job,
    runs: lane === null ? true : scope[lane] === true,
    ...(lane === null ? {} : { lane, localCommand: commands.get(lane) }),
  }));
};

/** Computes the plan for a diff, or for the given files. Throws only on a broken checkout. */
export const computePlan = (root, { head, files }) => {
  const map = loadMap(root);
  const changed = files ?? changedFiles(root, head.mergeBase);
  return {
    files: changed,
    obligations: [...matchObligations(map, changed), ...formalObligations(root, changed)],
    ci: ciPlan(root, changed, map),
  };
};

export const planSteps = (root, { head, files }) => {
  if (files === undefined && head.mergeBase === null) {
    return {
      steps: [
        {
          id: "diff",
          title: "Diff against the merge base",
          status: "blocked_by_prerequisite",
          detail: `No merge base with ${head.base}`,
        },
      ],
      next: [`git fetch origin main`],
    };
  }
  const plan = computePlan(root, { head, files });
  const running = plan.ci.filter((job) => job.runs).map((job) => job.job);
  return {
    plan,
    steps: [
      {
        id: "diff",
        title: files === undefined ? "Diff against the merge base" : "Files given",
        status: "passed",
        detail:
          files === undefined
            ? `${plan.files.length} changed files against ${head.mergeBase.slice(0, 10)} (${head.base}), uncommitted included`
            : `${plan.files.length} files`,
      },
      {
        id: "obligations",
        title: "Match tooling/verify/obligations.json",
        status: "passed",
        detail: plan.obligations.map((obligation) => obligation.id).join(", ") || "none",
      },
      {
        id: "ci",
        title: "CI jobs this diff runs (scripts/ci-scope.mjs, ci.yml)",
        status: "passed",
        detail: running.join(", "),
      },
    ],
    next: plan.obligations.flatMap((obligation) =>
      obligation.command === undefined ? [] : [obligation.command],
    ),
  };
};
