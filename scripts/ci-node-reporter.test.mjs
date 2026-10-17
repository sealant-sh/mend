import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A nested CLI invocation must start a new test runner, rather than inherit this file's child context.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
);
const reporter = new URL("./ci-node-reporter.mjs", import.meta.url);
const prepare = (context, sources, options = {}, flags = []) => {
  const directory = mkdtempSync(join(tmpdir(), "mend-node-ci-reporter-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const configured = join(directory, "reporter.mjs");
  writeFileSync(
    configured,
    `import { createCiNodeReporter } from ${JSON.stringify(reporter.href)};\nexport default createCiNodeReporter(${JSON.stringify(options)});\n`,
  );
  const files = sources.map((source, index) => {
    const ownedDirectory = join(directory, String(index));
    mkdirSync(ownedDirectory);
    const file = join(ownedDirectory, "case.test.mjs");
    writeFileSync(file, source);
    return file;
  });
  const args = [
    "--test",
    ...flags,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    `--test-reporter=${configured}`,
    "--test-reporter-destination=stderr",
    ...files,
  ];
  return { args, files };
};
const records = (stderr) =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("CI_TIMING "))
    .map((line) => JSON.parse(line.slice("CI_TIMING ".length)));
const run = (context, sources, options, flags = [], env = environment) => {
  const fixture = prepare(context, sources, options, flags);
  const child = spawnSync(process.execPath, fixture.args, {
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(child.error);
  return { ...fixture, ...child, records: records(child.stderr) };
};
const delayed = (name, ms) =>
  `test(${JSON.stringify(name)}, async () => { await new Promise(resolve => setTimeout(resolve, ${ms})); });`;
const imports = 'import { test, describe, before, after } from "node:test";\n';
const fileRecords = (child) => child.records.filter((record) => record.kind === "file");
const caseRecords = (child) => child.records.filter((record) => record.kind === "test");

test("retains native spec assertions and emits precise file/case evidence with unknown timeouts", (t) => {
  const child = run(
    t,
    [
      imports +
        'describe("outer", () => { describe("inner", () => { test("leaf\\u0085\\u2028\\u2029", { timeout: 1000 }, () => {}); test("skipped", { skip: true }, () => {}); }); });',
    ],
    { enforceFileBudget: true },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.match(child.stdout, /outer/);
  assert.match(child.stdout, /leaf/);
  assert.match(child.stdout, /tests 2/);
  assert.equal(caseRecords(child)[0].name, "leaf\u0085\u2028\u2029");
  assert.doesNotMatch(child.stderr, /[\u0085\u2028\u2029]/);
  const files = fileRecords(child);
  assert.equal(files.length, 1);
  assert.equal(files[0].file, child.files[0]);
  assert.equal(files[0].durationKind, "file-execution");
  assert.equal(files[0].budgetMs, 60_000);
  assert.equal(files[0].state, "passed");
  assert.equal(files[0].counts.tests, 2);
  assert.deepEqual(
    caseRecords(child).map((record) => record.state),
    ["passed", "skipped"],
  );
  assert.equal(new Set(child.records.map((record) => record.runId)).size, 1);
  for (const record of caseRecords(child)) {
    assert.equal(record.runner, "node");
    assert.equal(record.timeoutMs, null);
    assert.equal(record.timeoutReason, "not-exposed");
    assert.equal(record.timeoutOrigin, "unknown");
    assert.equal(record.headroomPercent, null);
    assert.equal(record.headroomReason, "timeout-not-exposed");
  }
  const summary = child.records.at(-1);
  assert.equal(summary.kind, "summary");
  assert.equal(summary.finished, true);
  assert.equal(summary.files, 1);
  assert.equal(summary.tests, 2);
});

test("fails the process for aggregate file duration even when every assertion passes", (t) => {
  const child = run(t, [imports + delayed("first", 300) + delayed("second", 300)], {
    enforceFileBudget: true,
    fileBudgetMs: 500,
  });
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /pass 2/);
  assert.match(child.stdout, /fail 0/);
  assert.match(child.stderr, /CI_GUARD Node test file exceeded 500ms/);
  assert.equal(fileRecords(child)[0].budgetExceeded, true);
  assert.equal(fileRecords(child)[0].state, "passed");
  assert.equal(caseRecords(child).length, 2);
  assert.ok(caseRecords(child).every((record) => record.state === "passed"));
  assert.equal(child.records.at(-1).nativeSuccess, true);
  assert.equal(child.records.at(-1).guardFailed, true);
});

test("counts file-level setup and teardown in the cap", (t) => {
  const child = run(
    t,
    [
      imports +
        'before(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });\nafter(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });\ntest("tiny body", () => {});',
    ],
    { enforceFileBudget: true, fileBudgetMs: 120 },
  );
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.equal(fileRecords(child)[0].budgetExceeded, true);
  assert.ok(fileRecords(child)[0].durationMs > 120);
  assert.equal(caseRecords(child)[0].state, "passed");
  assert.match(child.stdout, /pass 1/);
});

test("retains ordinary assertion failures without replacing their evidence", (t) => {
  const child = run(
    t,
    [
      imports +
        'import assert from "node:assert/strict";\ntest("original assertion failure", () => { assert.equal("actual", "expected"); });',
    ],
    { enforceFileBudget: true },
  );
  assert.equal(child.status, 1);
  assert.match(child.stdout, /original assertion failure/);
  assert.match(child.stdout, /actual/);
  assert.match(child.stdout, /expected/);
  assert.equal(caseRecords(child)[0].state, "failed");
  assert.equal(fileRecords(child)[0].state, "failed");
  assert.equal(child.records.at(-1).nativeSuccess, false);
  assert.equal(child.records.at(-1).guardFailed, false);
});

test("keeps parallel file names separate and never treats a file-named leaf as a file duration", (t) => {
  const child = run(
    t,
    [
      imports +
        'import { fileURLToPath } from "node:url";\ntest(fileURLToPath(import.meta.url), () => {});',
      imports + delayed("other file", 20),
    ],
    { enforceFileBudget: true },
    ["--test-concurrency=2"],
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(fileRecords(child).length, 2);
  assert.deepEqual(new Set(fileRecords(child).map((record) => record.file)), new Set(child.files));
  assert.equal(caseRecords(child).length, 2);
  assert.ok(caseRecords(child).some((record) => record.name === child.files[0]));
  assert.equal(child.records.at(-1).files, 2);
});

test("reports a crashed file as incomplete instead of inventing an execution duration", (t) => {
  const child = run(
    t,
    [
      imports +
        'test("passes before process failure", () => {});\nsetTimeout(() => process.exit(2), 30);',
    ],
    { enforceFileBudget: true },
  );
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.equal(fileRecords(child).length, 1);
  assert.equal(fileRecords(child)[0].state, "incomplete");
  assert.equal(fileRecords(child)[0].durationMs, null);
  assert.equal(fileRecords(child)[0].reason, "file-summary-not-observed");
  assert.equal(child.records.at(-1).finished, false);
  assert.equal(child.records.at(-1).files, 1);
  assert.equal(child.records.at(-1).tests, caseRecords(child).length);
  assert.equal(child.records.at(-1).nativeSuccess, false);
});

test("leaves interrupted output with a start marker and no fabricated completion", async (t) => {
  const fixture = prepare(
    t,
    [
      imports +
        'before(() => new Promise(() => { setInterval(() => {}, 1000); }));\ntest("never reached", () => {});',
    ],
    { enforceFileBudget: true },
  );
  const child = spawn(process.execPath, fixture.args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const closed = once(child, "close");
  while (!stderr.includes('"kind":"file-start"')) {
    await once(child.stderr, "data", { signal: AbortSignal.timeout(3000) });
  }
  child.kill("SIGTERM");
  await closed;
  const observed = records(stderr);
  assert.ok(observed.some((record) => record.kind === "file-start"));
  assert.ok(
    observed.every((record) => record.kind !== "file" && record.kind !== "summary"),
    stdout + stderr,
  );
});

test("allows explicit observation without enforcing the file cap", (t) => {
  const child = run(t, [imports + delayed("slow observation", 30)], {
    enforceFileBudget: false,
    fileBudgetMs: 1,
  });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(fileRecords(child)[0].budgetExceeded, true);
  assert.equal(fileRecords(child)[0].budgetEnforced, false);
  assert.equal(child.records.at(-1).guardFailed, false);
});

test("uses CI activation by default without changing the native invocation", (t) => {
  for (const ci of [undefined, "", "false", "0", "true"]) {
    const child = run(t, [imports + delayed("CI configuration", 20)], { fileBudgetMs: 1 }, [], {
      ...environment,
      CI: ci,
    });
    assert.equal(child.status, ci === "true" ? 1 : 0, child.stdout + child.stderr);
    assert.equal(fileRecords(child)[0].budgetEnforced, ci === "true");
  }
});

test("retains an existing native test timeout and reports its effective setting as unknown", (t) => {
  const child = run(
    t,
    [
      imports +
        'test("native timeout", { timeout: 25 }, async () => { await new Promise(resolve => setTimeout(resolve, 100)); });',
    ],
    { enforceFileBudget: true },
  );
  assert.equal(child.status, 1, child.stdout + child.stderr);
  assert.match(child.stdout, /timed out after 25ms/);
  assert.equal(caseRecords(child)[0].timeoutMs, null);
  assert.equal(caseRecords(child)[0].timeoutReason, "not-exposed");
  assert.equal(child.records.at(-1).guardFailed, false);
});

test("does not mistake an imported line-one leaf named its file for another entry file", (t) => {
  const child = run(
    t,
    [
      imports +
        `import { writeFileSync } from "node:fs";
const helper = new URL("./named-leaf.mjs", import.meta.url);
writeFileSync(helper, "test(new URL(import.meta.url).pathname, () => {});");
globalThis.test = test;
await import(helper.href);`,
    ],
    { enforceFileBudget: true },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.records.filter((record) => record.kind === "file-start").length, 1);
  assert.equal(fileRecords(child).length, 1);
  assert.equal(caseRecords(child).length, 1);
  assert.notEqual(caseRecords(child)[0].file, child.files[0]);
  assert.equal(caseRecords(child)[0].name, caseRecords(child)[0].file);
  assert.equal(caseRecords(child)[0].line, 1);
  assert.equal(caseRecords(child)[0].column, 1);
});

test("keeps native shard file selection and gives each invocation a distinct run ID", (t) => {
  const sources = [0, 1, 2, 3].map((number) => imports + `test("case ${number}", () => {});`);
  const first = run(t, sources, { enforceFileBudget: true }, ["--test-shard=1/2"]);
  const second = run(t, sources, { enforceFileBudget: true }, ["--test-shard=2/2"]);
  for (const child of [first, second]) {
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(fileRecords(child).length, 2);
    assert.equal(caseRecords(child).length, 2);
    assert.equal(child.records.at(-1).files, 2);
    assert.equal(child.records.at(-1).tests, 2);
  }
  assert.notEqual(first.records[0].runId, second.records[0].runId);
  assert.deepEqual(
    new Set([...caseRecords(first), ...caseRecords(second)].map((record) => record.name)),
    new Set(["case 0", "case 1", "case 2", "case 3"]),
  );
});
