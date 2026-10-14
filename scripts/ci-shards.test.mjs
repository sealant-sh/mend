import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const repository = fileURLToPath(new URL("../", import.meta.url));
const source = readFileSync(new URL("./ci-shards.mjs", import.meta.url), "utf8");
const workspace = readFileSync(join(repository, "pnpm-workspace.yaml"), "utf8");
const packageFiles = [];
for await (const file of glob(
  parse(workspace).packages.map((pattern) => `${pattern}/package.json`),
  { cwd: repository, exclude: ["**/node_modules/**"] },
)) {
  packageFiles.push(file);
}

const fixture = (t, script = source) => {
  const root = mkdtempSync(join(tmpdir(), "mend-ci-shards "));
  const ownedGroups = new Set();
  t.after(() => {
    // Read ownership even when an assertion failed before the test inspected its recordings.
    recordings();
    for (const group of ownedGroups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const write = (file, contents) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), contents);
  };
  write("scripts/ci-shards.mjs", script);
  write("pnpm-workspace.yaml", workspace);
  copyFileSync(join(repository, "package.json"), join(root, "package.json"));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
  for (const file of packageFiles) write(file, readFileSync(join(repository, file)));
  const record = join(root, "command.json");
  const recordFiles = () => readdirSync(root).filter((file) => /^command\.json-\d+$/.test(file));
  const recordings = () =>
    recordFiles().map((file) => {
      const value = JSON.parse(readFileSync(join(root, file), "utf8"));
      if (Number.isSafeInteger(value.pid) && value.pid > 0) ownedGroups.add(value.pid);
      return value;
    });
  const clearRecordings = () => {
    for (const file of recordFiles()) rmSync(join(root, file));
  };
  const binary = join(root, "bin/pnpm");
  const command = (body) => {
    write(
      "bin/pnpm",
      `#!${process.execPath}
const fs = require("node:fs");
const recordFile = process.env.RECORD_COMMAND + "-" + process.pid;
const record = (value) => {
  fs.writeFileSync(recordFile + ".tmp", JSON.stringify({ ...value, pid: process.pid }));
  fs.renameSync(recordFile + ".tmp", recordFile);
};
${body}\n`,
    );
    chmodSync(binary, 0o700);
  };
  command(`
record({
  args: process.argv.slice(2), cwd: process.cwd(),
  ci: process.env.CI, workers: process.env.VITEST_MAX_WORKERS,
  postgres: process.env.MEND_TEST_DATABASE_URL, stdin: fs.readFileSync(0, "utf8"),
});
process.stdout.write("child stdout\\n");
process.stderr.write("child stderr\\n");
process.exit(Number(process.env.RECORD_EXIT_CODE ?? 0));
`);
  const env = {
    ...process.env,
    PATH: `${dirname(binary)}:${process.env.PATH ?? ""}`,
    RECORD_COMMAND: record,
    CI: "1",
    VITEST_MAX_WORKERS: "3",
    MEND_TEST_DATABASE_URL: "postgres://fixture.invalid/database",
  };
  const check = (...args) =>
    spawnSync(process.execPath, [join(root, "scripts/ci-shards.mjs"), ...args], {
      cwd: tmpdir(),
      env,
      encoding: "utf8",
      input: "inherited input\n",
      timeout: 10_000,
    });
  return { root, write, check, record, recordings, clearRecordings, command, env };
};

