import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The shared verify result (TOOLKIT-SPEC.md, "The result"). Every verb's output passes
// validateResult; result.test.mjs holds each verb to it.

export const SCHEMA_VERSION = 1;

/** Worst first: a verb's status is the first of these that any of its steps has. */
export const STATUSES = [
  "failed",
  "blocked_by_prerequisite",
  "skipped",
  "not_implemented",
  "requires_external_observer",
  "evidence_withheld",
  "passed",
];

export const rollUp = (statuses) =>
  STATUSES.find((status) => statuses.includes(status)) ?? "passed";

/** Exit codes: 0 passed, 1 failed, 2 wrong usage (no result), 3 blocked, 4 anything else. */
export const exitCode = (status) =>
  status === "passed" ? 0 : status === "failed" ? 1 : status === "blocked_by_prerequisite" ? 3 : 4;

export class UsageError extends Error {}

const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The commit a result is about. `.verify/` is git-ignored, so writing results never dirties it. */
export const readHead = (root, base = "origin/main") => {
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "";
  let mergeBase = null;
  try {
    mergeBase = git(root, ["merge-base", base, "HEAD"]).trim();
  } catch {
    // An unknown base leaves mergeBase null; plan reports that as blocked.
  }
  return { sha, branch, dirty, base, mergeBase };
};

export const createResult = ({ repo = "mend", verb, head, startedAt, steps, ...rest }) => {
  const status = rest.status ?? rollUp(steps.map((step) => step.status));
  return {
    schemaVersion: SCHEMA_VERSION,
    tool: "verify",
    repo,
    verb,
    status,
    head,
    startedAt: startedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    durationMs: Date.now() - startedAt.getTime(),
    steps,
    obligations: rest.obligations ?? [],
    evidence: rest.evidence ?? [],
    cleanup: rest.cleanup ?? { status: "clean", left: [] },
    next: rest.next ?? [],
    ...Object.fromEntries(
      Object.entries(rest).filter(
        ([key]) => !["status", "obligations", "evidence", "cleanup", "next"].includes(key),
      ),
    ),
  };
};

const isString = (value) => typeof value === "string";
const isNonEmpty = (value) => isString(value) && value.length > 0;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isStatus = (value) => STATUSES.includes(value);
const isCount = (value) => Number.isInteger(value) && value >= 0;

/** Returns every way the value departs from the shared result; empty when it conforms. */
export const validateResult = (result) => {
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  if (!isObject(result)) return ["result is not an object"];
  need(result.schemaVersion === SCHEMA_VERSION, "schemaVersion must be 1");
  need(result.tool === "verify", "tool must be verify");
  need(isNonEmpty(result.repo), "repo is required");
  need(isNonEmpty(result.verb), "verb is required");
  need(isStatus(result.status), `status ${String(result.status)} is not a known status`);
  const head = result.head;
  need(isObject(head), "head is required");
  if (isObject(head)) {
    need(/^[0-9a-f]{40,64}$/.test(head.sha ?? ""), "head.sha must be a full commit id");
    need(isString(head.branch), "head.branch is required");
    need(typeof head.dirty === "boolean", "head.dirty must be a boolean");
    need(isString(head.base), "head.base is required");
    need(head.mergeBase === null || isString(head.mergeBase), "head.mergeBase is a string or null");
  }
  need(
    isString(result.startedAt) && !Number.isNaN(Date.parse(result.startedAt)),
    "startedAt must be a timestamp",
  );
  need(isCount(result.durationMs), "durationMs must be a whole number of milliseconds");
  need(Array.isArray(result.steps), "steps must be an array");
  for (const [index, step] of (Array.isArray(result.steps) ? result.steps : []).entries()) {
    const at = `steps[${index}]`;
    if (!isObject(step)) {
      errors.push(`${at} is not an object`);
      continue;
    }
    need(isNonEmpty(step.id), `${at}.id is required`);
    need(isNonEmpty(step.title), `${at}.title is required`);
    need(isStatus(step.status), `${at}.status ${String(step.status)} is not a known status`);
    for (const key of ["command", "log", "detail"])
      need(step[key] === undefined || isString(step[key]), `${at}.${key} must be a string`);
    need(step.durationMs === undefined || isCount(step.durationMs), `${at}.durationMs`);
    need(
      step.skipped === undefined ||
        (Array.isArray(step.skipped) &&
          step.skipped.every((skip) => isObject(skip) && isNonEmpty(skip.name))),
      `${at}.skipped must list named tests`,
    );
  }
  if (Array.isArray(result.steps) && isStatus(result.status)) {
    need(
      result.status === rollUp(result.steps.map((step) => step?.status)) ||
        result.steps.length === 0,
      "status must be the worst of the steps' statuses",
    );
  }
  need(Array.isArray(result.obligations), "obligations must be an array");
  for (const [index, obligation] of (Array.isArray(result.obligations)
    ? result.obligations
    : []
  ).entries()) {
    const at = `obligations[${index}]`;
    need(isObject(obligation), `${at} is not an object`);
    if (!isObject(obligation)) continue;
    need(isNonEmpty(obligation.id), `${at}.id is required`);
    need(isNonEmpty(obligation.kind), `${at}.kind is required`);
    need(isNonEmpty(obligation.why), `${at}.why is required`);
    need(isNonEmpty(obligation.status), `${at}.status is required`);
  }
  need(
    Array.isArray(result.evidence) &&
      result.evidence.every(
        (item) => isObject(item) && isNonEmpty(item.kind) && isNonEmpty(item.path),
      ),
    "evidence must list { kind, path }",
  );
  need(
    isObject(result.cleanup) &&
      ["clean", "left", "failed"].includes(result.cleanup.status) &&
      Array.isArray(result.cleanup.left),
    "cleanup must be { status: clean | left | failed, left: [] }",
  );
  need(
    Array.isArray(result.next) && result.next.every(isNonEmpty),
    "next must be a list of commands",
  );
  return errors;
};

const stamp = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Writes `.verify/results/<verb>-<UTC>.json` and copies it to `.verify/latest/<verb>.json`. */
export const saveResult = (root, result) => {
  const results = join(root, ".verify", "results");
  const latest = join(root, ".verify", "latest");
  mkdirSync(results, { recursive: true });
  mkdirSync(latest, { recursive: true });
  const name = result.verb.replaceAll(" ", "-");
  const file = join(results, `${name}-${stamp(new Date(result.startedAt))}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  copyFileSync(file, join(latest, `${name}.json`));
  return file;
};
