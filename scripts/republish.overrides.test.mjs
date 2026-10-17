// The publish steps' retry delays stay the production ones, only these tests shorten them
// (RELEASE_TEST_RETRY_MS, REPUBLISH_TEST_WAIT), no workflow may set either, and each step logs the
// delays it ran with.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parse } from "yaml";

import { mendSeed, publishStep, registry, root } from "./republish.helpers.mjs";

// --- retry delays ---
// The publish steps wait between retried reads: 1500 ms × attempt for a registry or GitHub read, and
// 5 s × attempt for npm's integrity read-back. These were the delays before they became overridable,
// and stay the production ones; only these tests shorten them, through RELEASE_TEST_RETRY_MS and
// REPUBLISH_TEST_WAIT, and each step logs which delays it ran with.
const RETRY_MS = 1500;

const INTEGRITY_WAIT_S = 5;

const releaseWorkflow = () =>
  parse(readFileSync(path.join(root, ".github/workflows/release-cli.yml"), "utf8")).jobs;

const releaseSteps = () => {
  const jobs = releaseWorkflow();
  return {
    npm: jobs.npm.steps.find((entry) => entry.name === "Publish to npm").run,
    "promote-images": jobs["promote-images"].steps.find(
      (entry) => entry.name === "Update latest after release publication",
    ).run,
  };
};

const occurrences = (text, pattern) => text.match(new RegExp(pattern, "g"))?.length ?? 0;

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- the test overrides stay out of the workflows (#1034) ---
// RELEASE_TEST_RETRY_MS and REPUBLISH_TEST_WAIT shorten the publish steps' waits; only these tests
// may set them. The guard is a plain text scan of the workflow files, with no shell parser: it
// refuses text, so it never has to work out what Bash would make of a script, and it cannot hang.
const OVERRIDES = ["RELEASE_TEST_RETRY_MS", "REPUBLISH_TEST_WAIT"];

const NAMED = new RegExp(OVERRIDES.join("|"), "i");

// Text no workflow in the release graph may contain anywhere, comments included: none needs it.
const REFUSED_IN_RELEASE = [
  [/github_en/i, "GITHUB_ENV (in any case, or with its V assembled after GITHUB_EN)"],
  [/runner_file_commands|set_env_/i, "the file GITHUB_ENV points at, by its path"],
  [/allow_unsecure_commands/i, "the switch that brings back the retired ::set-env command"],
];

// The only lines, trimmed and whole, that may name an override, all in release-cli.yml: the reads
// and each publish step's preamble as they stand. Any other line naming one fails, so
// `: "${NAME:=0}"`, `export NAME=0`, `read NAME`, `printf -v NAME`, `declare NAME` and a
// `NAME<<EOF` write all do.
const OVERRIDE_LINES = new Map([
  [
    "# RELEASE_TEST_RETRY_MS, never a workflow; the log says which delays this run used.",
    "the comment over the retry preamble",
  ],
  ["if [[ -z ${RELEASE_TEST_RETRY_MS:-} ]]; then", "the preamble's unset test, a read"],
  [
    "elif [[ $RELEASE_TEST_RETRY_MS =~ ^(0|[1-9][0-9]{0,5})$ ]]; then",
    "the preamble's validation, a read",
  ],
  [
    'echo "retry backoff: overridden to $RELEASE_TEST_RETRY_MS ms × attempt"',
    "the log line, reached only with a validated value",
  ],
  [
    'echo "::error::RELEASE_TEST_RETRY_MS is not a whole number of milliseconds."',
    "the refusal, which names the variable and not its value",
  ],
  [
    "await new Promise((resolve) => setTimeout(resolve, attempt * Number(process.env.RELEASE_TEST_RETRY_MS || 1500)));",
    "a retry wait, a read with the production default",
  ],
  ["# REPUBLISH_TEST_WAIT, never a workflow.", "the comment over the integrity wait preamble"],
  ["if [[ -z ${REPUBLISH_TEST_WAIT:-} ]]; then", "the preamble's unset test, a read"],
  [
    "elif [[ $REPUBLISH_TEST_WAIT =~ ^(0|[1-9][0-9]{0,3})$ ]]; then",
    "the preamble's validation, a read",
  ],
  [
    'echo "integrity read-back wait: overridden to $REPUBLISH_TEST_WAIT s × attempt"',
    "the log line, reached only with a validated value",
  ],
  [
    'echo "::error::REPUBLISH_TEST_WAIT is not a whole number of seconds."',
    "the refusal, which names the variable and not its value",
  ],
  ["sleep $((attempt * ${REPUBLISH_TEST_WAIT:-5}))", "the integrity wait, a read with the default"],
]);

const workflowTexts = () => {
  const directory = path.join(root, ".github/workflows");
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, readFileSync(path.join(directory, name), "utf8")]),
  );
};

