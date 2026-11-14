#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import {
  boxCli,
  boxIdentity,
  boxPlan,
  boxPrepare,
  boxRelease,
  checkTag,
  sshRunner,
} from "./box.mjs";
import { runCheck } from "./check.mjs";
import { health, VANTAGES } from "./health.mjs";
import { planSteps } from "./plan.mjs";
import {
  createResult,
  exitCode,
  readHead,
  saveResult,
  UsageError,
  validateResult,
} from "./result.mjs";
import { stackDown, stackStatus, stackUp } from "./stack.mjs";
import { statusSteps, toMarkdown } from "./status.mjs";

// `pnpm verify <verb>`: one JSON result per run (TOOLKIT-SPEC.md). Progress goes to stderr; with
// --json, stdout carries the result and nothing else.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const VERBS = {
  plan: "What this change owes, and which CI jobs it runs",
  check:
    "The pre-PR gate: forced typecheck and lint, affected tests with no unallowed skip, format",
  status: "For each obligation, whether a passing result exists for this exact commit",
  box: "Box-check setup: plan, prepare, cli, identity, release (--yes to change the box)",
  health: "From where the server is and is not reachable: --from local,host,workspace",
  stack: "A Mend stack in an outer session, ready when usable: up, status, down",
};

const STACK = ["up", "status", "down"];

const BOX = ["plan", "prepare", "cli", "identity", "release"];

// Verbs the shared contract names that this repo does not have yet: they say so, never pretend.
const PLANNED = {
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
    else if (arg === "--yes") options.yes = true;
    else if (["--mend", "--sealant", "--sealantd"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} needs a source`);
      (options.sources ??= []).push(arg, value);
    } else if (["--expect-mend", "--expect-sealant", "--expect-sealantd"].includes(arg)) {
      const value = argv[++index];
      if (!/^[0-9a-f]{4,40}$/.test(value ?? ""))
        throw new UsageError(`${arg} needs a commit prefix`);
      (options.expect ??= {})[arg.slice("--expect-".length)] = value;
    } else if (arg === "--port") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535)
        throw new UsageError("--port needs a port from 1024 to 65535");
      options.port = value;
    } else if (arg === "--project") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError("--project needs a name");
      options.project = value;
    } else if (arg === "--url" || arg === "--expect-version") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      options[arg === "--url" ? "url" : "expectVersion"] = value;
    } else if (arg === "--from") {
      const value = (argv[++index] ?? "").split(",").filter(Boolean);
      if (value.length === 0 || value.some((from) => !VANTAGES.includes(from)))
        throw new UsageError(`--from takes a list of ${VANTAGES.join(", ")}`);
      options.from = value;
    } else if (arg === "--ssh") {
      const value = argv[++index];
      if (!value) throw new UsageError("--ssh needs the ssh arguments that reach the box");
      options.ssh = value;
    } else if (arg === "--pr") {
      const value = argv[++index];
      if (!/^\d+$/.test(value ?? "")) throw new UsageError("--pr needs a pull request number");
      options.pr = value;
    } else if (arg === "--concurrency") {
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
    "--concurrency <n> (check: turbo tasks and Vitest workers), --markdown (status),",
    "--ssh <args> or MEND_VERIFY_BOX_SSH, --pr <n>, --yes (box), --url, --from,",
    "--expect-version (health), --port, --project, --mend|--sealant|--sealantd <source>,",
    "--expect-mend|sealant|sealantd <sha> (stack). Results:",
    ".verify/latest/<verb>.json. Exit: 0 passed, 1 failed, 2 usage, 3 blocked by a",
    "prerequisite, 4 any other status.",
  ].join("\n");

const stampOf = (date) =>
  date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

/** Builds a verb's result without saving or printing it. */
export const runVerb = async (root, verb, options, startedAt = new Date()) => {
  const head = readHead(root, options.base);
  if (verb === "stack") {
    const shared = {
      ...(options.exec ? { exec: options.exec } : {}),
      ...(options.env ? { env: options.env } : {}),
      expect: options.expect ?? {},
    };
    const { steps, next, ...rest } = await {
      up: () =>
        stackUp(root, {
          ...shared,
          ...(options.port ? { port: options.port } : {}),
          ...(options.project ? { project: options.project } : {}),
          sources: options.sources ?? [],
          ...(options.wait ? { wait: options.wait } : {}),
        }),
      status: () => stackStatus(root, shared),
      down: () => stackDown(root, shared),
    }[options.subverb]();
    return createResult({
      verb: `stack ${options.subverb}`,
      head,
      startedAt,
      steps,
      next,
      ...rest,
    });
  }
  if (verb === "health") {
    const sshArgs = options.ssh ?? process.env.MEND_VERIFY_BOX_SSH;
    const ssh = options.sshRunner ?? (sshArgs ? sshRunner(sshArgs.trim().split(/\s+/)) : null);
    const { steps, next, ...rest } = await health({
      url: options.url,
      from: options.from ?? VANTAGES,
      ssh,
      expectVersion: options.expectVersion,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    return createResult({ verb, head, startedAt, steps, next, ...rest });
  }
  if (verb === "box") {
    const sshArgs = options.ssh ?? process.env.MEND_VERIFY_BOX_SSH;
    const ssh = options.sshRunner ?? (sshArgs ? sshRunner(sshArgs.trim().split(/\s+/)) : null);
    const tag = checkTag(options.pr, head);
    const context = { head, ssh, tag, yes: options.yes === true, stamp: stampOf(startedAt) };
    const { steps, next, ...rest } = {
      plan: () => boxPlan(root, context),
      prepare: () => boxPrepare(root, context),
      cli: () => boxCli(root, { ...context, ...(options.run ? { run: options.run } : {}) }),
      identity: () => boxIdentity(root, context),
      release: () => boxRelease(context),
    }[options.subverb]();
    return createResult({ verb: `box ${options.subverb}`, head, startedAt, steps, next, ...rest });
  }
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
  if (verb === "box") {
    if (!BOX.includes(words[1])) {
      process.stderr.write(`verify box needs one of: ${BOX.join(", ")}\n`);
      return 2;
    }
    options.subverb = words[1];
  }
  if (verb === "stack") {
    if (!STACK.includes(words[1])) {
      process.stderr.write(`verify stack needs one of: ${STACK.join(", ")}\n`);
      return 2;
    }
    options.subverb = words[1];
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
