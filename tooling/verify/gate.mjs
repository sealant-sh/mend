import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { filesOwing, loadMap, matchObligations } from "./plan.mjs";
import { productPatchId, readReceipts } from "./receipt.mjs";

// The receipt gate, run by CI's required `checks` job on a pull request: a PR whose diff owes
// `judge` and `run-it` (obligations.json, as `verify plan` reads it) passes only when its body, as
// it is now, carries a receipt for its head, or for an earlier commit with the same product-source
// patch id, with both lines passed. It reads the PR from the API, never from the event payload, so
// a re-run after the body is edited (.github/workflows/receipt-recheck.yml) reads the new body.
// It runs with a read-only token and needs no install: Node and git.

/** A person's way to waive the gate on one PR. Agents never add it (AGENTS.md). */
export const WAIVER = "verify: waived";

const VERSION_BRANCH = "changeset-release/main";

const FIX = [
  "pnpm verify judge                         # write the brief; another agent answers it",
  "pnpm verify judge --record <answer.json>  # keep its answer for this commit",
  "run it where the judge said, then: pnpm verify evidence   (box: pnpm verify box identity)",
  "pnpm verify status --markdown             # paste it into the PR body as printed",
];

const lineOf = (receipt, id) => receipt.lines.find((line) => line.id === id)?.status ?? "missing";

/**
 * Whether a PR passes the gate, and what to tell its author. Pure: `pr` is the API's view of the
 * pull request, `owes` whether its diff owes a judge and a run, `headPatchId` the product-source
 * patch id of its head.
 */
export const decide = ({ pr, owes, headSha, headPatchId }) => {
  const pass = (summary) => ({ passed: true, summary });
  if (pr.head.sha !== headSha)
    return pass(
      `this run is for ${headSha.slice(0, 10)}; the PR's head is now ${pr.head.sha.slice(0, 10)}, and its own run decides`,
    );
  if (pr.head.ref === VERSION_BRANCH) return pass("a Version Packages PR owes no receipt");
  if (pr.user?.login === "dependabot[bot]") return pass("a Dependabot PR owes no receipt");
  if ((pr.labels ?? []).some((label) => label.name === WAIVER))
    return pass(`waived by a person with the \`${WAIVER}\` label`);
  if (!owes) return pass("this diff owes neither `judge` nor `run-it`");

  const found = readReceipts(pr.body);
  const receipts = found.flatMap((item) => (item.receipt ? [item.receipt] : []));
  const problems = found.flatMap((item) =>
    item.errors ? [`a damaged receipt: ${item.errors.join("; ")}`] : [],
  );
  for (const receipt of receipts.toReversed()) {
    const same = receipt.sha === headSha;
    const samePatch = headPatchId !== null && receipt.productPatchId === headPatchId;
    const judge = lineOf(receipt, "judge");
    const run = lineOf(receipt, "run-it");
    const why = [
      ...(same || samePatch
        ? []
        : [
            `it is for ${receipt.sha.slice(0, 10)}, whose product-source change differs from the head's`,
          ]),
      ...(receipt.dirty ? ["it was printed from a tree with uncommitted changes"] : []),
      ...(judge === "passed" && receipt.judgement !== null ? [] : [`\`judge\` is ${judge}`]),
      ...(run === "passed" ? [] : [`\`run-it\` is ${run}`]),
    ];
    if (why.length === 0) {
      const j = receipt.judgement;
      return pass(
        [
          `receipt for ${receipt.sha.slice(0, 10)}${same ? "" : `, the same product change as the head ${headSha.slice(0, 10)} by patch id`}`,
          `run on ${j.where === "box" ? `the box (${j.limit})` : "a local stack"}`,
          j.judgedBy === "self"
            ? "the author judged it (--self), not another agent"
            : "judged by another agent",
        ].join("; "),
      );
    }
    problems.push(`the receipt for ${receipt.sha.slice(0, 10)}: ${why.join("; ")}`);
  }
  if (receipts.length === 0 && problems.length === 0)
    problems.push("the PR body carries no receipt (no ```json verify-receipt block)");
  return {
    passed: false,
    summary: [
      `This PR changes product source, so it owes \`judge\` and \`run-it\` (AGENTS.md, Run a Feature Before It Merges), and its body has no receipt for ${headSha.slice(0, 10)} with both passed.`,
      "",
      ...problems.map((problem) => `- ${problem}`),
      "",
      "On the commit you push, with a clean tree:",
      "",
      "```sh",
      ...FIX,
      "```",
      "",
      "Editing the PR body is enough: this check runs again by itself. A rebase, or a push of only tests or docs, keeps a receipt valid.",
    ].join("\n"),
  };
};

const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });

/** The decision for a PR whose head and base are in this checkout. */
export const evaluate = (root, { pr, headSha, baseSha }) => {
  const mergeBase = git(root, ["merge-base", baseSha, headSha]).trim();
  const files = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--name-only",
    "-z",
    mergeBase,
    headSha,
  ])
    .split("\0")
    .filter(Boolean);
  const map = loadMap(root);
  // The plan decides what is owed: a judge, and the run that follows it.
  const owes = matchObligations(map, files).some(
    (obligation) => obligation.verb === "judge" || obligation.after === "judge",
  );
  return decide({
    pr,
    owes,
    headSha,
    headPatchId: owes
      ? productPatchId(root, mergeBase, headSha, filesOwing(map, files, "judge"))
      : null,
  });
};

/** CI's entry: the PR as the API has it now, the diff from git; prints and summarises. */
export const main = async ({ root, env = process.env }) => {
  const api = env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${api}/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`, {
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`reading #${env.PR_NUMBER}: HTTP ${response.status}`);
  const decision = evaluate(root, {
    pr: await response.json(),
    headSha: env.HEAD_SHA,
    baseSha: env.BASE_SHA,
  });
  const text = `### Verify receipt: ${decision.passed ? "passed" : "missing"}\n\n${decision.summary}\n`;
  process.stdout.write(text);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  if (!decision.passed)
    process.stdout.write(`::error title=Verify receipt::${decision.summary.split("\n")[0]}\n`);
  return decision.passed ? 0 : 1;
};

if (import.meta.main)
  process.exitCode = await main({ root: fileURLToPath(new URL("../../", import.meta.url)) });