/** Every mapping key in a parsed YAML document, however deep: env, with, matrix and the rest. */
function* keysOf(node, seen = new Set()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    if (!Array.isArray(node)) yield key;
    yield* keysOf(value, seen);
  }
}

/** Every string value in a parsed YAML document, decoded, with the path to it. */
function* stringsOf(node, at = "", seen = new Set()) {
  if (typeof node === "string") yield [at, node];
  if (node === null || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node))
    yield* stringsOf(value, at === "" ? key : `${at}.${key}`, seen);
}

/**
 * The problems in <workflows> (file name → text), and the release graph it read: release-cli.yml
 * and every workflow it calls through `uses: ./.github/workflows/…`, transitively.
 *
 * Rules 1 and 2 read each line of a workflow twice: as written, comments included, and in every
 * string value YAML decodes from it, which is what the runner hands Bash or sets in the environment
 * (`run: "… \"$GITHUB_\x45NV\""` is written without GITHUB_ENV and decodes to it).
 * 1. No file in the release graph contains any text of REFUSED_IN_RELEASE.
 * 2. A line naming an override is one of OVERRIDE_LINES in release-cli.yml (and does not continue
 *    the line before it); in any other workflow, no line names one.
 * 3. No workflow has an override as a key: env or with at workflow, job or step level, a matrix
 *    entry, or a key YAML unescapes into one (`"RELEASE_TEST_\x52ETRY_MS": 0`), which rule 2 does
 *    not see.
 *
 * Writes to $GITHUB_ENV outside the release graph are allowed: ci.yml and ci-measure.yml write
 * ci-turbo.mjs's output there. A job's $GITHUB_ENV reaches only that job's later steps, never
 * another job, so it cannot reach a release job, nor can a workflow's env reach a workflow it
 * does not call.
 *
 * What a text scan of the workflows cannot see:
 * - a workflow the graph does not follow: a remote reusable workflow (`owner/repo/…@ref`) or a
 *   local composite action (`./.github/actions/…`); none is in the release graph today;
 * - an action a release job uses, or a repository script it runs, writing $GITHUB_ENV or setting
 *   either variable when it runs (the git grep in the test below keeps the names out of every
 *   other tracked file, which covers only scripts that spell them);
 * - a name a release step assembles from pieces and exports itself, after its preamble;
 * - the runner or its host supplying either variable.
 * The backstop is at run time: each publish step logs, before anything else, the delays it read
 * ("retry backoff: production (1500 ms × attempt)" or "overridden to …"), so every release run's
 * log shows what its environment held when the step started.
 */
