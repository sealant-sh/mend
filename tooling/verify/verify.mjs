#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { runCheck } from "./check.mjs";
import { planSteps } from "./plan.mjs";
import {
  createResult,
  exitCode,
  readHead,
  saveResult,
  UsageError,
  validateResult,
} from "./result.mjs";
import { statusSteps, toMarkdown } from "./status.mjs";

// `pnpm verify <verb>`: one JSON result per run (TOOLKIT-SPEC.md). Progress goes to stderr; with
// --json, stdout carries the result and nothing else.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const VERBS = {
  plan: "What this change owes, and which CI jobs it runs",
  check:
    "The pre-PR gate: forced typecheck and lint, affected tests with no unallowed skip, format",
  status: "For each obligation, whether a passing result exists for this exact commit",
};

// Verbs the shared contract names that this repo does not have yet: they say so, never pretend.
const PLANNED = {
  box: "Box-check setup: plan, prepare, cli, identity",
  stack: "A local Mend that is ready when usable: up, status, down",
  health: "From where the server is and is not reachable",
  drive: "Run a recipe against web, TUI, desktop, mobile-web, VS Code or T3",
  evidence: "Gather screenshots and transcripts, scan for secrets, write the verdict file",
  formal: "Run the models whose covered paths the diff touches, and report drift",
};

export const parseArgs = (argv) => {
  const options = {
    json: false,
    markdown: false,
    all: false,
    base: "origin/main",
    files: undefined,
  };
  const words = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") options.json = true;
    else if (arg === "--markdown") options.markdown = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--concurrency") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1)
        throw new UsageError("--concurrency needs a whole number");
      options.concurrency = value;
    } else if (arg === "--base") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError("--base needs a ref");
      options.base = value;
    } else if (arg === "--files") {
      options.files = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--"))
        options.files.push(argv[++index]);
      if (options.files.length === 0) throw new UsageError("--files needs at least one path");
    } else if (arg.startsWith("--")) throw new UsageError(`Unknown option ${arg}`);
    else words.push(arg);
  }
  return { words, options };
};

const help = () =>
  [
    "pnpm verify <verb> [options]   (--json prints only the result on stdout)",
    "",
    ...Object.entries(VERBS).map(([verb, line]) => `  ${verb.padEnd(9)} ${line}`),
    ...Object.entries(PLANNED).map(
      ([verb, line]) => `  ${verb.padEnd(9)} ${line} (not implemented yet)`,
    ),
    "",
    "Options: --base <ref> (default origin/main), --files <paths…> (plan), --all and",
    "--concurrency <n> (check: turbo tasks and Vitest workers), --markdown (status). Results: .verify/latest/<verb>.json. Exit: 0 passed, 1 failed,",
    "2 usage, 3 blocked by a prerequisite, 4 any other status.",
  ].join("\n");

const stampOf = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Builds a verb's result without saving or printing it. */
export const runVerb = async (root, verb, options, startedAt = new Date()) => {
  const head = readHead(root, options.base);
  if (verb === "plan") {
    const { plan, steps, next } = planSteps(root, { head, files: options.files });
    return createResult({
      verb,
      head,
      startedAt,
      steps,
      obligations: plan?.obligations ?? [],
      next: [...new Set(next)],
      ...(plan ? { ci: plan.ci, files: plan.files } : {}),
    });
  }
  if (verb === "check") {
    const { steps, next, plan, reportDir } = await runCheck(root, {
      head,
      all: options.all,
      concurrency: options.concurrency,
      stamp: stampOf(startedAt),
      ...(options.env ? { env: options.env } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
    });
    return createResult({
      verb,
      head,
      startedAt,
      steps,
      obligations: plan.obligations,
      evidence: steps
        .flatMap((step) => (step.log ? [{ kind: "log", path: step.log }] : []))
        .concat(reportDir ? [{ kind: "test-reports", path: reportDir }] : []),
      next: [...new Set(next)],
    });
  }
  if (verb === "status") {
    const { plan, steps, next } = statusSteps(root, {
      head,
      implemented: new Set(Object.keys(VERBS)),
    });
    return createResult({
      verb,
      head,
      startedAt,
      steps,
      obligations: plan.obligations.map((obligation, index) => ({
        ...obligation,
        status: steps[index].status === "passed" ? "discharged" : "owed",
      })),
      evidence: steps.flatMap((step) => (step.log ? [{ kind: "result", path: step.log }] : [])),
      next,
    });
  }
  return createResult({
    verb,
    head,
    startedAt,
    steps: [{ id: verb, title: PLANNED[verb], status: "not_implemented" }],
  });
};

const summary = (result) =>
  [
    `verify ${result.verb}: ${result.status} (${result.head.sha.slice(0, 10)}${result.head.dirty ? ", dirty" : ""})`,
    ...result.steps.map(
      (step) => `  ${step.status.padEnd(26)} ${step.id}${step.detail ? `: ${step.detail}` : ""}`,
    ),
    ...(result.obligations.length > 0
      ? [
          "obligations:",
          ...result.obligations.map(
            (o) => `  ${o.status.padEnd(10)} ${o.id}${o.command ? `: ${o.command}` : ""}`,
          ),
        ]
      : []),
    ...(result.ci
      ? [
          `CI runs: ${result.ci
            .filter((job) => job.runs)
            .map((job) => job.job)
            .join(", ")}`,
        ]
      : []),
    ...(result.next.length > 0 ? ["next:", ...result.next.map((command) => `  ${command}`)] : []),
  ].join("\n");

export const main = async (argv, root = repoRoot) => {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${help()}\n`);
    return 2;
  }
  const { words, options } = parsed;
  const [verb] = words;
  if (verb === undefined || verb === "help") {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  if (!(verb in VERBS) && !(verb in PLANNED)) {
    process.stderr.write(`Unknown verb ${verb}\n\n${help()}\n`);
    return 2;
  }
  const startedAt = new Date();
  const result = await runVerb(root, verb, options, startedAt);
  const errors = validateResult(result);
  if (errors.length > 0)
    throw new Error(`verify ${verb} built an invalid result: ${errors.join("; ")}`);
  const file = saveResult(root, result);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (verb === "status" && options.markdown) process.stdout.write(toMarkdown(result));
  else process.stdout.write(`${summary(result)}\n`);
  process.stderr.write(`verify ${verb}: result in ${file.slice(root.length)}\n`);
  return exitCode(result.status);
};

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
