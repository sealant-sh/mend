import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { computePlan } from "./plan.mjs";

// The receipt: for each obligation the current head owes, whether a passing result exists for
// this exact commit with a clean tree.

const readLatest = (root, verb) => {
  const path = join(root, ".verify/latest", `${verb}.json`);
  if (!existsSync(path)) return null;
  return { path: relative(root, path), result: JSON.parse(readFileSync(path, "utf8")) };
};

/** One step per obligation. `implemented` is the set of verbs this repo has. */
export const judgeObligation = (root, obligation, head, implemented) => {
  const base = { id: obligation.id, title: `${obligation.kind}: ${obligation.why}` };
  if (obligation.kind === "box-check") {
    return {
      ...base,
      status: "requires_external_observer",
      detail: `Owed by a feature or fix: ${obligation.what}`,
    };
  }
  if (obligation.verb === undefined || !implemented.has(obligation.verb)) {
    return {
      ...base,
      status: "skipped",
      detail: `No verify verb records this yet. ${
        obligation.command ? `Run ${obligation.command}` : obligation.how
      } and cite the log.`,
    };
  }
  const latest = readLatest(root, obligation.verb);
  if (latest === null) {
    return { ...base, status: "skipped", detail: `No ${obligation.verb} result yet` };
  }
  const { result, path } = latest;
  if (result.head.sha !== head.sha) {
    return {
      ...base,
      status: "skipped",
      detail: `Latest ${obligation.verb} result is for ${result.head.sha.slice(0, 10)}, not this head`,
      log: path,
    };
  }
  if (result.head.dirty || head.dirty) {
    return {
      ...base,
      status: "skipped",
      detail: `${result.head.dirty ? "That result" : "This tree"} has uncommitted changes`,
      log: path,
    };
  }
  return {
    ...base,
    status: result.status,
    detail: `${obligation.verb}: ${result.status}`,
    log: path,
  };
};

export const statusSteps = (root, { head, implemented }) => {
  const plan = computePlan(root, { head, files: undefined });
  const steps = plan.obligations.map((obligation) =>
    judgeObligation(root, obligation, head, implemented),
  );
  const next = [
    ...new Set(
      plan.obligations.flatMap((obligation, index) =>
        steps[index].status === "passed" || obligation.command === undefined
          ? []
          : [obligation.command],
      ),
    ),
  ];
  return { plan, steps, next };
};

const MARK = { passed: "x" };

/** The section a PR body or verdict comment carries: one line per obligation. */
export const toMarkdown = (result) =>
  [
    `### Verify status for ${result.head.sha.slice(0, 10)}${result.head.dirty ? " (dirty tree)" : ""}`,
    "",
    ...result.steps.map(
      (step) =>
        `- [${MARK[step.status] ?? " "}] \`${step.id}\`: ${step.status}${step.log ? ` (${step.log})` : ""}${
          step.status === "passed" ? "" : `. ${step.detail}`
        }`,
    ),
    "",
  ].join("\n");
