#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DATA_PATH,
  boxCli,
  boxIdentity,
  boxPlan,
  boxPrepare,
  boxRelease,
  checkTag,
  sshRunner,
} from "./box.mjs";
import { runCheck } from "./check.mjs";
import { drive, SURFACES } from "./drive.mjs";
import { evidence } from "./evidence.mjs";
import { formalSteps } from "./formal.mjs";
import { health, VANTAGES } from "./health.mjs";
import { judge, readJudgement } from "./judge.mjs";
import { changedFiles, planSteps } from "./plan.mjs";
import { readPullRequest, receiptSteps } from "./receipt.mjs";
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
import { vmBuild, vmDown, vmList, vmSave, vmSlot, vmUp } from "./vm.mjs";

// `pnpm verify <verb>`: one JSON result per run (TOOLKIT-SPEC.md). Progress goes to stderr; with
// --json, stdout carries the result and nothing else.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const VERBS = {
  plan: "What this change owes, and which CI jobs it runs",
  check:
    "The pre-PR gate: forced typecheck and lint, affected tests with no unallowed skip, format",
  status: "For each obligation, whether a passing result exists for this exact commit",
  receipt: "Read back the receipt a PR body carries: --pr <n>, or --body <file>",
  judge:
    "Write the brief another agent answers: where to run this change and what must be seen (--record <answer.json>, --self)",
  box: "Set up the preview server for a check on it: plan, prepare, cli, identity, release, which tidies it (--yes to change it)",
  health: "From where the server is and is not reachable: --from local,host,workspace",
  stack: "A Mend stack in an outer session, ready when usable: up, status, down",
  drive:
    "Run a recipe against web, the new web app (new-web, or --box: against the box's API), desktop, mobile-web, vscode or t3, a CLI batch (cli), or record drive-tui.sh's captures (tui): --recipe <name|path>",
  evidence: "Gather this head's drives, scan them for secrets, write the verdict file",
  vm: "A throwaway box on this machine per check (KVM): build the master, up a copy (--boat: on a Boat slot's own Funnel), list, down <n>|--all, slot add|remove <n>, save <n> (a copy's data becomes the next master's)",
  formal: "Run the models whose COVERAGE the diff touches (--all, --full), guard and report drift",
};

const STACK = ["up", "status", "down"];

const BOX = ["plan", "prepare", "cli", "identity", "release"];

const VM = ["build", "up", "down", "list", "slot", "save"];