test("the source workspace inventory is covered and --check starts no package command", (t) => {
  const f = fixture(t);
  const result = f.check("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /test packages; the CLI has two complete native Vitest shards/);
  assert.deepEqual(f.recordings(), []);
});

test("all modes preserve package scripts, exact filters, native CLI shards, caps, environment and stdio", (t) => {
  const f = fixture(t);
  const selected = new Map();
  const native = [];
  for (const shard of ["engines", "clients-a", "clients-b"]) {
    f.clearRecordings();
    const result = f.check(shard);
    assert.equal(result.status, 0, result.stderr);
    const records = f.recordings();
    assert.equal(records.length, 2);
    assert.equal(result.stdout, "child stdout\n".repeat(records.length));
    assert.equal(result.stderr, "child stderr\n".repeat(records.length));
    assert.equal(records.map((recorded) => recorded.stdin).join(""), "inherited input\n");
    for (const recorded of records) {
      assert.deepEqual(recorded.args.slice(0, 5), [
        "exec",
        "turbo",
        "test",
        "--force",
        "--concurrency=1",
      ]);
      assert.equal(recorded.cwd, f.root);
      assert.equal(recorded.ci, "1");
      assert.equal(recorded.workers, "3");
      assert.equal(recorded.postgres, f.env.MEND_TEST_DATABASE_URL);
      if (recorded.args[5] === "--filter=@sealant/mend") {
        assert.deepEqual(recorded.args, [
          "exec",
          "turbo",
          "test",
          "--force",
          "--concurrency=1",
          "--filter=@sealant/mend",
          "--",
          `--shard=${shard === "clients-a" ? 1 : 2}/2`,
        ]);
        native.push(recorded.args.at(-1));
      } else {
        assert.ok(
          recorded.args
            .slice(5)
            .every((filter) => filter.startsWith("--filter=") && !filter.includes("...")),
        );
        selected.set(shard, [
          ...(selected.get(shard) ?? []),
          ...recorded.args.slice(5).map((filter) => filter.slice("--filter=".length)),
        ]);
      }
    }
    if (shard === "engines") {
      assert.equal(
        records.filter((recorded) => recorded.args.slice(5).includes("--filter=@mend/sessions"))
          .length,
        1,
      );
      assert.ok(
        records.some(
          (recorded) =>
            recorded.args.length === 6 && recorded.args[5] === "--filter=@mend/sessions",
        ),
      );
    }
  }
  const packagesWithTests = packageFiles
    .map((file) => JSON.parse(readFileSync(join(repository, file), "utf8")))
    .filter((pkg) => pkg.scripts?.test !== undefined)
    .map((pkg) => pkg.name);
  const allSelected = [...selected.values()].flat();
  assert.equal(new Set(allSelected).size, allSelected.length);
  assert.deepEqual([...allSelected, "@sealant/mend"].toSorted(), packagesWithTests.toSorted());
  assert.deepEqual(native, ["--shard=1/2", "--shard=2/2"]);
  for (const required of [
    "@mend/sessions",
    "@mend/api-server",
    "@mend/db",
    "@mend/jobs",
    "@mend/auth",
  ]) {
    assert.ok(selected.get("engines").includes(required), required);
  }
  assert.ok(selected.get("clients-a").includes("mend"), "the unscoped VS Code package is selected");
});

test("a future test package outside apps and packages cannot disappear from CI", (t) => {
  const f = fixture(t);
  f.write("pnpm-workspace.yaml", workspace.replace("packages:\n", "packages:\n  - examples/**\n"));
  f.write(
    "examples/nested/new/package.json",
    JSON.stringify({ name: "@mend/future", scripts: { test: "node test.mjs" } }),
  );
  for (const action of ["--check", "engines", "clients-a", "clients-b"]) {
    const result = f.check(action);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing shard assignment: @mend\/future/);
    assert.deepEqual(f.recordings(), []);
  }
});

test("authoritative glob patterns support relocated packages, braces, overlap and exclusions", (t) => {
  const f = fixture(t);
  const moved = "examples/nested/cli/package.json";
  f.write(moved, readFileSync(join(f.root, "apps/cli/package.json")));
  rmSync(join(f.root, "apps/cli/package.json"));
  f.write(
    "examples/nested/ignored/package.json",
    JSON.stringify({ name: "ignored", scripts: { test: "node test.mjs" } }),
  );
  f.write(
    "examples/nested/cli/node_modules/dependency/package.json",
    JSON.stringify({ name: "dependency", scripts: { test: "node test.mjs" } }),
  );
  f.write(
    "pnpm-workspace.yaml",
    workspace.replace(
      "packages:\n",
      "packages:\n  - examples/{nested,other}/**\n  - tooling/**\n  - '!examples/nested/ignored'\n",
    ),
  );
  const result = f.check("--check");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.recordings(), []);
});

