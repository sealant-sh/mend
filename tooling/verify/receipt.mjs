import { execFileSync } from "node:child_process";

import { flowWords } from "./judge.mjs";
import { STATUSES } from "./result.mjs";

// The receipt a PR body carries: `pnpm verify status --markdown` prints it, `readReceipts` reads it
// back. A person reads the lines; a script reads the JSON block under them, which holds the same
// facts exactly. The JSON block is a contract (SLNT-1049, SLNT-1050): add fields, never rename or
// drop one without raising RECEIPT_VERSION.
//
//   ```json verify-receipt
//   { "receipt": 1, "sha": "<40 hex>", "dirty": false, "mergeBase": "<sha>" | null,
//     "productPatchId": "<git patch-id --stable>" | null,
//     "lines": [{ "id": "judge", "status": "passed" }, …],
//     "judgement": null | { "where": "local" | "box", "limit"?: "<id>", "reason": "…",
//                           "mustSee": ["…"], "ifBroken": "…", "judgedBy": "agent" | "self",
//                           "flows"?: ["<flow id>"], "flowsOnTheBox"?: "after cut-over",
//                           "noFlow"?: { "notOnTheBox"?: "<feature>", "reason": "…" } } }
//   ```
//
// `productPatchId` is the patch id of the diff, merge base to `sha`, of only the files that make
// the change owe a judgement: a rebase, or a push that touches only tests or docs, keeps it.
// `flows`, `flowsOnTheBox` and `noFlow` came with SLNT-1050: a judgement recorded before them has
// none, and still conforms. Nothing writes `flowsOnTheBox` since cut-over (SLNT-1253), when every
// flow runs on every box; a receipt recorded before it still conforms.

export const RECEIPT_VERSION = 1;

const FENCE = "```json verify-receipt";

const git = (root, args, input) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });

/** The patch id of `from..to` restricted to `files`, or null when that diff is empty. */
export const productPatchId = (root, from, to, files) => {
  if (from === null || files.length === 0) return null;
  const diff = git(root, ["diff", "--no-ext-diff", "--no-renames", from, to, "--", ...files]);
  if (diff === "") return null;
  return git(root, ["patch-id", "--stable"], diff).split(" ")[0] || null;
};

/** The data block for a status result: what a script reads back. */
export const receiptOf = (result) => ({
  receipt: RECEIPT_VERSION,
  sha: result.head.sha,
  dirty: result.head.dirty,
  mergeBase: result.head.mergeBase,
  productPatchId: result.productPatchId ?? null,
  lines: result.steps.map((step) => ({ id: step.id, status: step.status })),
  judgement: result.judgement ?? null,
});

const oneLine = (text) => text.replace(/\s+/g, " ").trim();

const whereWords = (judgement) =>
  judgement.where === "box" ? `the box (\`${judgement.limit}\`)` : "a local stack";

/** The judgement as a person reads it in a PR body. */
export const judgementMarkdown = (judgement) => [
  "#### How it must be proved",
  "",
  `- **Where:** ${whereWords(judgement)}`,
  `- **Judged by:** ${judgement.judgedBy === "self" ? "the author (--self)" : "another agent"}`,
  `- **Why:** ${oneLine(judgement.reason)}`,
  "- **Must see:**",
  ...judgement.mustSee.map((line, index) => `  ${index + 1}. ${oneLine(line)}`),
  `- **If it did not work:** ${oneLine(judgement.ifBroken)}`,
  ...(flowWords(judgement) === "" ? [] : [`- **Box run:** ${oneLine(flowWords(judgement))}`]),
  "",
];

/** The fenced block, inside a collapsed section so the body stays readable. */
export const receiptBlock = (result) => [
  "<details><summary>Receipt data (read by CI)</summary>",
  "",
  FENCE,
  // JSON never holds a raw newline, so no value can end the block early.
  JSON.stringify(receiptOf(result), null, 2),
  "```",
  "",
  "</details>",
  "",
];

const isText = (value) => typeof value === "string" && value.trim() !== "";

