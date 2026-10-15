#!/usr/bin/env node
// Proves no build output reads a test file its build task does not hash. Turbo is asked which
// files every build task hashes; the probe set is each test, spec and vitest config file no build
// task hashes. Every build runs twice as it is (which outputs vary on their own), then once with a
// unique import, string, Tailwind class and type error appended to every file in the probe set.
// A build whose outputs, file set or exit code change, or whose outputs carry the marker, reads a
// file its cache key leaves out. Builds run with every cache off: a mutated output must never be
// stored under the clean hash. The files are restored before it exits.
// Usage: node scripts/ci-build-input-probe.mjs
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const turbo = path.join(repository, "node_modules/turbo/bin/turbo");
const env = { ...process.env, TURBO_TELEMETRY_DISABLED: "1" };
for (const name of ["TURBO_API", "TURBO_TOKEN", "TURBO_TEAM", "TURBO_REMOTE_CACHE_SIGNATURE_KEY"])
  delete env[name];

const runTurbo = (args, stdio = "pipe") =>
  execFileSync(process.execPath, [turbo, ...args], {
    cwd: repository,
    env,
    encoding: "utf8",
    stdio: ["ignore", stdio, stdio],
    maxBuffer: 64 * 1024 * 1024,
  });
const buildTasks = () => JSON.parse(runTurbo(["run", "build", "--dry=json"])).tasks;

const testFile =
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)vitest(?:\.[\w-]+)?\.config\.[cm]?[jt]s$/;
const tasks = buildTasks();
const builds = tasks.filter((task) => task.command && task.command !== "<NONEXISTENT>");
const hashed = new Set(
  tasks.flatMap((task) =>
    Object.keys(task.inputs).map((file) => path.normalize(path.join(task.directory, file))),
  ),
);
const tracked = execFileSync("git", ["ls-files"], { cwd: repository, encoding: "utf8" })
  .trim()
  .split("\n");
const probeSet = tracked.filter((file) => testFile.test(file) && !hashed.has(path.normalize(file)));

const outputFiles = (task) => {
  const root = path.join(repository, task.directory);
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".turbo") walk(full);
      } else if (task.outputs.some((glob) => path.matchesGlob(path.relative(root, full), glob))) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found.toSorted();
};
const snapshot = () =>
  Object.fromEntries(
    builds.map((task) => [
      task.taskId,
      Object.fromEntries(
        outputFiles(task).map((file) => [
          path.relative(repository, file),
          createHash("sha256").update(readFileSync(file)).digest("hex"),
        ]),
      ),
    ]),
  );
const build = () => {
  const started = Date.now();
  try {
    runTurbo(
      [
        "run",
        "build",
        "--continue",
        "--summarize",
        "--cache=local:,remote:",
        ...builds.map((task) => `--filter=${task.package}`),
      ],
      "ignore",
    );
  } catch {
    // Exit codes are read per task from the run summary below.
  }
  const runs = path.join(repository, ".turbo/runs");
  const latest = readdirSync(runs)
    .map((name) => path.join(runs, name))
    .filter((file) => statSync(file).mtimeMs >= started)
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  const summary = JSON.parse(readFileSync(latest, "utf8"));
  return {
    exit: Object.fromEntries(
      summary.tasks.map((task) => [task.taskId, task.execution?.exitCode ?? null]),
    ),
    outputs: snapshot(),
  };
};

const token = `ciprobe${randomBytes(4).toString("hex")}`;
let color;
do color = randomBytes(3).toString("hex");
while (color[0] === color[1] && color[2] === color[3] && color[4] === color[5]);
const block = (file) => {
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

const first = build();
const second = build();
const hashesBefore = Object.fromEntries(builds.map((task) => [task.taskId, task.hash]));
const originals = new Map(
  probeSet.map((file) => [file, readFileSync(path.join(repository, file))]),
);
let mutated;
let hashesAfter;
try {
  for (const file of probeSet)
    writeFileSync(
      path.join(repository, file),
      Buffer.concat([originals.get(file), Buffer.from(block(file))]),
    );
  hashesAfter = Object.fromEntries(
    buildTasks()
      .filter((task) => hashesBefore[task.taskId])
      .map((task) => [task.taskId, task.hash]),
  );
  mutated = build();
} finally {
  for (const [file, contents] of originals) writeFileSync(path.join(repository, file), contents);
}

const violations = [];
const markers = [Buffer.from(token), Buffer.from(color), Buffer.from(color.toUpperCase())];
for (const task of builds) {
  const id = task.taskId;
  if (hashesAfter[id] !== hashesBefore[id])
    violations.push(`${id}: its hash changed, so the probe set is wrong`);
  if (mutated.exit[id] !== second.exit[id])
    violations.push(`${id}: exit ${second.exit[id]} became ${mutated.exit[id]}`);
  const [a, b, c] = [first.outputs[id], second.outputs[id], mutated.outputs[id]];
  const names = (outputs) => Object.keys(outputs).toSorted().join("\n");
  if (names(b) !== names(c)) violations.push(`${id}: its output files differ`);
  for (const [file, digest] of Object.entries(c)) {
    if (a[file] === b[file] && b[file] !== undefined && digest !== b[file])
      violations.push(`${id}: ${file} changed`);
    const bytes = readFileSync(path.join(repository, file));
    if (markers.some((marker) => bytes.includes(marker)))
      violations.push(`${id}: ${file} carries the probe marker`);
  }
}
const volatile = builds.flatMap((task) =>
  Object.keys(second.outputs[task.taskId]).filter(
    (file) => first.outputs[task.taskId][file] !== second.outputs[task.taskId][file],
  ),
);
console.log(
  JSON.stringify(
    {
      token,
      color,
      builds: builds.map((task) => task.taskId),
      probedFiles: probeSet.length,
      outputs: Object.fromEntries(
        builds.map((task) => [task.taskId, Object.keys(second.outputs[task.taskId]).length]),
      ),
      volatile,
      exit: second.exit,
      violations,
    },
    null,
    2,
  ),
);
process.exitCode = violations.length ? 1 : 0;
