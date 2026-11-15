import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";

// `verify judge`: how a feature is proved is decided by an agent that did not write it. No list of
// paths can say whether a change needs the box or what a person must see, so the author hands the
// brief this verb writes to another agent, unchanged, and records its answer. The brief is built
// from the commit alone: the author adds nothing to it. The answer is tied to the commit and shows
// on the receipt with its reason. `--self` records the author's own answer where no second agent
// can be started, and the receipt says so.

export const loadLimits = (root) =>
  JSON.parse(readFileSync(join(root, "tooling/verify/local-stack-limits.json"), "utf8")).limits;

/** The limits a changed file names outright: the judge cannot answer `local` for these. */
export const floorOf = (limits, files) =>
  limits.flatMap((limit) => {
    const hit = files.filter((file) => (limit.paths ?? []).some((glob) => matchesGlob(file, glob)));
    return hit.length > 0 ? [{ id: limit.id, files: hit }] : [];
  });

const ANSWER_SHAPE = `{
  "where": "local" or "box",
  "limit": "<the id from the list above>, only when where is box",
  "reason": "one or two sentences: what in the diff decides it",
  "mustSee": ["three to five observations"],
  "ifBroken": "what a person would see if the change did not work"
}`;

/** The brief for the judging agent. Nothing in it comes from the change's author. */
export const briefFor = ({ head, files, limits, floor }) =>
  [
    "# Judge how this change must be proved",
    "",
    "You did not write this change, and you are not asked whether it is good. Decide two things:",
    "where it has to be run to be seen working, and what a person must see there. Its author then",
    "produces exactly that evidence. Do not run the product, and do not edit anything.",
    "",
    "Read the change itself, not anyone's description of it:",
    "",
    "```sh",
    `git diff ${head.mergeBase}..${head.sha}`,
    "```",
    "",
    `Commit \`${head.sha}\` on \`${head.branch}\`, ${files.length} files:`,
    "",
    ...files.slice(0, 60).map((file) => `- \`${file}\``),
    ...(files.length > 60 ? [`- and ${files.length - 60} more`] : []),
    "",
    "## 1. Where",
    "",
    "The author runs it on a local stack: a real Mend built from this commit, on the author's",
    'machine (`.agents/skills/verify/SKILL.md`, "Run it"). That is the answer unless what this',
    "change does can only be seen through one of these, which a local stack cannot show:",
    "",
    ...limits.map((limit) => `- \`${limit.id}\`: ${limit.what}`),
    "",
    "Answer `box`, our preview server, only when you can name which one applies and what in the",
    'diff makes it apply. "It touches sessions" is not a reason. "It changes what a Boat guest',
    'does on resume, and only Boat shows that" is. When you are unsure, answer `local` and say in',
    "`reason` what you were unsure about.",
    ...(floor.length > 0
      ? [
          "",
          ...floor.map(
            (hit) =>
              `This change touches ${hit.files.map((file) => `\`${file}\``).join(", ")}, so the answer is \`box\` with limit \`${hit.id}\`.`,
          ),
        ]
      : []),
    "",
    "## 2. What must be seen",
    "",
    "Three to five observations. Each is something a person does and then sees, in the product's",
    "own words, in the order a person would meet them. Cover the main thing the change is for, one",
    "place it meets something that already existed, and its failure or empty state when it has",
    "one. Then one line: what a person would see if the change did not work.",
    "",
    "Say what to observe, not how to drive it.",
    "",
    "## Answer",
    "",
    "Reply with this JSON and nothing else:",
    "",
    "```json",
    ANSWER_SHAPE,
    "```",
    "",
  ].join("\n");

const isText = (value) => typeof value === "string" && value.trim() !== "";

/** Every way an answer departs from what the brief asks; empty when it can be recorded. */
export const validateAnswer = (answer, { limits, floor }) => {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer))
    return ["the answer is not a JSON object"];
  const errors = [];
  const ids = limits.map((limit) => limit.id);
  if (!["local", "box"].includes(answer.where)) errors.push("where must be local or box");
  if (answer.where === "box" && !ids.includes(answer.limit))
    errors.push(`a box answer names its limit, one of: ${ids.join(", ")}`);
  if (answer.where === "local" && answer.limit != null)
    errors.push("a local answer names no limit");
  for (const hit of floor)
    if (answer.where !== "box")
      errors.push(`${hit.files.join(", ")} can only be shown on the box (${hit.id})`);
  if (!isText(answer.reason)) errors.push("reason is required");
  if (
    !Array.isArray(answer.mustSee) ||
    answer.mustSee.length < 3 ||
    answer.mustSee.length > 5 ||
    !answer.mustSee.every(isText)
  )
    errors.push("mustSee lists three to five observations");
  if (!isText(answer.ifBroken)) errors.push("ifBroken is required");
  return errors;
};

/** The judgement recorded for exactly this commit, or null. */
export const readJudgement = (root, head) => {
  const path = join(root, ".verify/latest/judge.json");
  if (!existsSync(path)) return null;
  const result = JSON.parse(readFileSync(path, "utf8"));
  return result.head?.sha === head.sha && !result.head.dirty && result.judgement
    ? result.judgement
    : null;
};

const whereWords = (judgement) =>
  judgement.where === "box" ? `the box (${judgement.limit})` : "a local stack";

/** One line for the receipt: where, who judged, and why. */
export const judgementLine = (judgement) =>
  `Run on ${whereWords(judgement)}, judged by ${
    judgement.judgedBy === "self" ? "the author" : "another agent"
  }: ${judgement.reason}`;

export const judge = (root, { head, files, owed, record, self }) => {
  const step = (status, detail, extra = {}) => ({
    steps: [{ id: "judge", title: "How this change must be proved", status, detail }],
    next: [],
    ...extra,
  });
  if (!owed) return step("passed", "this change owes no run, so there is nothing to judge");
  if (head.dirty)
    return step("blocked_by_prerequisite", "commit first: a judgement is about one commit", {
      next: ["git status --short"],
    });
  const limits = loadLimits(root);
  const floor = floorOf(limits, files);
  const dir = join(root, ".verify/judge", head.sha.slice(0, 12));
  const briefPath = relative(root, join(dir, "brief.md"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "brief.md"), briefFor({ head, files, limits, floor }));
  const evidence = [{ kind: "brief", path: briefPath }];

  if (record === undefined) {
    const already = readJudgement(root, head);
    if (already) return step("passed", judgementLine(already), { judgement: already, evidence });
    return step(
      "requires_external_observer",
      `give ${briefPath} unchanged to an agent that did not write this change, save its JSON answer to a file, and record it`,
      { evidence, next: ["pnpm verify judge --record <answer.json>"] },
    );
  }

  let answer;
  try {
    answer = JSON.parse(readFileSync(record, "utf8"));
  } catch (error) {
    return step("failed", `${record} is not readable JSON: ${error.message}`, { evidence });
  }
  const errors = validateAnswer(answer, { limits, floor });
  if (errors.length > 0) return step("failed", errors.join("; "), { evidence });
  const judgement = {
    where: answer.where,
    ...(answer.where === "box" ? { limit: answer.limit } : {}),
    reason: answer.reason.trim(),
    mustSee: answer.mustSee.map((line) => line.trim()),
    ifBroken: answer.ifBroken.trim(),
    judgedBy: self ? "self" : "agent",
  };
  writeFileSync(join(dir, "answer.json"), `${JSON.stringify(judgement, null, 2)}\n`);
  return step("passed", judgementLine(judgement), {
    judgement,
    evidence: [...evidence, { kind: "answer", path: relative(root, join(dir, "answer.json")) }],
  });
};