test("a broad workspace pattern still excludes the root Turbo orchestration and dependency packages", (t) => {
  const f = fixture(t);
  f.write("pnpm-workspace.yaml", "packages:\n  - '**'\n");
  f.write(
    "apps/cli/node_modules/dependency/package.json",
    JSON.stringify({ name: "dependency", scripts: { test: "node test.mjs" } }),
  );
  const result = f.check("--check");
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, edited, diagnostic] of [
  [
    "duplicate within one shard",
    source.replace('"@mend/api-server",', '"@mend/sessions",'),
    /Duplicate shard assignment: @mend\/sessions/,
  ],
  [
    "duplicate across shards",
    source.replace('"@mend/desktop",', '"@mend/sessions",'),
    /Duplicate shard assignment: @mend\/sessions/,
  ],
  [
    "missing assignment",
    source.replace(/^\s+"@mend\/db",\n/m, ""),
    /Missing shard assignment: @mend\/db/,
  ],
  [
    "unknown assigned package",
    source.replace('"@mend/db",', '"@mend/absent",'),
    /Unknown assigned workspace package: @mend\/absent/,
  ],
  [
    "CLI duplicated as an ordinary package",
    source.replace('"@mend/desktop",', '"@sealant/mend",'),
    /Duplicate shard assignment: @sealant\/mend/,
  ],
  [
    "duplicate CLI native index",
    source.replace("index: 2", "index: 1"),
    /Duplicate CLI native shard index: 1/,
  ],
  [
    "missing CLI native index",
    source.replace(/^\s+\{ shard: "clients-b", index: 2 \},\n/m, ""),
    /Missing CLI native shard index: 2/,
  ],
  [
    "out-of-range CLI native index",
    source.replace("index: 2", "index: 3"),
    /Invalid CLI native shard index: 3/,
  ],
  [
    "incomplete declared CLI split",
    source.replace("total: 2", "total: 3"),
    /CLI split must declare exactly two/,
  ],
  [
    "unknown CLI client mode",
    source.replace('shard: "clients-b"', 'shard: "clients-unknown"'),
    /Unknown CLI client shard/,
  ],
  [
    "duplicate CLI client mode",
    source.replace('shard: "clients-b"', 'shard: "clients-a"'),
    /Duplicate CLI client shard/,
  ],
]) {
  test(`${name} refuses to run either shard`, (t) => {
    assert.notEqual(edited, source, "the fixture actually changed the assignment");
    const f = fixture(t, edited);
    for (const action of ["--check", "engines", "clients-a", "clients-b"]) {
      const result = f.check(action);
      assert.equal(result.status, 1);
      assert.match(result.stderr, diagnostic);
      assert.deepEqual(f.recordings(), []);
    }
  });
}

test("missing packages, duplicate manifest names and removed test scripts cannot produce green", (t) => {
  for (const [change, diagnostic] of [
    [
      (f) => rmSync(join(f.root, "apps/api/package.json")),
      /Unknown assigned workspace package: @mend\/api-server/,
    ],
    [
      (f) => f.write("packages/duplicate/package.json", JSON.stringify({ name: "@mend/db" })),
      /Duplicate workspace package name @mend\/db/,
    ],
    [
      (f) => f.write("packages/db/package.json", JSON.stringify({ name: "@mend/db" })),
      /Assigned package has no test script: @mend\/db/,
    ],
  ]) {
    const f = fixture(t);
    change(f);
    const result = f.check("engines");
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.deepEqual(f.recordings(), []);
  }
});

test("an empty ordinary client lane refuses even when every package remains assigned", (t) => {
  const body = source.match(/"clients-b": \[([\s\S]*?)\n  \]/)?.[1];
  assert.ok(body, "the fixture found the ordinary lane");
  const edited = source
    .replace(/("clients-a": \[[\s\S]*?)(\n  \])/, `$1${body}$2`)
    .replace(/"clients-b": \[[\s\S]*?\n  \]/, '"clients-b": []');
  const f = fixture(t, edited);
  for (const mode of ["--check", "engines", "clients-a", "clients-b"]) {
    const result = f.check(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Empty ordinary task lane: clients-b/);
    assert.doesNotMatch(result.stderr, /Missing shard assignment|Duplicate shard assignment/);
    assert.deepEqual(f.recordings(), []);
  }
});

test("an unused package shard refuses even when every package remains assigned", (t) => {
  const edited = source
    .replace(/^\s+"@mend\/docs",\n/m, "")
    .replace("const shards = {", 'const shards = {\n  future: ["@mend/docs"],');
  assert.notEqual(edited, source);
  const f = fixture(t, edited);
  for (const mode of ["--check", "engines", "clients-a", "clients-b", "future"]) {
    const result = f.check(mode);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Unbound package shard: future/);
    assert.doesNotMatch(result.stderr, /Missing shard assignment|Duplicate shard assignment/);
    assert.deepEqual(f.recordings(), []);
  }
});

