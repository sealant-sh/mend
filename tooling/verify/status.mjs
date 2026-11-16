import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { judgementLine, readJudgement } from "./judge.mjs";
import { computePlan, filesOwing, loadMap } from "./plan.mjs";
import { judgementMarkdown, productPatchId, receiptBlock } from "./receipt.mjs";

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
  // The run happens where the judge said: until there is a judgement nobody knows where, and a run
  // on the box is proved by the box running a build that contains this change.
  const verb = obligation.verb;
  if (obligation.after === "judge") {
    const judgement = readJudgement(root, head);
    if (judgement === null) {
      return {
        ...base,
        status: "skipped",
        detail: "No judgement for this commit yet, so nobody has said where to run it",
        command: "pnpm verify judge",
      };
    }
    if (judgement.where === "box") {
      const onBox = readLatest(root, "box-identity");
      const contains =
        onBox !== null && onBox.result.head.sha === head.sha && onBox.result.status === "passed";
      return {
        ...base,
        status: contains ? "passed" : "skipped",
        detail: contains
          ? "box identity: passed"
          : `The judge sent this to the box (${judgement.limit}); no passing box identity for this commit yet`,
        ...(contains ? { log: onBox.path } : { command: "pnpm verify box plan" }),
      };
    }
  }
  if (verb === undefined || !implemented.has(verb)) {
    return {
      ...base,
      status: "skipped",
      detail: `No verify verb records this yet. ${
        obligation.command ? `Run ${obligation.command}` : obligation.how
      } and cite the log.`,
    };
  }
  const latest = readLatest(root, verb);
  if (latest === null) {
    return {
      ...base,
      status: "skipped",
      detail: `No ${verb} result yet${obligation.what ? `: ${obligation.what}` : ""}`,
    };
  }
  const { result, path } = latest;
  if (result.head.sha !== head.sha) {
    return {
      ...base,
      status: "skipped",
      detail: `Latest ${verb} result is for ${result.head.sha.slice(0, 10)}, not this head`,
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
  // A check that let tests skip says how many and where each group runs, on its receipt line.
  const skipSummary = result.steps?.find((step) => step.skipSummary)?.skipSummary;
  // A file at risk of CI's per-file limit is a warning on the same line; it never fails it.
  const riskSummary = result.steps?.find((step) => step.riskSummary)?.riskSummary;
  const note = [
    skipSummary,
    riskSummary && `Warning: ${riskSummary}`,
    result.judgement && judgementLine(result.judgement),
  ]
    .filter(Boolean)
    .join(". ");
  return {
    ...base,
    status: result.status,
    detail: `${verb}: ${result.status}`,
    log: path,
    ...(note ? { note } : {}),
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
        steps[index].status === "passed" ? [] : [steps[index].command ?? obligation.command],
      ),
    ),
  ].filter(Boolean);
  // The receipt names the product-source part of the change by patch id, so a later commit with
  // the same product diff (a rebase, a push of tests or docs) can be matched to it.
  const judged = filesOwing(loadMap(root), plan.files, "judge");
  return {
    plan,
    steps,
    next,
    judgement: readJudgement(root, head),
    productPatchId: productPatchId(root, head.mergeBase, head.sha, judged),
  };
};

const MARK = { passed: "x" };

/**
 * The section a PR body carries: one line per obligation, the judgement in full when there is one,
 * and the same facts as a JSON block a script reads back (receipt.mjs).
 */
export const toMarkdown = (result) =>
  [
    `### Verify status for ${result.head.sha.slice(0, 10)}${result.head.dirty ? " (dirty tree)" : ""}`,
    "",
    ...result.steps.map(
      (step) =>
        `- [${MARK[step.status] ?? " "}] \`${step.id}\`: ${step.status}${step.log ? ` (${step.log})` : ""}${
          step.status === "passed" ? "" : `. ${step.detail}`
        }${step.note ? `. ${step.note}` : ""}`,
    ),
    "",
    ...(result.judgement ? judgementMarkdown(result.judgement) : []),
    ...receiptBlock(result),
  ].join("\n");
