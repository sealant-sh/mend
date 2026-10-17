#!/usr/bin/env node
// The verify skill's CLI evidence for several inner commands at once: one sibling session runs them
// all (`stack.mjs steps`), and each keeps what capture.sh keeps for one command.
//
//   node .claude/skills/verify/scripts/steps.mjs <dir> <batch> --worktree <wt> [--project mend] < steps.json
//
// steps.json is a JSON array of {"name", "cwd", "run"}: `run` is the argv (`mend …`, `git …`,
// `sh -c '…'` for a pipe), `cwd` a directory under the inner account's home (default: the home).
// Each step writes <dir>/<name>.cmd (`cd ~/<cwd> && ` and the argv, shell-quoted as capture.sh
// quotes it), .stdout, .stderr (apart: no terminal folds them) and .exit (the inner command's own
// code). The session itself writes <dir>/<batch>.{cmd,stdout,stderr,exit}: the `mend run`, its
// output with the frames taken out, and Mend's lines with the session id. Every file is redacted
// as capture.sh redacts (redact.mjs, with the run's registry and --register-minted). The raw output
// only ever exists in a private temporary directory, removed before this exits.
//
// It prints `<name> · exit <code>` per step and exits 0 when the session ran every step and its
// output carried every result in full; 1 when a result is missing or cut short (each missing step
// said), a frame line fits no step, or `mend run` failed; 2 on a usage error. A step's earlier
// files are removed first, so a missing result never leaves an older attempt's in its place. A step's own failure is its .exit, not this exit code. `mend` is the first one on PATH.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isStepName, parseSteps, readStepFrames } from "../../../../scripts/verify-stack/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};
const [dir, batch] = args;
const worktree = flag("worktree");
const project = flag("project", "mend");
const usage = (why) => {
  process.stderr.write(
    `steps.mjs: ${why}\nusage: steps.mjs <dir> <batch> --worktree <wt> [--project p] < steps.json\n`,
  );
  process.exit(2);
};
if (!dir || !batch || dir.startsWith("--") || batch.startsWith("--") || !worktree)
  usage("a directory, a batch name and --worktree are needed");
let steps;
try {
  steps = parseSteps(readFileSync(0, "utf8"));
} catch (error) {
  usage(error.message);
}
if (!isStepName(batch)) usage("the batch name must be a file name, as a step's is");
if (steps.some((step) => step.name === batch)) usage(`the batch and a step are both ${batch}`);
// The platform's limit for one argv word: the whole list travels as one.
const list = JSON.stringify(steps);
if (Buffer.byteLength(list) > 131_071)
  usage(
    `the steps are ${Buffer.byteLength(list)} bytes as JSON, over one word's 131071: split them`,
  );

/** capture.sh's quoting: each word in single quotes, `'` as `'\''`, a space after each. */
const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;
const quoted = (words) => `${words.map((word) => `${quote(word)} `).join("")}\n`;

const raw = mkdtempSync(join(tmpdir(), "verify-steps-"));
const cleanup = () => rmSync(raw, { recursive: true, force: true });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    cleanup();
    process.exit(128 + (signal === "SIGINT" ? 2 : signal === "SIGTERM" ? 15 : 1));
  });

const secrets = process.env.MEND_VERIFY_PRIVATE;
/** One part, redacted the way capture.sh redacts it; nothing of it kept when that fails. */
const keep = (name, part, text) => {
  const source = join(raw, "part");
  writeFileSync(source, text, { mode: 0o600 });
  const redacted = spawnSync(
    process.execPath,
    [join(here, "redact.mjs"), ...(secrets ? ["--secrets", secrets, "--register-minted"] : [])],
    { input: readFileSync(source), maxBuffer: 1 << 30 },
  );
  const target = join(dir, `${name}.${part}`);
  if (redacted.status === 0) writeFileSync(target, redacted.stdout);
  else {
    process.stderr.write(`steps.mjs: redacting ${name}.${part} failed; nothing of it kept\n`);
    writeFileSync(target, "");
  }
};

let complete = false;
try {
  mkdirSync(dir, { recursive: true });
  // A result that never arrives must not leave an earlier attempt's files in its place.
  for (const name of [batch, ...steps.map((step) => step.name)])
    for (const part of ["cmd", "stdout", "stderr", "exit"])
      rmSync(join(dir, `${name}.${part}`), { force: true });
  const command = [
    "mend",
    "run",
    "--project",
    project,
    "--worktree",
    worktree,
    "--",
    "node",
    "scripts/verify-stack/stack.mjs",
    "steps",
    list,
  ];
  const run = spawnSync(command[0], command.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 30,
  });
  const read = readStepFrames(run.stdout?.toString() ?? "", steps.length);
  keep(batch, "cmd", quoted(command));
  keep(batch, "stdout", read.rest);
  keep(batch, "stderr", `${run.error ? `${run.error.message}\n` : ""}${run.stderr ?? ""}`);
  writeFileSync(join(dir, `${batch}.exit`), `${run.status ?? 128}\n`);
  for (const [index, step] of steps.entries()) {
    const result = read.steps[index];
    if (result === null) {
      process.stdout.write(
        `${step.name} · no result: the session's output ended before it, or cut it short\n`,
      );
      continue;
    }
    keep(
      step.name,
      "cmd",
      `cd ~${step.cwd === "" ? "" : `/${quote(step.cwd)}`} && ${quoted(step.run)}`,
    );
    keep(step.name, "stdout", result.stdout);
    keep(step.name, "stderr", result.stderr);
    writeFileSync(join(dir, `${step.name}.exit`), `${result.exit}\n`);
    process.stdout.write(`${step.name} · exit ${result.exit}\n`);
  }
  const outputInFull = run.status === 0;
  complete =
    outputInFull && read.done && read.stray === 0 && read.steps.every((result) => result !== null);
  const stray = read.stray === 0 ? "" : ` · ${read.stray} frame line(s) that fit no step, not kept`;
  process.stdout.write(
    `${batch} · ${complete ? "every step's result" : "results missing"}${stray} · mend run exit ${run.status ?? "?"}\n`,
  );
} finally {
  cleanup();
}
process.exit(complete ? 0 : 1);
