import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, matchesGlob, relative } from "node:path";

import { FLOWS_PATH, flowsThrough, inWebApp, loadFlows } from "./flows.mjs";
import { filesOwing, loadMap } from "./plan.mjs";

// `verify judge`: how a feature is proved is decided by an agent that did not write it. No list of
// paths can say whether a change needs the box or what a person must see, so the author hands the
// brief this verb writes to another agent, unchanged, and records its answer. The brief is built
// from the commit alone: the author adds nothing to it. The answer is tied to the commit and shows
// on the receipt with its reason. `--self` records the author's own answer where no second agent
// can be started, and the receipt says so.
//
// The answer also names the flow of the daily box run that shows the change
// (`.agents/skills/box-main-run/flows.md`), so every feature PR leaves the run a flow to drive
// (SLNT-1050): `flows`, the usual answer; `newFlow`, when no flow reaches it, which is refused
// until the change adds its flow; or `noFlow`, which a change inside some flow's Areas, or in the
// web app, can only give for a feature the Not on the box table lists.

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
  "ifBroken": "what a person would see if the change did not work",
  "flows": ["<flow id>", "..."],
  "newFlow": "<what a person does and sees that no flow covers>, only when no flow does",
  "noFlow": { "notOnTheBox": "<feature>", "reason": "<why no flow can show it>" }
}

Give exactly one of flows, newFlow and noFlow; leave the other two out.`;

const ticks = (names) =>
  names.length === 0 ? "none" : names.map((name) => `\`${name}\``).join(", ");

/** The brief for the judging agent. Nothing in it comes from the change's author. */
export const briefFor = ({ head, files, limits, floor, flows = [], notOnTheBox = [] }) =>
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
    "## 3. Which flow shows it on the box",
    "",
    `Every day an agent that wrote none of this drives the flows in \`${FLOWS_PATH}\` on our`,
    "preview server. Name the flows that will show this change there, by their `### <id>`",
    "heading. Read the entries you name: their Do, See and Areas lines. Decide in this order:",
    "",
    "1. `flows`: a flow whose See line shows what this change does, or whose Areas hold the files",
    "   it changes, so the run would catch it going wrong. A refactor or a fix names the flow that",
    "   passes through it.",
    "2. `newFlow`: what a person can now do or see that no flow's See line reaches, in one",
    "   sentence. The change then has to add that flow before it can be recorded.",
    "3. `noFlow`, only when neither applies: a client the preview cannot drive (name its row of",
    "   the Not on the box table in `notOnTheBox`), or code no person meets through Mend at all.",
    "   Say which in `reason`. It is refused for a change inside some flow's Areas, or in the web",
    "   app (`apps/web/`, `packages/ui/`), unless it names a Not on the box row.",
    "",
    `Flows at this commit: ${ticks(flows.map((flow) => flow.id))}.`,
    "",
    `Not on the box: ${ticks(notOnTheBox)}.`,
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