test("malformed workspace YAML, manifests and test scripts fail before starting pnpm", (t) => {
  for (const contents of [
    "packages: [\n",
    "packages: nope\n",
    "packages: []\n",
    "packages: [42]\n",
    "packages: ['']\n",
    "packages: ['!apps/*']\n",
    "packages: [apps/*]\npackages: [packages/*]\n",
  ]) {
    const f = fixture(t);
    f.write("pnpm-workspace.yaml", contents);
    const result = f.check("clients-a");
    assert.equal(result.status, 1, contents);
    assert.deepEqual(f.recordings(), []);
  }
  for (const contents of [
    "{",
    "null",
    JSON.stringify({ name: 42 }),
    JSON.stringify({ name: "@mend/db", scripts: 42 }),
    JSON.stringify({ name: "@mend/db", scripts: { test: false } }),
    JSON.stringify({ name: "@mend/db", scripts: { test: "" } }),
  ]) {
    const f = fixture(t);
    f.write("packages/db/package.json", contents);
    const result = f.check("engines");
    assert.equal(result.status, 1, contents);
    assert.deepEqual(f.recordings(), []);
  }
});

test("malformed command input refuses rather than silently running or checking a default shard", (t) => {
  const f = fixture(t);
  for (const args of [
    [],
    ["unknown"],
    ["toString"],
    ["--check", "engines"],
    ["engines", "--force"],
  ]) {
    const result = f.check(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
    assert.deepEqual(f.recordings(), []);
  }
});

test("child failure preserves its nonzero exit status and output", (t) => {
  const f = fixture(t);
  f.env.RECORD_EXIT_CODE = "23";
  const result = f.check("engines");
  assert.equal(result.status, 23);
  assert.match(result.stdout, /child stdout/);
  assert.match(result.stderr, /child stderr/);
});

for (const failedKind of ["CLI", "other packages"]) {
  test(`a failing ${failedKind} child cancels its sibling and cannot produce green`, (t) => {
    const f = fixture(t);
    const code = failedKind === "CLI" ? 23 : 31;
    f.env.RECORD_FAILED_KIND = failedKind;
    f.env.RECORD_FAILURE_CODE = String(code);
    f.command(`
const args = process.argv.slice(2);
const kind = args.includes("--filter=@sealant/mend") ? "CLI" : "other packages";
record({ kind, state: "ready" });
process.on("SIGTERM", () => {
  record({ kind, state: "cancelled" });
  process.exit(0);
});
setInterval(() => {
  const files = fs.readdirSync(process.cwd()).filter((file) => /^command\\.json-\\d+$/.test(file));
  if (files.length === 2 && kind === process.env.RECORD_FAILED_KIND) {
    record({ kind, state: "failed" });
    process.exit(Number(process.env.RECORD_FAILURE_CODE));
  }
}, 10);
`);
    const result = f.check("clients-a");
    assert.equal(result.status, code, result.stderr);
    const records = f.recordings();
    assert.equal(records.length, 2);
    assert.ok(records.some((entry) => entry.kind === failedKind && entry.state === "failed"));
    assert.ok(records.some((entry) => entry.kind !== failedKind && entry.state === "cancelled"));
  });
}

test("both lanes in every mode must start before either can complete", (t) => {
  const f = fixture(t);
  f.command(`
record({ args: process.argv.slice(2) });
setInterval(() => {
  const files = fs.readdirSync(process.cwd()).filter((file) => /^command\\.json-\\d+$/.test(file));
  if (files.length === 2) process.exit(0);
}, 10);
`);
  for (const mode of ["engines", "clients-a", "clients-b"]) {
    f.clearRecordings();
    const result = f.check(mode);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.recordings().length, 2);
  }
});

test("a sibling wrapper that ignores TERM is killed within the bounded cleanup grace", (t) => {
  const f = fixture(t);
  f.command(`
const kind = process.argv.includes("--filter=@sealant/mend") ? "CLI" : "other packages";
process.on("SIGTERM", () => record({ kind, state: "ignored SIGTERM" }));
record({ kind, state: "ready" });
setInterval(() => {
  const files = fs.readdirSync(process.cwd()).filter((file) => /^command\\.json-\\d+$/.test(file));
  if (files.length === 2 && kind === "CLI") {
    record({ kind, state: "failed" });
    process.exit(37);
  }
}, 10);
`);
  const started = Date.now();
  const result = f.check("clients-a");
  assert.equal(result.status, 37, result.stderr);
  assert.ok(Date.now() - started < 5_000, "cleanup must not wait indefinitely for TERM");
  assert.ok(
    f
      .recordings()
      .some((entry) => entry.kind === "other packages" && entry.state === "ignored SIGTERM"),
  );
});

