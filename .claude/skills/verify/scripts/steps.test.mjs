import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { TOKEN, everything, fresh, privateWithAccount } from "./leaks.helpers.mjs";

const TOKEN_BASE64 = Buffer.from(TOKEN).toString("base64");

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "../../../../scripts/verify-stack/lib.mjs");

/**
 * A `mend` that answers `mend run … -- node scripts/verify-stack/stack.mjs steps <json>` as a session
 * does: its terminal on stdout (CRLF, Mend's watch lines around it), Mend's own lines on stderr. Each
 * step prints what its run says (`echo`), `exit` codes it; `cut` ends the output before that step.
 */
const fakeMend = ({ status = 0 } = {}) => {
  const bin = fresh("bin");
  const script = `#!/usr/bin/env node
import { doneFrame, parseSteps, stepFrames } from ${JSON.stringify(lib)};
const steps = parseSteps(process.argv.at(-1));
const lines = ["✓ recording · node · workspace mounts the worktree"];
let cut = false;
for (const [index, step] of steps.entries()) {
  if (step.run.includes("cut")) { cut = true; break; }
  if (step.run.includes("stray")) lines.push("verify-step 9 out " + Buffer.from("${TOKEN}").toString("base64"));
  const exit = Number(step.run[step.run.indexOf("exit") + 1] ?? 0) || 0;
  lines.push(...stepFrames(index, { stdout: step.run.join(" ") + "\\n", stderr: "to stderr\\n", exit }));
  lines.push("verify stack · step " + step.name + " · exit " + exit);
}
if (!cut) lines.push(doneFrame(steps.length));
process.stdout.write(lines.join("\\r\\n") + "\\r\\n");
process.stderr.write("✓ base main 0123456789ab · session 0ddffa0a\\n");
process.exit(${status});
`;
  writeFileSync(join(bin, "mend"), script);
  chmodSync(join(bin, "mend"), 0o755);
  return bin;
};

const steps = (bin, P, E, list, batch = "batch") =>
  spawnSync(process.execPath, [join(here, "steps.mjs"), E, batch, "--worktree", "st-verify-test"], {
    encoding: "utf8",
    input: JSON.stringify(list),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MEND_VERIFY_PRIVATE: P },
  });

test("each step keeps capture.sh's four files, from one session, redacted by value", () => {
  const P = privateWithAccount();
  const E = fresh("evidence");
  const run = steps(fakeMend(), P, E, [
    { name: "01-push", cwd: "work", run: ["mend", "skills", "push", "--project"] },
    { name: "02-pipe", run: ["sh", "-c", `printf %s ${TOKEN} | mend connect github --from-stdin`] },
    { name: "03-refused", run: ["mend", "dotfiles", "exit", "4"] },
  ]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^01-push · exit 0\n02-pipe · exit 0\n03-refused · exit 4\n/);
  const file = (name) => readFileSync(join(E, name), "utf8");
  assert.equal(file("01-push.cmd"), "cd ~/'work' && 'mend' 'skills' 'push' '--project' \n");
  assert.equal(file("01-push.stdout"), "mend skills push --project\n");
  assert.equal(file("01-push.stderr"), "to stderr\n");
  assert.equal(file("01-push.exit"), "0\n");
  assert.equal(file("03-refused.exit"), "4\n");
  assert.ok(file("02-pipe.cmd").startsWith("cd ~ && 'sh' '-c' 'printf %s "));
  assert.ok(!everything(E).includes(TOKEN), "a registered value reached the evidence");
  assert.doesNotMatch(file("batch.stdout"), /verify-step/);
  assert.match(file("batch.stdout"), /step 03-refused · exit 4/);
  assert.match(file("batch.stderr"), /session 0ddffa0a/);
  assert.match(
    file("batch.cmd"),
    /^'mend' 'run' '--project' 'mend' '--worktree' 'st-verify-test' /,
  );
  assert.equal(file("batch.exit"), "0\n");
});

test("output that ends before a step's result says which step, keeps no files for it, and fails", () => {
  const E = fresh("evidence");
  const run = steps(fakeMend(), privateWithAccount(), E, [
    { name: "01-first", run: ["true"] },
    { name: "02-cut", run: ["cut"] },
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /02-cut · no result: the session's output ended before it/);
  assert.ok(existsSync(join(E, "01-first.exit")));
  assert.ok(!existsSync(join(E, "02-cut.exit")) && !existsSync(join(E, "02-cut.stdout")));
});

test("a retry whose result goes missing leaves no file of the earlier attempt", () => {
  const E = fresh("evidence");
  const P = privateWithAccount();
  assert.equal(steps(fakeMend(), P, E, [{ name: "01-step", run: ["true"] }]).status, 0);
  assert.ok(existsSync(join(E, "01-step.exit")));
  assert.equal(steps(fakeMend(), P, E, [{ name: "01-step", run: ["cut"] }]).status, 1);
  for (const part of ["cmd", "stdout", "stderr", "exit"])
    assert.ok(
      !existsSync(join(E, `01-step.${part}`)),
      `the earlier 01-step.${part} is still there`,
    );
});

test("a frame line that fits no step fails the batch and keeps none of its base64", () => {
  const E = fresh("evidence");
  const run = steps(fakeMend(), privateWithAccount(), E, [{ name: "01-only", run: ["stray"] }]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /1 frame line\(s\) that fit no step, not kept/);
  assert.ok(!everything(E).includes(TOKEN_BASE64), "a frame's base64 reached the evidence");
});

test("a mend run that says its output was not given in full fails the batch, every frame or not", () => {
  const E = fresh("evidence");
  const run = steps(fakeMend({ status: 1 }), privateWithAccount(), E, [
    { name: "01-only", run: ["true"] },
  ]);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /results missing · mend run exit 1/);
});

test("a batch named like a step, or not as a file, or too large for one word, runs nothing", () => {
  const E = fresh("evidence");
  const bin = fakeMend();
  const P = privateWithAccount();
  const refused = [
    [steps(bin, P, E, [{ name: "batch", run: ["true"] }]), /the batch and a step are both batch/],
    [steps(bin, P, E, [{ name: "01", run: ["true"] }], "../escape"), /must be a file name/],
    [steps(bin, P, E, [{ name: "01", run: ["sh", "-c", "x".repeat(140_000)] }]), /over one word/],
  ];
  for (const [run, why] of refused) {
    assert.equal(run.status, 2);
    assert.match(run.stderr, why);
  }
  assert.equal(everything(E), "");
});
