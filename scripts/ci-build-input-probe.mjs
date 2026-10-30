#!/usr/bin/env node
// Proves every build task hashes the test files it reads. For each build task, Turbo names every
// file that can change its hash: its own inputs and those of every task it depends on. Every other
// test, spec and vitest config file gets a unique import, string, Tailwind class and type error
// appended, and the build must produce what it produced unchanged. Two unchanged builds of every
// task come first: each must succeed, and their outputs must match exactly once the fields in
// VOLATILE below are normalized, so unknown nondeterminism fails rather than hiding a change.
// Builds run with every cache off: a mutated output is never stored under a clean hash. Files are
// restored before it returns.
// Usage: node scripts/ci-build-input-probe.mjs [repository]
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("../", import.meta.url));
const testFile =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)vitest(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/;

/** Output fields that change on every build, by path: each normalizer touches only its field. */
export const VOLATILE = [
  {
    // Nitro stamps its build time.
    glob: "apps/web/.output/nitro.json",
    normalize: (text) =>
      text.replace(/^(\s{2}"date": )"\d{4}-\d\d-\d\dT[\d:.]+Z"/m, '$1"<build time>"'),
  },
  {
    // Nitro's public-asset map: each entry's file mtime, and the entries' order.
    glob: "apps/web/.output/server/index.mjs",
    normalize: (text) =>
      text.replace(/^var public_assets_data_default = \{\n([\s\S]*?)\n\};$/m, (_, body) => {
        const entries = body
          .split(/\n(?=\t")/)
          .map((entry) =>
            entry.replace(/,$/, "").replace(/("mtime": )"\d{4}-\d\d-\d\dT[\d:.]+Z"/, '$1"<mtime>"'),
          );
        return `var public_assets_data_default = {\n${entries.toSorted().join(",\n")}\n};`;
      }),
  },
  {
    // TanStack Router's dehydrated matches carry the time they were rendered.
    glob: "apps/marketing/dist/**/*.html",
    normalize: (text) => text.replace(/(\{i:"[^"]*",u:)\d{13}/g, "$1<render time>"),
  },
];

const markerBlock = (file, token, color) => {
  const ext = path.extname(file);
  if (ext === ".cjs")
    return `\nrequire("./${token}-missing.cjs");\nmodule.exports.${token} = ["${token}", "bg-[#${color}]"];\n`;
  const typed = [".ts", ".tsx", ".mts", ".cts"].includes(ext);
  return [
    "",
    `import "./${token}-missing.js";`,
    `export const ${token}Literal = "${token}";`,
    `export const ${token}Class = "bg-[#${color}]";`,
    typed ? `export const ${token}Type: string = 123;` : "",
    "",
  ].join("\n");
};

export const probe = (
  repository,
  { turbo = path.join(here, "node_modules/turbo/bin/turbo"), log = () => {} } = {},
) => {
  const env = { ...process.env, TURBO_TELEMETRY_DISABLED: "1" };
  for (const name of ["TURBO_API", "TURBO_TOKEN", "TURBO_TEAM", "TURBO_REMOTE_CACHE_SIGNATURE_KEY"])
    delete env[name];
  const runTurbo = (args) =>
    execFileSync(process.execPath, [turbo, ...args], {
      cwd: repository,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  const dry = () => JSON.parse(runTurbo(["run", "build", "--dry=json"])).tasks;
  const tasks = dry();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const builds = tasks.filter((task) => task.command && task.command !== "<NONEXISTENT>");
  const hashedBy = (task) => {
    const files = new Set();
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id) || !byId.has(id)) return;
      seen.add(id);
      const node = byId.get(id);
      for (const file of Object.keys(node.inputs))
        files.add(path.normalize(path.join(node.directory, file)));
      for (const dependency of node.dependencies ?? []) visit(dependency);
    };
    visit(task.taskId);
    return files;
  };
  const tracked = execFileSync("git", ["ls-files"], { cwd: repository, encoding: "utf8" })
    .trim()
    .split("\n");
  const tests = tracked.filter((file) => testFile.test(file));

  const outputFiles = (task) => {
    const root = path.join(repository, task.directory);
    const found = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && entry.name !== ".turbo") walk(full);
        } else if (task.outputs.some((glob) => path.matchesGlob(path.relative(root, full), glob))) {
          found.push(path.relative(repository, full));
        }
      }
    };
    walk(root);
    return found.toSorted();
  };
  const unmatched = new Set();
  const digest = (file) => {
    const bytes = readFileSync(path.join(repository, file));
    const rule = VOLATILE.find((candidate) => path.matchesGlob(file, candidate.glob));
    if (!rule) return createHash("sha256").update(bytes).digest("hex");
    const text = bytes.toString("utf8");
    const content = rule.normalize(text);
    if (content === text)
      unmatched.add(`the volatile rule for ${rule.glob} matched nothing in ${file}`);
    return createHash("sha256").update(content).digest("hex");
  };
  // A run is read only from the one summary its own invocation wrote: a summary is never chosen by
  // time, and a run that failed or wrote none fails the probe instead of reusing an earlier run's.
  const runs = path.join(repository, ".turbo/runs");
  const summaries = () => {
    try {
      return new Set(readdirSync(runs));
    } catch {
      return new Set();
    }
  };
  const build = (selected) => {
    const before = summaries();
    let status = 0;
    try {
      runTurbo([
        "run",
        "build",
        "--continue",
        "--summarize",
        "--cache=local:,remote:",
        ...selected.map((task) => `--filter=${task.package}`),
      ]);
    } catch (error) {
      status = typeof error.status === "number" ? error.status : 1;
    }
    const fresh = [...summaries()].filter((name) => !before.has(name));
    if (fresh.length !== 1)
      return { failure: `Turbo exited ${status} and wrote ${fresh.length} run summaries, not one` };
    const exits = Object.fromEntries(
      JSON.parse(readFileSync(path.join(runs, fresh[0]), "utf8")).tasks.map((task) => [
        task.taskId,
        task.execution?.exitCode ?? null,
      ]),
    );
    if (status !== 0 && selected.every((task) => exits[task.taskId] === 0))
      return { failure: `Turbo exited ${status} though every selected build reported success` };
    return {
      failure: null,
      tasks: Object.fromEntries(
        selected.map((task) => [
          task.taskId,
          {
            exit: exits[task.taskId] ?? null,
            outputs: Object.fromEntries(outputFiles(task).map((file) => [file, digest(file)])),
          },
        ]),
      ),
    };
  };
  const differences = (expected, actual) => {
    const found = [];
    for (const file of new Set([...Object.keys(expected), ...Object.keys(actual)]))
      if (expected[file] !== actual[file]) found.push(file);
    return found.toSorted();
  };

  const violations = [];
  log(`controls: ${builds.length} build tasks, twice`);
  const firstRun = build(builds);
  const secondRun = build(builds);
  for (const [label, run] of [
    ["first", firstRun],
    ["second", secondRun],
  ])
    if (run.failure) violations.push(`the ${label} unchanged build: ${run.failure}`);
  violations.push(...unmatched);
  if (violations.length)
    return { builds: builds.map((task) => task.taskId), probed: {}, violations };
  const first = firstRun.tasks;
  const second = secondRun.tasks;
  for (const task of builds) {
    const id = task.taskId;
    for (const [label, run] of [
      ["first", first],
      ["second", second],
    ])
      if (run[id].exit !== 0)
        violations.push(`${id}: the ${label} unchanged build exited ${run[id].exit}`);
    for (const file of differences(first[id].outputs, second[id].outputs))
      violations.push(
        `${id}: ${file} differs between two unchanged builds, outside the known volatile fields`,
      );
  }
  if (violations.length)
    return { builds: builds.map((task) => task.taskId), probed: {}, violations };

  const token = `ciprobe${randomBytes(4).toString("hex")}`;
  let color;
  do color = randomBytes(3).toString("hex");
  while (color[0] === color[1] && color[2] === color[3] && color[4] === color[5]);
  const markers = [token, color, color.toUpperCase()].map((text) => Buffer.from(text));
  const probed = {};
  for (const task of builds) {
    const id = task.taskId;
    const hashed = hashedBy(task);
    const set = tests.filter((file) => !hashed.has(path.normalize(file)));
    probed[id] = set.length;
    log(`${id}: ${set.length} test files outside its hash`);
    if (set.length === 0) continue;
    const originals = new Map(set.map((file) => [file, readFileSync(path.join(repository, file))]));
    let mutated;
    let hashAfter;
    try {
      for (const file of set)
        writeFileSync(
          path.join(repository, file),
          Buffer.concat([originals.get(file), Buffer.from(markerBlock(file, token, color))]),
        );
      hashAfter = dry().find((candidate) => candidate.taskId === id)?.hash;
      mutated = build([task]);
    } finally {
      for (const [file, contents] of originals)
        writeFileSync(path.join(repository, file), contents);
    }
    if (hashAfter !== task.hash)
      violations.push(`${id}: its hash changed, so the files outside it were computed wrong`);
    if (mutated.failure) {
      violations.push(`${id}: the build with test files changed: ${mutated.failure}`);
      continue;
    }
    mutated = mutated.tasks[id];
    if (mutated.exit !== 0)
      violations.push(`${id}: exited ${mutated.exit} once test files outside its hash changed`);
    for (const file of differences(second[id].outputs, mutated.outputs))
      violations.push(`${id}: ${file} changed when test files outside its hash changed`);
    for (const file of Object.keys(mutated.outputs)) {
      const bytes = readFileSync(path.join(repository, file));
      if (markers.some((marker) => bytes.includes(marker)))
        violations.push(`${id}: ${file} carries the probe marker`);
    }
  }
  return { builds: builds.map((task) => task.taskId), probed, violations };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = path.resolve(process.argv[2] ?? here);
  const result = probe(repository, { log: (line) => console.error(line) });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.violations.length ? 1 : 0;
}