test("a missing pnpm executable cannot report success", (t) => {
  const f = fixture(t);
  f.env.PATH = join(f.root, "empty-bin");
  const result = f.check("clients-a");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot start pnpm/);
});

test("child termination preserves the signal instead of producing a successful check", (t) => {
  const f = fixture(t);
  f.command('process.kill(process.pid, "SIGTERM");');
  const result = f.check("clients-b");
  assert.equal(result.status, null);
  assert.equal(result.signal, "SIGTERM");
});

test(
  "the wrapper forwards cancellation to both children and remains interrupted after graceful cleanup",
  { timeout: 10_000 },
  async (t) => {
    const f = fixture(t);
    f.command(`
process.on("SIGTERM", () => {
  record({ state: "received SIGTERM" });
  process.exit(0);
});
record({ state: "ready" });
setInterval(() => {}, 100);
`);
    const child = spawn(process.execPath, [join(f.root, "scripts/ci-shards.mjs"), "clients-a"], {
      env: f.env,
      stdio: "pipe",
      detached: true,
    });
    t.after(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    const closed = once(child, "close");
    const deadline = Date.now() + 5_000;
    while (f.recordings().length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      f.recordings().map((entry) => entry.state),
      ["ready", "ready"],
    );
    child.kill("SIGTERM");
    const [code, signal] = await closed;
    assert.equal(code, null);
    assert.equal(signal, "SIGTERM");
    assert.deepEqual(
      f.recordings().map((entry) => entry.state),
      ["received SIGTERM", "received SIGTERM"],
    );
  },
);

for (const outcome of ["failure", "cancellation"]) {
  test(
    `${outcome} cleans up both process groups after their wrappers exit and descendants ignore TERM`,
    { timeout: 10_000 },
    async (t) => {
      const f = fixture(t);
      f.env.RECORD_OUTCOME = outcome;
      f.command(`
const { spawn } = require("node:child_process");
const kind = process.argv.includes("--filter=@sealant/mend") ? "CLI" : "other packages";
const descendantProgram = [
  'const fs = require("node:fs");',
  'const file = "descendant-" + process.pid;',
  'process.on("SIGTERM", () => fs.writeFileSync(file, "ignored SIGTERM"));',
  'fs.writeFileSync(file, "ready");',
  'setInterval(() => {}, 100);',
].join("\\n");
const descendant = spawn(process.execPath, ["-e", descendantProgram], { stdio: "ignore" });
process.on("SIGTERM", () => {
  record({ kind, descendant: descendant.pid, state: "wrapper ended" });
  process.exit(0);
});
let ready = false;
setInterval(() => {
  if (!ready && fs.existsSync("descendant-" + descendant.pid)) {
    ready = true;
    record({ kind, descendant: descendant.pid, state: "ready" });
  }
  const files = fs.readdirSync(process.cwd()).filter((file) => /^command\\.json-\\d+$/.test(file));
  if (ready && files.length === 2 && process.env.RECORD_OUTCOME === "failure" && kind === "CLI") {
    record({ kind, descendant: descendant.pid, state: "failed" });
    process.exit(29);
  }
}, 10);
`);
      let result;
      if (outcome === "failure") {
        result = f.check("clients-b");
        assert.equal(result.status, 29, result.stderr);
      } else {
        const child = spawn(
          process.execPath,
          [join(f.root, "scripts/ci-shards.mjs"), "clients-b"],
          {
            cwd: tmpdir(),
            env: f.env,
            stdio: "pipe",
            detached: true,
          },
        );
        t.after(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        });
        const closed = once(child, "close");
        const deadline = Date.now() + 5_000;
        while (f.recordings().length < 2 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(f.recordings().length, 2);
        child.kill("SIGTERM");
        const [code, signal] = await closed;
        assert.equal(code, null);
        assert.equal(signal, "SIGTERM");
      }
      const records = f.recordings();
      assert.equal(records.length, 2);
      for (const entry of records) {
        assert.equal(
          readFileSync(join(f.root, `descendant-${entry.descendant}`), "utf8"),
          "ignored SIGTERM",
        );
        let state = null;
        try {
          state = readFileSync(`/proc/${entry.descendant}/stat`, "utf8").match(/\) (\S) /)?.[1];
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        assert.ok(
          state === null || state === "Z",
          `descendant ${entry.descendant} still runs (${state})`,
        );
      }
    },
  );
}
