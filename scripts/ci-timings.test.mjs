import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { makeSourceResolver, readTestBudgets, withHeadroom } from "./ci-timeout-headroom.mjs";

const script = new URL("./ci-timings.mjs", import.meta.url);
const run = (context, lines, options = []) => {
  const directory = mkdtempSync(join(tmpdir(), "mend-ci-timings-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, "job.log");
  writeFileSync(log, lines.join("\n"));
  return spawnSync(process.execPath, [script.pathname, log, ...options], { encoding: "utf8" });
};
const line = (milliseconds, text) => `${new Date(milliseconds).toISOString()} ${text}`;

test("reports buffered task durations independently of flush times, with nested groups and units", (t) => {
  const child = run(t, [
    `\uFEFF${line(0, "##[group]Run pnpm test")}`,
    line(1, "##[endgroup]"),
    line(8000, "##[group]@mend/a:test"),
    line(8001, "##[group]nested diagnostic"),
    line(8002, "##[endgroup]"),
    line(8003, "\x1b[32m ✓ src/a.test.ts (2 tests | 1 skipped) 1250ms\x1b[0m"),
    line(8004, " Duration 2.50s (tests 1.25s)"),
    line(8005, "##[endgroup]"),
    line(8006, "##[group]@mend/b:test"),
    line(8007, "cache hit, replaying logs"),
    line(8008, " ❯ test/b.spec.tsx (1 test | 1 failed) 80ms"),
    line(8009, " Duration 100ms (tests 80ms)"),
    line(8010, "##[endgroup]"),
    line(10000, "##[group]Run node --test test.mjs"),
    line(10001, "##[endgroup]"),
    line(12000, "✔ preserves state (50.125ms)"),
    line(12001, "﹣ optional adapter (0.1ms) # unavailable"),
    line(12002, "✖ rejects late update (20ms)"),
    line(12003, "ℹ duration_ms 1800.5"),
    line(12004, "Post job cleanup."),
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.observedLogSpanMs, 12004);
  assert.deepEqual(
    report.steps.map((step) => step.intervalMs),
    [10000, 2004],
  );
  assert.equal(report.steps[1].boundary, "last log line (completion unknown)");
  assert.deepEqual(
    report.packages.map((p) => [p.package, p.reportedDurationMs, p.cached]),
    [
      ["@mend/a", 2500, false],
      ["@mend/b", 100, true],
    ],
  );
  assert.deepEqual(
    report.files.map((f) => [f.file, f.tests, f.reportedDurationMs, f.details]),
    [
      ["src/a.test.ts", 2, 1250, "| 1 skipped"],
      ["test/b.spec.tsx", 1, 80, "| 1 failed"],
    ],
  );
  assert.deepEqual(
    report.nodeTests.map((entry) => [entry.status, entry.file]),
    [
      ["passed", null],
      ["failed", null],
      ["skipped", null],
    ],
  );
  assert.equal(report.nodeRuns[0].reportedDurationMs, 1800.5);
});

test("does not invent missing package summaries or hide clock warnings and incomplete lines", (t) => {
  const child = run(t, [
    line(0, "##[group]Run pnpm test"),
    line(1, "##[endgroup]"),
    line(2, "##[group]@mend/interrupted:test"),
    line(3, "Warning: using time, but is not advancing the test clock"),
    "truncated or non-timestamped output",
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.packages[0].reportedDurationMs, null);
  assert.equal(report.files.length, 0);
  assert.equal(report.untimestampedLines, 1);
  assert.deepEqual(report.warnings, [{ kind: "unadvanced-test-clock", line: 4 }]);
});

test("absolute time shifts leave measured intervals unchanged", (t) => {
  for (const offset of [0, 1_700_000_000_000, 1_800_000_000_000]) {
    const child = run(t, [
      line(offset, "##[group]Run first"),
      line(offset + 1234, "##[group]Run second"),
      line(offset + 3000, "finished"),
    ]);
    assert.equal(child.status, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.deepEqual(
      report.steps.map((entry) => entry.intervalMs),
      [1234, 1766],
    );
    assert.equal(report.observedLogSpanMs, 3000);
  }
});

test("attributes an ungrouped failed Turbo task without borrowing a prior package summary", (t) => {
  const child = run(t, [
    line(0, "##[group]Run pnpm test"),
    line(1, "##[endgroup]"),
    line(2, "##[group]mend:test"),
    line(3, " Duration 10ms"),
    line(4, "##[endgroup]"),
    line(5, "@mend/api-server:test"),
    line(6, "##[group]nested diagnostic"),
    line(7, "##[endgroup]"),
    line(8, " ❯ src/route.test.ts (2 tests | 1 failed) 20ms"),
    line(9, " Duration 30ms"),
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(
    report.packages.map((p) => [p.package, p.reportedDurationMs]),
    [
      ["@mend/api-server", 30],
      ["mend", 10],
    ],
  );
  assert.equal(report.files[0].package, "@mend/api-server");
});

test("rejects unusable or backwards logs instead of reporting a zero-cost job", (t) => {
  for (const log of [[], ["a plain log"], [line(20, "##[group]Run test"), line(10, "done")]]) {
    const child = run(t, log);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /No timestamped GitHub Run groups|Timestamps go backwards/);
  }
});

const fallback = {
  timeoutMs: 5000,
  timeoutOrigin: { kind: "runner-default" },
  timeoutReason: null,
};
const budgets = (source) => readTestBudgets(source, "src/check.test.ts", fallback);
const fixtureRepo = (t, sources) => {
  const directory = mkdtempSync(join(tmpdir(), "mend-headroom-source-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  const write = (name, content) => {
    mkdirSync(join(directory, name, ".."), { recursive: true });
    writeFileSync(join(directory, name), content);
  };
  for (const [name, content] of Object.entries(sources)) write(name, content);
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Timing fixture",
      "-c",
      "user.email=timing@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD");
  };
  return { directory, write, commit };
};
const manifest = (name, task = "vitest run") =>
  JSON.stringify({ name, scripts: { test: task }, devDependencies: { vitest: "3.2.7" } });

test("resolves lexical constants, nearest suites and both leaf option positions", () => {
  const entries = budgets(`import { it as check, describe as suite } from "vitest";
    const BUDGET = 2 * (3_000);
    suite("outer", { timeout: BUDGET }, () => {
      check("inherited", () => {});
      suite("inner", () => {
        const BUDGET = 1000;
        check("numeric", () => {}, BUDGET);
        check("options", { timeout: BUDGET + 1000 }, () => {});
      });
      suite("nearest", { timeout: 9000 }, () => { check("own", () => {}); });
    });
    check("default", () => {}); unrelated.it("default", () => {}, 1);`);
  assert.deepEqual(
    entries.map((entry) => [entry.reportedName, entry.budget.timeoutMs]),
    [
      ["outer > inherited", 6000],
      ["outer > inner > numeric", 1000],
      ["outer > inner > options", 2000],
      ["outer > nearest > own", 9000],
      ["default", 5000],
    ],
  );
  assert.equal(entries[0].budget.timeoutOrigin.kind, "suite");
  assert.equal(entries[1].budget.timeoutOrigin.kind, "test");
});

test("dynamic explicit options and spread ordering never fall back to a healthy default", () => {
  const entries = budgets(`import { it, describe } from "vitest";
    let mutable = 1000; const cycle = cycle;
    describe("suite", { timeout: 8000 }, () => {
      it("call", () => {}, getTimeout());
      it("mutable", { timeout: mutable }, () => {});
      it("cycle", () => {}, cycle);
      it("late spread", { timeout: 1000, ...external }, () => {});
      it("early spread", { ...external, timeout: 1000 }, () => {});
      it("unknown options", options, () => {});
      it("unrelated options", { retry: 2 }, () => {});
    });`);
  assert.deepEqual(
    entries.map((entry) => entry.budget.timeoutMs),
    [null, null, null, null, 1000, null, 8000],
  );
  assert.equal(
    withHeadroom({ reportedDurationMs: 4000, cached: false }, entries[0].budget).atLeastHalfTimeout,
    null,
  );
});

test("Effect leaf signatures exclude layer hook budgets and property/helper budgets", () => {
  const entries = budgets(`import { it, flakyTest } from "@effect/vitest";
    it.effect("effect", () => program, { timeout: 7000 });
    it.live("live", () => flakyTest(program, "20 seconds"), 9000);
    it.prop("property", [arbitrary], () => program, { timeout: 11000 });
    it.layer(layer, { timeout: "30 seconds" })("owned", (it) => {
      it.effect("leaf", () => program);
    });`);
  assert.deepEqual(
    entries.map((entry) => [entry.reportedName, entry.budget.timeoutMs]),
    [
      ["effect", 7000],
      ["live", 9000],
      ["property", 11000],
      ["owned > leaf", 5000],
    ],
  );
});

test("static tables preserve exact titles and duplicate rows; unsupported tables stay unmatched", () => {
  const entries = budgets(`import { it, describe } from "vitest";
    it.each(["one", "one"])("row %s", () => {}, 1000);
    it.each([[1], [2]])("json %j", () => {}, 2000);
    it.each([{ person: { age: 42 } }])("$person.age", () => {}, 3000);
    it.each([{ person: { name: "Jane" } }])("$person.name", () => {}, 3000);
    it.each(dynamic)("dynamic %s", () => {}, 4000);
    it.each(["a"])("unsupported %o", () => {}, 4000);
    it.each(["a"])("index %$", () => {}, 4000);
    it.each(["a"])("escaped %%", () => {}, 4000);
    it.each([[ [{ name: "Jane" }] ]])("object %j", () => {}, 4000);
    it(\`dynamic \${value}\`, () => {});
    describe.each(["a"])("suite %s", () => { it("leaf", () => {}); });
    it("literal > separator", () => {}, 6000);`);
  assert.deepEqual(
    entries.filter((entry) => entry.reportedName !== null).map((entry) => entry.reportedName),
    ["row one", "row one", "json 1", "json 2", "42", "suite a > leaf", "literal > separator"],
  );
  assert.equal(
    entries.find((entry) => entry.reportedName === "suite a > leaf").budget.timeoutMs,
    null,
  );
});

test("a runtime setConfig alias prevents an assumed budget", () => {
  const entries = budgets(`import { it, vi as runtime } from "vitest";
    runtime.setConfig({ testTimeout: fromEnvironment() }); it("case", () => {});`);
  assert.equal(entries[0].budget.timeoutMs, null);
  assert.equal(entries[0].budget.timeoutReason, "runtime setConfig");
});

const assess = (duration, budget, cached = false) =>
  withHeadroom({ reportedDurationMs: duration, cached }, budget);
test("50 percent equality flags, below threshold does not, disabled/cached/unobserved stay unassessed", () => {
  assert.equal(assess(2500, fallback).atLeastHalfTimeout, true);
  assert.equal(assess(2499, fallback).atLeastHalfTimeout, false);
  assert.equal(assess(6000, fallback).headroomMs, -1000);
  for (const result of [
    assess(null, fallback),
    assess(4000, fallback, true),
    assess(4000, { timeoutMs: 0, timeoutReason: "disabled" }),
    assess(4000, { timeoutMs: null, timeoutReason: "disabled" }),
  ]) {
    assert.equal(result.ratio, null);
    assert.equal(result.atLeastHalfTimeout, null);
  }
  const entries = budgets(
    `import { it } from "vitest"; it("zero", () => {}, 0); it("infinite", () => {}, Infinity);`,
  );
  assert.deepEqual(
    entries.map((entry) => entry.budget.timeoutReason),
    ["disabled", "disabled"],
  );
});

test("historical source, CLI/config/default precedence and unknown config are resolved without executing code", (t) => {
  const repo = fixtureRepo(t, {
    "packages/a/package.json": manifest("@mend/a"),
    "packages/a/src/check.test.ts": `import { it } from "vitest"; it("default", () => {}); it("explicit", () => {}, 3000); it("duplicate", () => {}, 1000); it("duplicate", () => {}, 9000);`,
    "packages/a/vitest.config.ts": `import { defineConfig } from "vitest/config"; export default defineConfig({ test: { testTimeout: 8000 } });`,
    "packages/b/package.json": manifest("@mend/b"),
    "packages/b/src/check.test.ts": `import { it } from "vitest"; it("default", () => {});`,
    "packages/c/package.json": manifest("@mend/c"),
    "packages/c/src/check.test.ts": `import { it } from "vitest"; it("default", () => {}); it("explicit", () => {}, 4000);`,
    "packages/c/vitest.config.ts": `throw new Error("must not execute"); export default fromEnvironment();`,
  });
  const oldHead = repo.commit();
  repo.write(
    "packages/a/vitest.config.ts",
    `import { defineConfig } from "vitest/config"; export default defineConfig({ test: { testTimeout: 20000 } });`,
  );
  const newHead = repo.commit();
  const historical = makeSourceResolver({ repo: repo.directory, sourceRef: oldHead });
  const resolve = (packageName, name, command) =>
    historical.resolve({
      package: packageName,
      file: "src/check.test.ts",
      reportedName: name,
      command,
    });
  assert.equal(resolve("@mend/a", "default").timeoutMs, 8000);
  assert.equal(resolve("@mend/a", "default", "vitest run --testTimeout=12000").timeoutMs, 12000);
  assert.equal(resolve("@mend/a", "explicit", "vitest run --testTimeout 12000").timeoutMs, 3000);
  assert.equal(resolve("@mend/b", "default").timeoutMs, 5000);
  assert.equal(resolve("@mend/c", "default").timeoutMs, null);
  assert.equal(resolve("@mend/c", "explicit").timeoutMs, 4000);
  assert.equal(resolve("@mend/a", "duplicate").timeoutMs, null);
  assert.equal(resolve("@mend/a", "duplicate").identityConfidence, "unknown");
  assert.equal(
    makeSourceResolver({ repo: repo.directory, sourceRef: newHead }).resolve({
      package: "@mend/a",
      file: "src/check.test.ts",
      reportedName: "default",
    }).timeoutMs,
    20000,
  );
  assert.equal(historical.head, oldHead);
  assert.equal(
    makeSourceResolver({ repo: repo.directory, sourceRef: "--upload-pack=bad" }).resolve({})
      .timeoutReason,
    "source revision unavailable locally",
  );
});

test("buffered ANSI leaf reports retain package/file identity, repetitions, cached and unobserved coverage", (t) => {
  const repo = fixtureRepo(t, {
    "packages/a/package.json": manifest("@mend/a"),
    "packages/a/src/check.test.ts": `import { it } from "vitest"; it("suite > literal", () => {});`,
    "packages/b/package.json": manifest("@mend/b"),
    "packages/b/src/check.test.ts": `import { it } from "vitest"; it("suite > literal", () => {}, 10000);`,
  });
  const head = repo.commit();
  const child = run(
    t,
    [
      line(0, "##[group]Run pnpm test"),
      line(1, "##[endgroup]"),
      line(2, "##[group]@mend/a:test"),
      line(3, " > vitest run"),
      line(4, " ✓ src/check.test.ts (3 tests) 4000ms"),
      line(5, "\x1b[32m   ✓ suite > literal  2500ms\x1b[0m"),
      line(6, "##[group]nested diagnostic"),
      line(7, "##[endgroup]"),
      line(8, "   ✓ suite > literal  2000ms"),
      line(9, "stdout | src/check.test.ts > suite"),
      line(10, "a message about 5000ms"),
      line(11, "##[endgroup]"),
      line(12, "##[group]@mend/b:test"),
      line(13, "cache hit, replaying logs"),
      line(14, " ✓ src/check.test.ts (1 test) 5000ms"),
      line(15, "   ✓ suite > literal  5000ms"),
      line(16, "##[endgroup]"),
      line(17, "@mend/a:test"),
      line(18, "   × failure without file  3000ms"),
      line(19, "finished"),
    ],
    ["--source-ref", head, "--repo", repo.directory],
  );
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(
    report.vitestTests.map((entry) => [
      entry.package,
      entry.file,
      entry.timeoutMs,
      entry.atLeastHalfTimeout,
    ]),
    [
      ["@mend/a", "src/check.test.ts", 5000, true],
      ["@mend/a", "src/check.test.ts", 5000, false],
      ["@mend/b", "src/check.test.ts", 10000, null],
      ["@mend/a", null, null, null],
    ],
  );
  assert.equal(report.timeoutHeadroom.files[0].unobservedTestCount, 1);
  assert.equal(report.timeoutHeadroom.flaggedCurrentLeaves, 1);
  assert.equal(report.vitestTests[0].sourceHead, head);
  assert.equal(report.vitestTests[0].reportedName, "suite > literal");
  assert.equal(report.vitestTests[2].cached, true);
});

test("browser defaults, jsdom, project/plugin dynamics and task config selection remain distinct", (t) => {
  const repo = fixtureRepo(t, {
    "packages/a/package.json": manifest("@mend/a"),
    "packages/a/src/check.test.ts": `import { it } from "vitest"; it("case", () => {});`,
    "packages/a/vitest.config.ts": `import { defineConfig } from "vitest/config"; export default defineConfig({ test: { environment: "jsdom" } });`,
    "packages/a/browser.config.ts": `import { defineConfig as config } from "vitest/config"; export default config({ test: { browser: { enabled: true } } });`,
    "packages/a/project.config.ts": `export default { test: { testTimeout: 9000, projects: importedProjects } };`,
    "packages/a/plugin.config.ts": `export default { plugins: [plugin()], test: { testTimeout: 9000 } };`,
    "packages/a/spread.config.ts": `export default { test: { testTimeout: 9000, ...external } };`,
  });
  const head = repo.commit(),
    resolver = makeSourceResolver({ repo: repo.directory, sourceRef: head });
  const resolve = (command) =>
    resolver.resolve({
      package: "@mend/a",
      file: "src/check.test.ts",
      reportedName: "case",
      command,
    });
  assert.equal(resolve().timeoutMs, 5000);
  assert.equal(resolve("vitest run --config browser.config.ts").timeoutMs, 15000);
  for (const file of ["project", "plugin", "spread"])
    assert.equal(resolve(`vitest run --config ${file}.config.ts`).timeoutMs, null);
  assert.equal(resolve("vitest run --config missing.config.ts").timeoutMs, null);
  assert.equal(resolve("vitest run --project dynamic").timeoutMs, null);
});

test("possible dynamic title collisions and source absence cannot clear a case", (t) => {
  const repo = fixtureRepo(t, {
    "packages/a/package.json": manifest("@mend/a"),
    "packages/a/src/check.test.ts": `import { it } from "vitest"; it("row one", () => {}, 9000); it.each(dynamic)("row %s", () => {}, 1000);`,
  });
  const head = repo.commit(),
    resolver = makeSourceResolver({ repo: repo.directory, sourceRef: head });
  assert.equal(
    resolver.resolve({ package: "@mend/a", file: "src/check.test.ts", reportedName: "row one" })
      .timeoutReason,
    "possible dynamic identity collision",
  );
  const child = run(t, [
    line(0, "##[group]Run tests"),
    line(1, " ✓ src/check.test.ts (2 tests) 3000ms"),
    line(2, "   ✓ row one  2500ms"),
    line(3, "   ↓ row skipped"),
  ]);
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.vitestTests[0].atLeastHalfTimeout, null);
  assert.equal(report.vitestTests[1].reportedDurationMs, null);
  assert.equal(report.timeoutHeadroom.files[0].unobservedDurationCount, 1);
  assert.equal(
    withHeadroom({ reportedDurationMs: 0, cached: false, status: "skipped" }, fallback).ratio,
    null,
  );
});

test("const object/array bindings do not imply immutable contents or known table identity", () => {
  const entries = budgets(`import { it } from "vitest";
    const options = { timeout: 1000 }; options.timeout = getTimeout();
    const rows = ["old"]; rows.push(fromEnvironment());
    it("mutable contents", options, () => {});
    it.each(rows)("row %s", () => {});`);
  assert.equal(entries[0].budget.timeoutMs, null);
  assert.equal(entries[1].reportedName, null);
});

test("unsupported known-API modifiers and custom registration helpers invalidate possible collisions", (t) => {
  const repo = fixtureRepo(t, {
    "packages/a/package.json": manifest("@mend/a"),
    "packages/a/src/check.test.ts": `import { it, describe } from "vitest";
      it("same skipIf", () => {}, 9000); it.skipIf(flag)("same skipIf", () => {}, 1000);
      it("same runIf", () => {}, 9000); it.runIf(flag)("same runIf", () => {}, 1000);
      it("same scoped", () => {}, 9000); it.scoped("same scoped", () => {}, 1000);
      describe("nested", () => { it("case", () => {}); });
      describe.runIf(flag)("nested", () => { it("case", () => {}, 1000); });`,
    "packages/a/src/helper.test.ts": `import { it } from "vitest"; const register = () => { it("same", () => {}, 1000); }; register(); it("same", () => {}, 9000);`,
    "packages/a/src/shadow.test.ts": `import { it, test } from "vitest"; const helper = (test) => test("same"); for (const row of rows) { it(\`dynamic \${row}\`, () => {}); } it("static", () => {}, 9000);`,
  });
  const resolver = makeSourceResolver({ repo: repo.directory, sourceRef: repo.commit() });
  for (const reportedName of ["same skipIf", "same runIf", "same scoped", "nested > case"]) {
    const result = resolver.resolve({
      package: "@mend/a",
      file: "src/check.test.ts",
      reportedName,
    });
    assert.equal(result.identityConfidence, "unknown");
    assert.equal(result.timeoutMs, null);
  }
  assert.equal(
    resolver.resolve({ package: "@mend/a", file: "src/helper.test.ts", reportedName: "same" })
      .timeoutMs,
    null,
  );
  assert.equal(
    resolver.resolve({ package: "@mend/a", file: "src/shadow.test.ts", reportedName: "static" })
      .timeoutMs,
    9000,
  );
});

test("literal title whitespace and duplicate package names cannot force a different budget match", (t) => {
  const repo = fixtureRepo(t, {
    "packages/a/package.json": manifest("@mend/a"),
    "packages/a/src/check.test.ts": `import { it } from "vitest"; it("name", () => {}, 1000); it(" name ", () => {}, 10000);`,
    "packages/b/package.json": manifest("@mend/duplicate"),
    "packages/c/package.json": manifest("@mend/duplicate"),
  });
  const head = repo.commit();
  const child = run(
    t,
    [
      line(0, "##[group]Run tests"),
      line(1, "##[group]@mend/a:test"),
      line(2, " ✓ src/check.test.ts (2 tests) 2600ms"),
      line(3, "   ✓  name   2500ms"),
    ],
    ["--source-ref", head, "--repo", repo.directory],
  );
  assert.equal(child.status, 0, child.stderr);
  const entry = JSON.parse(child.stdout).vitestTests[0];
  assert.equal(entry.reportedName, " name ");
  assert.equal(entry.timeoutMs, 10000);
  assert.equal(entry.atLeastHalfTimeout, false);
  assert.equal(
    makeSourceResolver({ repo: repo.directory, sourceRef: head }).resolve({
      package: "@mend/duplicate",
      file: "src/check.test.ts",
      reportedName: "name",
    }).timeoutMs,
    null,
  );
});