function overrideProblems(workflows) {
  const problems = [];
  const parsed = Object.fromEntries(
    Object.entries(workflows).map(([file, text]) => [file, parse(text) ?? {}]),
  );
  const graph = new Set();
  for (const pending = ["release-cli.yml"]; pending.length > 0; ) {
    const file = pending.pop();
    if (graph.has(file)) continue;
    graph.add(file);
    if (!parsed[file]) problems.push(`the release graph calls ${file}, which is not here`);
    for (const job of Object.values(parsed[file]?.jobs ?? {})) {
      const called = /^\.\/\.github\/workflows\/([^/]+)$/.exec(job?.uses ?? "");
      if (called) pending.push(called[1]);
    }
  }
  for (const [file, text] of Object.entries(workflows)) {
    const sources = [[file, text]];
    for (const [at, value] of stringsOf(parsed[file])) sources.push([`${file} ${at}`, value]);
    for (const [source, body] of sources) {
      const lines = body.split("\n");
      for (const [index, line] of lines.entries()) {
        const where = `${source}:${index + 1}`;
        if (graph.has(file))
          for (const [pattern, what] of REFUSED_IN_RELEASE)
            if (pattern.test(line)) problems.push(`${where} names ${what}: ${line.trim()}`);
        if (!NAMED.test(line)) continue;
        const allowed =
          file === "release-cli.yml" &&
          OVERRIDE_LINES.has(line.trim()) &&
          !(lines[index - 1] ?? "").trimEnd().endsWith("\\");
        if (!allowed)
          problems.push(`${where} names an override other than as allowed: ${line.trim()}`);
      }
    }
    for (const key of keysOf(parsed[file]))
      if (OVERRIDES.some((name) => name.toLowerCase() === key.toLowerCase()))
        problems.push(`${file} sets ${key} as a key (env, with or matrix)`);
  }
  return { graph, problems };
}

