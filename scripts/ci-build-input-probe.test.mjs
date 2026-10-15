import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { probe, VOLATILE } from "./ci-build-input-probe.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));

/** A two-package workspace with the repository's own turbo.json, so its build-input rule is the one probed. */
const workspace = (t, packages, options = () => ({})) => {
  const root = mkdtempSync(join(tmpdir(), "mend-build-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  write(
    "package.json",
    JSON.stringify({ name: "build-probe", private: true, packageManager: "pnpm@10.32.1" }),
  );
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'\nimporters:\n  .: {}\n${Object.keys(packages)
      .map((name) => `  packages/${name}: {}\n`)
      .join("")}`,
  );
  write(".gitignore", "node_modules/\n.turbo/\ndist/\n");
  write(
    "turbo.json",
    execFileSync("git", ["show", "HEAD:turbo.json"], { cwd: repository, encoding: "utf8" }),
  );
  for (const [name, { build, files = {}, turbo }] of Object.entries(packages)) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name, scripts: { build: "node build.cjs" } }),
    );
    write(`packages/${name}/build.cjs`, build);
    write(`packages/${name}/src/a.test.mjs`, "export const checked = 1;\n");
    for (const [file, text] of Object.entries(files)) write(`packages/${name}/${file}`, text);
    if (turbo) write(`packages/${name}/turbo.json`, JSON.stringify(turbo));
  }
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=probe", "-c", "user.email=probe@example.invalid", ...args],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "workspace");
  return probe(root, options(root));
};

const writes = (text) =>
  `const fs=require("node:fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/out",${text});\n`;

test("a build that reads no test file passes", (t) => {
  const result = workspace(t, { quiet: { build: writes('"fixed"') } });
  assert.deepEqual(result.violations, []);
  assert.equal(result.probed["quiet#build"], 1);
});

test("a build that reads its own excluded test file fails", (t) => {
  const result = workspace(t, {
    reader: { build: writes('fs.readFileSync("src/a.test.mjs","utf8")') },
  });
  assert.ok(
    result.violations.some((line) =>
      line.startsWith("reader#build: packages/reader/dist/out changed"),
    ),
    result.violations.join("\n"),
  );
  assert.ok(result.violations.some((line) => line.includes("carries the probe marker")));
});

test("a test file one build hashes is still probed for another build that reads it", (t) => {
  const result = workspace(t, {
    owner: {
      build: writes('"owner"'),
      turbo: { extends: ["//"], tasks: { build: { inputs: ["$TURBO_DEFAULT$"] } } },
    },
    reader: { build: writes('fs.readFileSync("../owner/src/a.test.mjs","utf8")') },
  });
  assert.equal(result.probed["owner#build"], 1, "the owner's own test is in its hash");
  assert.ok(
    result.violations.some((line) =>
      line.startsWith("reader#build: packages/reader/dist/out changed"),
    ),
    result.violations.join("\n"),
  );
});

test("an output that varies between unchanged builds fails instead of hiding a change", (t) => {
  const result = workspace(t, {
    reader: {
      build: writes(
        'JSON.stringify({timestamp:Date.now(),contentHash:require("node:crypto").createHash("sha256").update(fs.readFileSync("src/a.test.mjs")).digest("hex")})',
      ),
    },
  });
  assert.deepEqual(result.violations, [
    "reader#build: packages/reader/dist/out differs between two unchanged builds, outside the known volatile fields",
  ]);
});

test("a build that fails on its own is a failed probe, not a pass", (t) => {
  const result = workspace(t, { broken: { build: "process.exit(3);\n" } });
  assert.deepEqual(result.violations, [
    "broken#build: the first unchanged build exited 3",
    "broken#build: the second unchanged build exited 3",
  ]);
});

test("a build invocation that fails before writing its run summary fails the probe", (t) => {
  // Real Turbo throughout, except that the third build invocation (the mutated one) dies first.
  const result = workspace(
    t,
    { reader: { build: writes('fs.readFileSync("src/a.test.mjs","utf8")') } },
    (root) => {
      const wrapper = join(root, ".turbo-fault.cjs");
      writeFileSync(
        wrapper,
        `const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "run" && args[1] === "build" && !args.some((arg) => arg.startsWith("--dry"))) {
  const counter = ${JSON.stringify(join(root, ".turbo-fault-count"))};
  const count = Number(fs.existsSync(counter) ? fs.readFileSync(counter, "utf8") : 0) + 1;
  fs.writeFileSync(counter, String(count));
  if (count === 3) process.exit(2);
}
const run = spawnSync(process.execPath, [${JSON.stringify(join(repository, "node_modules/turbo/bin/turbo"))}, ...args], { stdio: "inherit" });
process.exit(run.status ?? 1);
`,
      );
      return { turbo: wrapper };
    },
  );
  assert.deepEqual(result.violations, [
    "reader#build: the build with test files changed: Turbo exited 2 and wrote 0 run summaries, not one",
  ]);
});

test("each known volatile field normalizes alone, and nothing else does", () => {
  const rule = (file) => VOLATILE.find((candidate) => candidate.glob === file).normalize;
  const nitro = rule("apps/web/.output/nitro.json");
  assert.equal(
    nitro('{\n  "date": "2026-10-15T10:28:56.328Z",\n  "preset": "a"\n}'),
    nitro('{\n  "date": "2026-10-16T11:00:00.000Z",\n  "preset": "a"\n}'),
  );
  assert.notEqual(
    nitro('{\n  "date": "x",\n  "preset": "a"\n}'),
    nitro('{\n  "date": "x",\n  "preset": "b"\n}'),
  );
  const server = rule("apps/web/.output/server/index.mjs");
  const entry = (name, mtime, size) =>
    `  "/assets/${name}": {\n    "type": "text/javascript",\n    "mtime": "${mtime}",\n    "size": ${size}\n  }`;
  const assets = (...entries) => `x();\nconst assets = {\n${entries.join(",\n")}\n};\ny();`;
  assert.equal(
    server(
      assets(
        entry("a.js", "2026-10-15T10:28:45.149Z", 1),
        entry("b.js", "2026-10-15T10:28:45.150Z", 2),
      ),
    ),
    server(
      assets(
        entry("b.js", "2026-10-15T11:00:00.000Z", 2),
        entry("a.js", "2026-10-15T11:00:00.001Z", 1),
      ),
    ),
  );
  assert.notEqual(
    server(assets(entry("a.js", "2026-10-15T10:28:45.149Z", 1))),
    server(assets(entry("a.js", "2026-10-15T10:28:45.149Z", 9))),
    "an asset's size is not volatile",
  );
  const page = rule("apps/marketing/dist/**/*.html");
  assert.equal(
    page('{i:"__root__",u:1792060122649,s:"success"}'),
    page('{i:"__root__",u:1792060999999,s:"success"}'),
  );
  assert.notEqual(
    page('{i:"__root__",u:1792060122649,s:"a"}'),
    page('{i:"__root__",u:1792060122649,s:"b"}'),
  );
});