// Verbs the shared contract names that this repo does not have yet: they say so, never pretend.
// Verbs the shared contract names for the other Sealant repos: here they say so, never pretend.
const PLANNED = {
  db: "Throwaway Postgres with every gated suite switched on (sealant)",
  runtime: "Drive a workspace runtime end to end (sealant)",
  daemon: "A sealantd on a socket, driven by a script (sealantd)",
  "boat-harness": "Preflight and status of the Boat harness (sealant)",
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
    else if (arg === "--full") options.full = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--no-restore") options.noRestore = true;
    else if (arg === "--box") options.box = true;
    else if (arg === "--boat") options.boat = true;
    else if (arg === "--self") options.self = true;
    else if (arg === "--body") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError("--body needs a file");
      options.body = value;
    } else if (arg === "--record") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError("--record needs the answer file");
      options.record = value;
    } else if (arg === "--recipe") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError("--recipe needs a name or a path");
      options.recipe = value;
    } else if (arg === "--timeout") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1)
        throw new UsageError("--timeout needs milliseconds");
      options.timeoutMs = value;
    } else if (["--mend", "--sealant", "--sealantd"].includes(arg)) {
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
    } else if (["--version", "--sha", "--cli", "--from-box", "--memory"].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      options[
        {
          "--version": "vmVersion",
          "--sha": "vmSha",
          "--cli": "vmCli",
          "--from-box": "fromBox",
          "--memory": "memory",
        }[arg]
      ] = value;
    } else if (arg === "--cpus") {
      const value = Number(argv[++index]);
      if (!Number.isInteger(value) || value < 1)
        throw new UsageError("--cpus needs a whole number");
      options.cpus = value;
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
    } else if (arg === "--tag") {
      const value = argv[++index];
      if (!/^[a-z][a-z0-9-]{0,39}$/.test(value ?? "") || /^(pr\d|sha-)/.test(value))
        throw new UsageError("--tag needs a name such as main-<sha12>, not pr<n> or sha-<sha>");
      options.tag = value;
    } else if (arg === "--load" || arg === "--save") {
      const value = argv[++index];
      if (!DATA_PATH.test(value ?? ""))
        throw new UsageError(
          `${arg} needs a .sql path under /root, such as /root/main-run/world.sql`,
        );
      options[arg.slice(2)] = value;
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
  if (options.pr !== undefined && options.tag !== undefined)
    throw new UsageError("--pr and --tag both name the check: pass one");
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
    "--concurrency <n> (check: turbo tasks and Vitest workers), --full (formal), --markdown (status),",
    "--record <answer.json> and --self (judge), --pr <n> or --body <file> (receipt),",
    "--ssh <args> or MEND_VERIFY_BOX_SSH, --pr <n> or --tag <name>, --yes, --no-restore, --load <dump>",
    "(plan, prepare) and --save <dump> (release) (box),",
    "--url, --from,",
    "--expect-version (health), --port, --project, --mend|--sealant|--sealantd <source>,",
    "--expect-mend|sealant|sealantd <sha> (stack), --recipe, --timeout <ms>, --box (drive). Results:",
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
  if (verb === "formal") {
    const files =
      options.files ?? (head.mergeBase === null ? [] : changedFiles(root, head.mergeBase));
    const steps = await formalSteps(root, {
      files,
      base: head.mergeBase,
      head: head.sha,
      all: options.all,
      full: options.full === true,
      logs: join(root, ".verify/logs"),
      ...(options.env ? { env: options.env } : {}),
      ...(options.run ? { run: options.run } : {}),
    });
    return createResult({
      verb,
      head,
      startedAt,
      steps,
      evidence: steps.flatMap((step) => (step.log ? [{ kind: "log", path: step.log }] : [])),
      next: steps.some((step) => step.status === "blocked_by_prerequisite")
        ? [
            (options.env ?? process.env).MEND_FORMAL_ENGINE === "tlc"
              ? "nix develop, or install java and curl (check.sh fetches its pinned tla2tools)"
              : "install cargo (rustup.rs) or Nix: check.sh builds its pinned tlx with either (docs/formal/tlx.sh)",
          ]
        : [],
    });
  }
  if (verb === "drive") {
    const sshArgs = options.ssh ?? process.env.MEND_VERIFY_BOX_SSH;
    const { steps, next, ...rest } = await drive(root, {
      surface: options.subverb,
      recipe: options.recipe,
      head,
      timeoutMs: options.timeoutMs,
      box: options.box === true,
      ssh: options.sshRunner ?? (sshArgs ? sshRunner(sshArgs.trim().split(/\s+/)) : null),
      ...(options.env ? { env: options.env } : {}),
      ...(options.exec ? { exec: options.exec } : {}),
      ...(options.background ? { background: options.background } : {}),
    });
    return createResult({
      verb: `drive ${options.subverb}`,
      head,
      startedAt,
      steps,
      next,
      ...rest,
    });
  }
  if (verb === "evidence") {
    const receipt = statusSteps(root, { head, implemented: new Set(Object.keys(VERBS)) });
    // Every obligation but the one this verb discharges: its line would describe the last run.
    const statusLines = receipt.steps
      .filter((_, index) => receipt.plan.obligations[index].verb !== verb)
      .map((step) => `- \`${step.id}\`: ${step.status}`);
    const { steps, next, ...rest } = await evidence(root, {
      head,
      statusLines,
      judgement: readJudgement(root, head),
      ...(options.env ? { env: options.env } : {}),
      ...(options.exec ? { exec: options.exec } : {}),
    });
    return createResult({ verb, head, startedAt, steps, next, ...rest });
  }
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
    const tag = checkTag(options.pr, head, options.tag);
    const context = {
      head,
      ssh,
      tag,
      yes: options.yes === true,
      stamp: stampOf(startedAt),
      ...(options.load === undefined ? {} : { load: options.load }),
    };
    const { steps, next, ...rest } = {
      plan: () => boxPlan(root, context),
      prepare: () => boxPrepare(root, context),
      cli: () => boxCli(root, { ...context, ...(options.run ? { run: options.run } : {}) }),
      identity: () => boxIdentity(root, context),
      release: () =>
        boxRelease({
          ...context,
          root,
          noRestore: options.noRestore === true,
          ...(options.save === undefined ? {} : { save: options.save }),
          ...(options.readMain ? { readMain: options.readMain } : {}),
          ...(options.front ? { front: options.front } : {}),
        }),
    }[options.subverb]();
    return createResult({ verb: `box ${options.subverb}`, head, startedAt, steps, next, ...rest });
  }
  if (verb === "vm") {
    const sizing = {
      ...(options.cpus ? { cpus: options.cpus } : {}),
      ...(options.memory ? { memory: options.memory } : {}),
    };
    const { steps, next, ...rest } = await {
      build: () =>
        vmBuild({
          version: options.vmVersion,
          sha: options.vmSha,
          cliVersion: options.vmCli,
          fromBox: options.fromBox,
          ...sizing,
        }),
      up: () => vmUp({ ...sizing, boat: options.boat === true }),
      down: () => vmDown({ slot: options.slot, all: options.all }),
      list: () => vmList({}),
      slot: () => vmSlot({ action: options.slotAction, slot: options.slot }),
      save: () => vmSave({ repoRoot: root, slot: options.slot }),
    }[options.subverb]();
    return createResult({ verb: `vm ${options.subverb}`, head, startedAt, steps, next, ...rest });
  }
  if (verb === "receipt") {
    const pr = options.pr ? (options.readPr ?? readPullRequest)(root, options.pr) : null;
    const { steps, next, receipts } = receiptSteps({
      body: pr ? pr.body : readFileSync(options.body, "utf8"),
      source: pr ? `#${pr.number}` : options.body,
    });
    return createResult({
      verb,
      head,
      startedAt,
      steps,
      next,
      receipts,
      ...(pr ? { pullRequest: { number: pr.number, url: pr.url, headSha: pr.headRefOid } } : {}),
    });
  }
  if (verb === "judge") {
    const { plan } = planSteps(root, { head, files: undefined });
    const { steps, next, ...rest } = judge(root, {
      head,
      files: plan?.files ?? [],
      owed: (plan?.obligations ?? []).some((obligation) => obligation.verb === "judge"),
      record: options.record,
      self: options.self === true,
    });
    return createResult({ verb, head, startedAt, steps, next, ...rest });
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
      warnings: steps.flatMap((step) => (step.atRisk ?? []).map((risk) => risk.warning)),
    });
  }
  if (verb === "status") {
    const { plan, steps, next, judgement, productPatchId } = statusSteps(root, {
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
      judgement,
      productPatchId,
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
    ...(result.notApplicable ?? []).map(
      (item) =>
        `  ${"does not apply".padEnd(26)} ${item.id}${item.url ? ` (${item.url}: ${item.seen})` : ""}: ${item.why}`,
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
  if (verb === "vm") {
    if (!VM.includes(words[1])) {
      process.stderr.write(`verify vm needs one of: ${VM.join(", ")}\n`);
      return 2;
    }
    options.subverb = words[1];
    if (words[1] === "slot") {
      options.slotAction = words[2];
      if (/^\d+$/.test(words[3] ?? "")) options.slot = Number(words[3]);
      if (!(words[2] === "add" || (words[2] === "remove" && options.slot !== undefined))) {
        process.stderr.write("verify vm slot needs: add, or remove <n>\n");
        return 2;
      }
    }
    if (words[1] === "down") {
      if (/^\d+$/.test(words[2] ?? "")) options.slot = Number(words[2]);
      else if (!options.all) {
        process.stderr.write("verify vm down needs a copy's number, or --all\n");
        return 2;
      }
    }
    if (words[1] === "save") {
      if (/^\d+$/.test(words[2] ?? "")) options.slot = Number(words[2]);
      else {
        process.stderr.write("verify vm save needs a copy's number\n");
        return 2;
      }
    }
  }
  if (verb === "drive") {
    if (!SURFACES.includes(words[1]) || !options.recipe) {
      process.stderr.write(`verify drive <${SURFACES.join("|")}> --recipe <name|path>\n`);
      return 2;
    }
    options.subverb = words[1];
  }
  if (verb === "receipt" && (options.pr === undefined) === (options.body === undefined)) {
    process.stderr.write("verify receipt needs one of --pr <n> or --body <file>\n");
    return 2;
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