test("no workflow sets a test delay, and the defaults are the production delays", (t) => {
  const { graph, problems } = overrideProblems(workflowTexts());
  t.diagnostic(`release graph: ${[...graph].toSorted().join(", ")}`);
  assert.deepEqual(problems, []);
  // Nor does any other tracked file but the release workflow and its tests name them: a script a
  // workflow runs could write $GITHUB_ENV itself.
  const named = execFileSync("git", ["grep", "-l", "-i", "-E", OVERRIDES.join("|")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.deepEqual(named.trim().split("\n").toSorted(), [
    ".github/workflows/release-cli.yml",
    "scripts/release-publication.test.mjs",
    "scripts/republish.helpers.mjs",
    "scripts/republish.overrides.test.mjs",
  ]);
  const workflow = readFileSync(path.join(root, ".github/workflows/release-cli.yml"), "utf8");
  // Every retry wait in the release workflow reads the override with today's delay as its default.
  const retry = `setTimeout(resolve, attempt * Number(process.env.RELEASE_TEST_RETRY_MS || ${RETRY_MS}))`;
  assert.equal(occurrences(workflow, literal(retry)), 4);
  assert.equal(occurrences(workflow, "setTimeout\\("), 4);
  const wait = `sleep $((attempt * \${REPUBLISH_TEST_WAIT:-${INTEGRITY_WAIT_S}}))`;
  assert.equal(occurrences(workflow, "\\bsleep\\b"), 1);
  assert.ok(workflow.includes(wait));
  // And each step's log names those same defaults.
  for (const run of Object.values(releaseSteps()))
    assert.ok(run.includes(`echo "retry backoff: production (${RETRY_MS} ms × attempt)"`));
  assert.ok(
    releaseSteps().npm.includes(
      `echo "integrity read-back wait: production (${INTEGRITY_WAIT_S} s × attempt)"`,
    ),
  );
});

/** <workflows> with <step> (YAML lines under `- name: Injected`) first in <job> of <file>. */
const withStep = (workflows, file, job, step) => {
  const text = workflows[file];
  const header = text.indexOf(`\n  ${job}:\n`);
  assert.ok(header >= 0, `${file} has a ${job} job`);
  const at = text.indexOf("\n    steps:\n", header) + "\n    steps:\n".length;
  const lines = ["- name: Injected", ...step].map((line) => `      ${line}`);
  return { ...workflows, [file]: `${text.slice(0, at)}${lines.join("\n")}\n${text.slice(at)}` };
};

const runStep = (script) => ["  run: |", ...script.split("\n").map((line) => `    ${line}`)];

/** <workflows> with <lines> inserted after <after>, the first time it follows <job> in <file>. */
const withLines = (workflows, file, job, after, lines) => {
  const text = workflows[file];
  const header = text.indexOf(`\n  ${job}:\n`);
  assert.ok(header >= 0, `${file} has a ${job} job`);
  const at = text.indexOf(after, header) + after.length;
  assert.ok(at >= after.length, `${file} ${job} has ${after}`);
  return { ...workflows, [file]: `${text.slice(0, at)}${lines.join("\n")}\n${text.slice(at)}` };
};

test("the guard refuses each way a mutation sets an override in a release workflow", () => {
  const workflows = workflowTexts();
  const GITHUB_ENV = /names GITHUB_ENV/;
  const LINE = /names an override other than as allowed/;
  const KEY = /as a key/;
  // The same rules, caught only in a string YAML decoded: the path after the file name says so.
  const DECODED_GITHUB_ENV = /^[\w.-]+ \S+:\d+ names GITHUB_ENV/;
  const DECODED_LINE = /^[\w.-]+ \S+:\d+ names an override other than as allowed/;
  for (const [form, mutated, ...expected] of [
    // #1034: a multiline write.
    [
      "the issue's heredoc group",
      withStep(
        workflows,
        "release-cli.yml",
        "npm",
        runStep('{ echo "RELEASE_TEST_RETRY_MS<<EOF"; echo 0; echo EOF; } >> "$GITHUB_ENV"'),
      ),
      GITHUB_ENV,
      LINE,
    ],
    // The six forms Astra's audit of 7788bc0da ran through Bash: each wrote RELEASE_TEST_RETRY_MS=0
    // to $GITHUB_ENV without the name ever spelled whole.
    [
      "printf %b",
      withStep(
        workflows,
        "release-cli.yml",
        "npm",
        runStep(`printf '%b=0\\n' 'RELEASE_TEST_\\x52ETRY_MS' >> "$GITHUB_ENV"`),
      ),
      GITHUB_ENV,
    ],
    [
      "printf precision",
      withStep(
        workflows,
        "image.yml",
        "build",
        runStep(`printf '%.21s=0\\n' RELEASE_TEST_RETRY_MS_suffix >> "$GITHUB_ENV"`),
      ),
      GITHUB_ENV,
      LINE,
    ],
    [
      ">&1 inside a redirected group",
      withStep(
        workflows,
        "release-cli.yml",
        "npm",
        runStep(`{ printf '%s%s=0\\n' RELEASE_TEST_ RETRY_MS >&1; } >> "$GITHUB_ENV"`),
      ),
      GITHUB_ENV,
    ],
    [
      "short-circuited commands",
      withStep(
        workflows,
        "release-cli.yml",
        "npm",
        runStep(
          `{ : || echo 'NOTES<<X'; printf '%s%s=0\\n' RELEASE_TEST_ RETRY_MS; : || echo X; } >> "$GITHUB_ENV"`,
        ),
      ),
      GITHUB_ENV,
    ],
    [
      "a shadowed printf",
      withStep(
        workflows,
        "image.yml",
        "build",
        runStep(
          `printf() { builtin printf '%s%s=0\\n' RELEASE_TEST_ RETRY_MS; }\nprintf 'FOO=1\\n' >> "$GITHUB_ENV"`,
        ),
      ),
      GITHUB_ENV,
    ],
    [
      "xpg_echo",
      withStep(
        workflows,
        "release-cli.yml",
        "npm",
        runStep(`shopt -s xpg_echo\necho 'RELEASE_TEST_\\0122ETRY_MS=0' >> "$GITHUB_ENV"`),
      ),
      GITHUB_ENV,
    ],
    // ${NAME:=0} assigns; under set -a it exports.
    [
      "set -a with ${NAME:=0}",
      withStep(
        workflows,
        "release-cli.yml",
        "npm",
        runStep('set -a\n: "${RELEASE_TEST_RETRY_MS:=0}"\nset +a'),
      ),
      LINE,
    ],
    [
      "export",
      withStep(workflows, "release-cli.yml", "npm", runStep("export REPUBLISH_TEST_WAIT=0")),
      LINE,
    ],
    [
      "a step env key",
      withStep(workflows, "release-cli.yml", "npm", [
        "  env:",
        '    RELEASE_TEST_RETRY_MS: "0"',
        "  run: true",
      ]),
      LINE,
      KEY,
    ],
    // YAML unescapes the key; only the key check sees it.
    [
      "a step env key YAML unescapes",
      withStep(workflows, "release-cli.yml", "npm", [
        "  env:",
        '    "RELEASE_TEST_\\x52ETRY_MS": "0"',
        "  run: true",
      ]),
      KEY,
    ],
    [
      "a matrix env key",
      withLines(workflows, "image.yml", "build", "      matrix:\n", [
        "        env:",
        '          - { REPUBLISH_TEST_WAIT: "0" }',
      ]),
      LINE,
      KEY,
    ],
    [
      "a job env key",
      withLines(workflows, "image.yml", "build", "    needs: version\n", [
        "    env:",
        '      release_test_retry_ms: "0"',
      ]),
      LINE,
      KEY,
    ],
    // Escapes YAML decodes: the source names neither GITHUB_ENV nor an override, the decoded value
    // does, and Bash runs the decoded value.
    [
      "GITHUB_ENV escaped in a double-quoted run",
      withStep(workflows, "release-cli.yml", "npm", [
        String.raw`  run: "printf '%s%s=0\\n' RELEASE_TEST_ RETRY_MS >> \"$GITHUB_\x45NV\""`,
      ]),
      DECODED_GITHUB_ENV,
    ],
    [
      "an export escaped in a double-quoted run",
      withStep(workflows, "release-cli.yml", "npm", [
        String.raw`  run: "export REPUBLISH_TEST_\x57AIT=0"`,
      ]),
      DECODED_LINE,
    ],
    [
      "an assignment escaped in a double-quoted run",
      withStep(workflows, "image.yml", "build", [
        String.raw`  run: "RELEASE_TEST_RETRY_\x4dS=0 node publish.mjs"`,
      ]),
      DECODED_LINE,
    ],
    [
      "GITHUB_ENV escaped in a step env value",
      withStep(workflows, "release-cli.yml", "npm", [
        "  env:",
        String.raw`    TARGET: "GITHUB_\x45NV"`,
        "  run: printf '%s%s=0\\n' RELEASE_TEST_ RETRY_MS >> \"${!TARGET}\"",
      ]),
      DECODED_GITHUB_ENV,
    ],
    // The names belong to release-cli.yml alone: even an allowed read fails anywhere else.
    [
      "an allowed line in another workflow",
      withStep(
        workflows,
        "image.yml",
        "build",
        runStep("sleep $((attempt * ${REPUBLISH_TEST_WAIT:-5}))"),
      ),
      LINE,
    ],
  ]) {
    const { problems } = overrideProblems(mutated);
    for (const pattern of expected)
      assert.ok(
        problems.some((problem) => pattern.test(problem)),
        `${form}: expected ${pattern}, got ${problems.join("; ") || "none"}`,
      );
  }
});

test("$GITHUB_ENV writes outside the release graph pass, and the same write inside it fails", () => {
  const workflows = workflowTexts();
  const { graph } = overrideProblems(workflows);
  // Today's writers: ci-turbo.mjs's output in ci.yml and ci-measure.yml, neither in the graph.
  const writers = Object.keys(workflows).filter((file) => /GITHUB_ENV/.test(workflows[file]));
  assert.ok(writers.includes("ci.yml"), writers.join(", "));
  for (const file of writers) assert.ok(!graph.has(file), file);
  const write = 'echo "FOO=bar" >> "$GITHUB_ENV"';
  assert.deepEqual(
    overrideProblems(withStep(workflows, "ci.yml", "static", runStep(write))).problems,
    [],
  );
  const released = overrideProblems(withStep(workflows, "image.yml", "build", runStep(write)));
  assert.ok(released.problems.some((problem) => problem.startsWith("image.yml:")));
});

// The lines before a step's floor block: where it states its delays, before anything else runs.
const preambleOf = (run) => run.slice(0, run.indexOf("# --- floor ---"));

const runPreamble = (run, environment) =>
  spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", preambleOf(run)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...environment },
  });