/** The optional flow fields, when a judgement has them. */
const flowShaped = (judgement) =>
  typeof judgement !== "object" ||
  judgement === null ||
  ((judgement.flows === undefined ||
    (Array.isArray(judgement.flows) && judgement.flows.every(isText))) &&
    [undefined, "after cut-over"].includes(judgement.flowsOnTheBox) &&
    (judgement.noFlow === undefined || isText(judgement.noFlow?.reason)) &&
    !(judgement.flows !== undefined && judgement.noFlow !== undefined));

/** Every way a parsed block departs from the contract; empty when it can be trusted as shaped. */
export const validateReceipt = (data) => {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return ["the block is not a JSON object"];
  const errors = [];
  const need = (condition, message) => {
    if (!condition) errors.push(message);
  };
  need(data.receipt === RECEIPT_VERSION, `receipt must be ${RECEIPT_VERSION}`);
  need(/^[0-9a-f]{40,64}$/.test(data.sha ?? ""), "sha must be a full commit id");
  need(typeof data.dirty === "boolean", "dirty must be a boolean");
  need(data.mergeBase === null || isText(data.mergeBase), "mergeBase is a string or null");
  need(
    data.productPatchId === null || /^[0-9a-f]{40,64}$/.test(data.productPatchId ?? ""),
    "productPatchId is a patch id or null",
  );
  need(
    Array.isArray(data.lines) &&
      data.lines.every((line) => isText(line?.id) && STATUSES.includes(line?.status)),
    "lines lists { id, status }",
  );
  const judgement = data.judgement;
  if (judgement !== null) {
    need(
      typeof judgement === "object" &&
        judgement !== null &&
        ["local", "box"].includes(judgement.where) &&
        (judgement.where === "local" || isText(judgement.limit)) &&
        isText(judgement.reason) &&
        Array.isArray(judgement.mustSee) &&
        judgement.mustSee.every(isText) &&
        isText(judgement.ifBroken) &&
        ["agent", "self"].includes(judgement.judgedBy),
      "judgement is null or { where, limit when box, reason, mustSee, ifBroken, judgedBy }",
    );
    need(flowShaped(judgement), "a judgement names flows or noFlow { reason }, not both");
  }
  return errors;
};

/**
 * Every receipt block in a PR body, in order: `{ receipt }` for one that parses and conforms,
 * `{ errors }` for one that does not. A body with no block gives an empty list.
 */
export const readReceipts = (body) => {
  const found = [];
  const lines = (body ?? "").replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() !== FENCE) continue;
    const end = lines.findIndex((line, at) => at > index && line.trim() === "```");
    if (end === -1) {
      found.push({ errors: ["the block is never closed"] });
      break;
    }
    const text = lines.slice(index + 1, end).join("\n");
    index = end;
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      found.push({ errors: [`the block is not JSON: ${error.message}`] });
      continue;
    }
    const errors = validateReceipt(data);
    found.push(errors.length === 0 ? { receipt: data } : { errors });
  }
  return found;
};

/** A pull request's body and head, through the GitHub CLI. */
export const readPullRequest = (root, number) =>
  JSON.parse(
    execFileSync("gh", ["pr", "view", String(number), "--json", "number,body,headRefOid,url"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );

/** `verify receipt`: the receipts a PR body (or a file holding one) carries, read back. */
export const receiptSteps = ({ body, source }) => {
  const found = readReceipts(body);
  const receipts = found.flatMap((item) => (item.receipt ? [item.receipt] : []));
  const broken = found.flatMap((item) => item.errors ?? []);
  const status = broken.length > 0 ? "failed" : receipts.length === 0 ? "skipped" : "passed";
  return {
    receipts,
    steps: [
      {
        id: "receipt",
        title: `The verify receipt in ${source}`,
        status,
        detail:
          status === "skipped"
            ? "no ```json verify-receipt block: paste pnpm verify status --markdown"
            : status === "failed"
              ? broken.join("; ")
              : receipts.map((receipt) => `for ${receipt.sha.slice(0, 10)}`).join(", "),
      },
    ],
    next: status === "passed" ? [] : ["pnpm verify status --markdown"],
  };
};