const listed = (names) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`;

/**
 * Every way the answer's flow departs from flows.md at this commit. `files` are the changed files
 * that owe a judgement.
 */
export const flowErrors = (answer, { flows = [], notOnTheBox = [], files = [], sha = "" }) => {
  const given = ["flows", "newFlow", "noFlow"].filter((key) => answer[key] != null);
  if (given.length !== 1)
    return ["name the flow that covers this change: flows, newFlow or noFlow, exactly one"];
  const at = `${FLOWS_PATH} at ${sha.slice(0, 10)}`;
  if (answer.newFlow != null)
    return isText(answer.newFlow)
      ? [
          `the judge says no flow covers this change (${answer.newFlow.trim()}): add its flow to ${FLOWS_PATH} in this change, and judge the new commit`,
        ]
      : ["newFlow says in one sentence what no flow covers"];
  if (answer.flows != null) {
    if (!Array.isArray(answer.flows) || answer.flows.length === 0 || !answer.flows.every(isText))
      return ["flows lists one or more flow ids"];
    const ids = new Set(flows.map((flow) => flow.id));
    return answer.flows
      .filter((id) => !ids.has(id.trim()))
      .map(
        (id) =>
          `flow "${id}" is not in ${at}: name a flow there by its "### <id>" heading, or add the flow to flows.md in this change and judge the new commit`,
      );
  }
  const { noFlow } = answer;
  if (typeof noFlow !== "object" || Array.isArray(noFlow) || !isText(noFlow.reason))
    return ['noFlow is { "notOnTheBox"?: "<feature>", "reason": "…" }'];
  if (noFlow.notOnTheBox != null)
    return notOnTheBox.includes(noFlow.notOnTheBox)
      ? []
      : [
          `"${noFlow.notOnTheBox}" is not a row of the Not on the box table in ${at}; its rows: ${notOnTheBox.join(", ")}`,
        ];
  const errors = [];
  const crossed = [...new Set(files.flatMap((file) => flowsThrough(flows, file).map((f) => f.id)))];
  if (crossed.length > 0)
    errors.push(
      `noFlow is refused: this change is inside the Areas of ${crossed.length} flow${crossed.length === 1 ? "" : "s"} (${listed(crossed)}); name the one that shows it, or the Not on the box row in notOnTheBox`,
    );
  const web = files.filter(inWebApp);
  if (web.length > 0)
    errors.push(
      `noFlow is refused for the web app (${listed(web)}): name the flow for the same feature, or answer newFlow`,
    );
  return errors;
};

/** Every way an answer departs from what the brief asks; empty when it can be recorded. */
export const validateAnswer = (answer, { limits, floor, ...flowFacts }) => {
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
  return [...errors, ...flowErrors(answer, flowFacts)];
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

/**
 * The flow part of a judgement, in words; empty for one recorded before flows were named. A
 * judgement recorded before cut-over (SLNT-1253) may say its flows show on the box only after it.
 */
export const flowWords = (judgement) => {
  if (Array.isArray(judgement.flows))
    return `${judgement.flows.length === 1 ? "flow" : "flows"} ${judgement.flows.join(", ")}${
      judgement.flowsOnTheBox === "after cut-over" ? ", on the box after cut-over" : ""
    }`;
  if (judgement.noFlow)
    return `no flow${judgement.noFlow.notOnTheBox ? ` (not on the box: ${judgement.noFlow.notOnTheBox})` : ""}: ${judgement.noFlow.reason}`;
  return "";
};

/** One line for the receipt: where, who judged, why, and the flow that shows it on the box. */
export const judgementLine = (judgement) => {
  const flow = flowWords(judgement);
  return `Run on ${whereWords(judgement)}, judged by ${
    judgement.judgedBy === "self" ? "the author" : "another agent"
  }: ${judgement.reason}${flow === "" ? "" : ` Box run: ${flow}.`}`;
};

/** The flow fields a judgement keeps. */
const flowOf = (answer) => {
  if (answer.noFlow != null)
    return {
      noFlow: {
        ...(answer.noFlow.notOnTheBox != null ? { notOnTheBox: answer.noFlow.notOnTheBox } : {}),
        reason: answer.noFlow.reason.trim(),
      },
    };
  return { flows: answer.flows.map((id) => id.trim()) };
};

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
  const { flows, notOnTheBox } = loadFlows(root);
  const owing = filesOwing(loadMap(root), files, "judge");
  const dir = join(root, ".verify/judge", head.sha.slice(0, 12));
  const briefPath = relative(root, join(dir, "brief.md"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "brief.md"),
    briefFor({ head, files, limits, floor, flows, notOnTheBox }),
  );
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
  const facts = { limits, floor, flows, notOnTheBox, files: owing, sha: head.sha };
  const errors = validateAnswer(answer, facts);
  if (errors.length > 0) return step("failed", errors.join("; "), { evidence });
  const judgement = {
    where: answer.where,
    ...(answer.where === "box" ? { limit: answer.limit } : {}),
    reason: answer.reason.trim(),
    mustSee: answer.mustSee.map((line) => line.trim()),
    ifBroken: answer.ifBroken.trim(),
    judgedBy: self ? "self" : "agent",
    ...flowOf(answer),
  };
  writeFileSync(join(dir, "answer.json"), `${JSON.stringify(judgement, null, 2)}\n`);
  return step("passed", judgementLine(judgement), {
    judgement,
    evidence: [...evidence, { kind: "answer", path: relative(root, join(dir, "answer.json")) }],
  });
};