test("each publish step logs the delays it runs with, once, before anything else", () => {
  for (const [name, run] of Object.entries(releaseSteps())) {
    const production = runPreamble(run, {});
    assert.equal(production.status, 0, `${name}: ${production.stderr}`);
    assert.match(production.stdout, /^retry backoff: production \(1500 ms × attempt\)$/m, name);
    assert.equal(occurrences(production.stdout, "retry backoff"), 1, name);
    assert.doesNotMatch(production.stdout, /overridden/, name);
    const overridden = runPreamble(run, { RELEASE_TEST_RETRY_MS: "7", REPUBLISH_TEST_WAIT: "0" });
    assert.equal(overridden.status, 0, `${name}: ${overridden.stderr}`);
    assert.match(overridden.stdout, /^retry backoff: overridden to 7 ms × attempt$/m, name);
    assert.doesNotMatch(overridden.stdout, /production \(1500/, name);
    // A value that is not a number of milliseconds fails the step, and is not echoed.
    const garbage = runPreamble(run, { RELEASE_TEST_RETRY_MS: "1500; secret-token" });
    assert.notEqual(garbage.status, 0, name);
    assert.match(
      garbage.stdout,
      /RELEASE_TEST_RETRY_MS is not a whole number of milliseconds/,
      name,
    );
    assert.doesNotMatch(garbage.stdout + garbage.stderr, /secret-token/, name);
  }
  const npm = releaseSteps().npm;
  assert.match(
    runPreamble(npm, {}).stdout,
    /^integrity read-back wait: production \(5 s × attempt\)$/m,
  );
  assert.match(
    runPreamble(npm, { REPUBLISH_TEST_WAIT: "0" }).stdout,
    /^integrity read-back wait: overridden to 0 s × attempt$/m,
  );
  const garbage = runPreamble(npm, { REPUBLISH_TEST_WAIT: "5s secret-token" });
  assert.notEqual(garbage.status, 0);
  assert.doesNotMatch(garbage.stdout + garbage.stderr, /secret-token/);
});

test("the npm step, run whole, logs production delays when no test overrides them", async (t) => {
  const stub = await registry(t, mendSeed({}, { latest: "0.39.0", next: "0.40.0-next.3" }));
  const unset = await publishStep(t, stub, {
    version: "0.40.0-next.4",
    environment: { RELEASE_TEST_RETRY_MS: undefined, REPUBLISH_TEST_WAIT: undefined },
  });
  assert.equal(unset.status, 0, unset.output);
  assert.equal(occurrences(unset.output, "retry backoff: production \\(1500 ms × attempt\\)"), 1);
  assert.equal(
    occurrences(unset.output, "integrity read-back wait: production \\(5 s × attempt\\)"),
    1,
  );
  assert.doesNotMatch(unset.output, /overridden/);
  const again = await registry(t, mendSeed({}, { latest: "0.39.0", next: "0.40.0-next.3" }));
  const overridden = await publishStep(t, again, { version: "0.40.0-next.4" });
  assert.equal(overridden.status, 0, overridden.output);
  assert.equal(occurrences(overridden.output, "retry backoff: overridden to 1 ms × attempt"), 1);
  assert.equal(
    occurrences(overridden.output, "integrity read-back wait: overridden to 0 s × attempt"),
    1,
  );
});
