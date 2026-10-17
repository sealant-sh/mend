import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

// scripts/ci-scope.mjs skips the mobile and packaging lanes for a change confined to a package's
// test/ directory or its *.test.* / *.spec.* files. That holds only while nothing those lanes build
// or run reaches into them: no production source, build script or packaging script imports a
// package's test/ or an export that points there (packages/db, sessions and store map ./testing
// into test/), and no bundler config, tsconfig paths entry, Dockerfile or gated CI job names them.

const root = fileURLToPath(new URL("../", import.meta.url));
// This file's own fixtures below are the import forms it must catch.
const self = "scripts/test-only-imports.test.mjs";

const code = /\.[cm]?[jt]sx?$/;
const testPath = (path) =>
  /(^|\/)(test|test-fixtures)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path);
// The packaging lane runs these directories' *.test.mjs files and the scripts they drive, so a
// test-named file there still counts: it is what the skipped lane would have run.
const laneScript = (path) =>
  /^(scripts|tooling\/scripts|apps\/[^/]+\/scripts|\.claude\/skills\/[^/]+\/scripts)\//.test(path);

/** Tracked and untracked-but-not-ignored code that the mobile and packaging lanes may reach. */
const isConsumer = (path) =>
  code.test(path) &&
  !/(^|\/)vitest(\.[^/]+)?\.config\.[cm]?[jt]s$/.test(path) &&
  (!testPath(path) || laneScript(path));

// Configs that decide what a build bundles, resolves or copies. Vitest configs and anything under
// a test directory are test configs and may name test files.
const isConfig = (path) =>
  !testPath(path) &&
  (/(^|\/)tsconfig[^/]*\.json$/.test(path) ||
    /(^|\/)(vite|electron\.vite|tsup|esbuild|metro|babel)\.config\.[cm]?[jt]s$/.test(path) ||
    /(^|\/)(Dockerfile|[^/]+\.Dockerfile)$/.test(path));

// An export's target paths, through any nesting of conditions.
const targets = (value) =>
  typeof value === "string"
    ? [value]
    : value && typeof value === "object"
      ? Object.values(value).flatMap(targets)
      : [];

/** Every `packages/*` export that resolves into test/, or is named ./testing, by package name. */
const testExports = (manifests) =>
  new Map(
    manifests.map(({ name, exports }) => [
      name,
      Object.entries(exports ?? {})
        .filter(
          ([key, value]) =>
            /^\.\/testing(\/|$)/.test(key) ||
            targets(value).some((target) => /^\.\/test(\/|$)/.test(target)),
        )
        .map(([key]) => key.slice(2)),
    ]),
  );

// `from "x"` covers `import … from` and `export … from`; then side-effect `import "x"`, dynamic
// `import("x")`, `require("x")`, `require.resolve("x")` and `import.meta.resolve("x")`.
const specifiers = (text) =>
  [
    ...text.matchAll(
      /(?:\bfrom|\bimport|\brequire(?:\.resolve)?|\bimport\.meta\.resolve)\s*\(?\s*(["'`])([^"'`\n]+)\1/g,
    ),
  ].map((match) => match[2]);

/**
 * Why `reference`, read from `file` (relative paths against `base`), reaches a package's tests, if
 * it does. `loose` also counts a bare `…/testing` path, as configs and CI steps may write one; a
 * source file's own relative `./testing/…` module is not a package export.
 */
const reachesTests = (reference, file, exported, base = dirname(file), loose = false) => {
  const scoped = /^(@mend\/[^/]+)(?:\/(.*))?$/.exec(reference);
  if (scoped) {
    const [, name, subpath = ""] = scoped;
    const keys = exported.get(name) ?? [];
    if (/^test(\/|$)/.test(subpath) || /^testing(\/|$)/.test(subpath)) return `${name}/${subpath}`;
    if (keys.some((key) => subpath === key || subpath.startsWith(`${key}/`)))
      return `${name}/${subpath}`;
    return undefined;
  }
  if (/(^|\/)packages\/[^/]+\/test(\/|$)/.test(reference)) return reference;
  if (loose && /\/testing(\/|$)/.test(reference)) return reference;
  if (reference.startsWith("./") || reference.startsWith("../")) {
    const target = posix.normalize(posix.join(base, reference));
    if (/^packages\/[^/]+\/test(\/|$)/.test(target)) return target;
  }
  return undefined;
};

const stripJsonc = (text) =>
  text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");

const tokens = (text) => text.split(/[\s"'`,()[\]{}=;]+/).filter(Boolean);

/**
 * Every place a consumer reaches a package's tests. `files` maps repository paths to contents;
 * `workflow` is the parsed CI workflow, whose jobs gated on the mobile or packaging scope must not
 * name test paths either.
 */
const findTestReaches = ({ files, manifests, workflow }) => {
  const exported = testExports(manifests);
  const found = [];
  for (const [file, text] of files) {
    if (isConsumer(file)) {
      for (const reference of specifiers(text)) {
        const reached = reachesTests(reference, file, exported);
        if (reached) found.push(`${file}: imports ${reference} (${reached})`);
      }
    }
    if (isConfig(file)) {
      let scanned = text;
      if (file.endsWith(".json")) {
        const paths = JSON.parse(stripJsonc(text)).compilerOptions?.paths ?? {};
        scanned = Object.entries(paths).flat(2).join("\n");
      }
      // A Dockerfile's sources are relative to its build context, the repository root.
      const base = file.endsWith("Dockerfile") ? "." : dirname(file);
      for (const token of tokens(scanned)) {
        const reached = reachesTests(token, file, exported, base, true);
        if (reached) found.push(`${file}: references ${token} (${reached})`);
      }
    }
  }
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    if (!/needs\.changes\.outputs\.(mobile|packaging)\b/.test(String(job.if ?? ""))) continue;
    for (const token of tokens(JSON.stringify(job.steps ?? []))) {
      const reached = reachesTests(token, ".github/workflows/ci.yml", exported, ".", true);
      if (reached) found.push(`.github/workflows/ci.yml job ${name}: references ${token}`);
    }
  }
  return found;
};

const repository = () => {
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((path) => path && path !== self && (isConsumer(path) || isConfig(path)))
    .filter((path) => existsSync(resolve(root, path)));
  const manifests = execFileSync("git", ["ls-files", "-z", "packages/*/package.json"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((path) => JSON.parse(readFileSync(resolve(root, path), "utf8")));
  return {
    files: new Map(paths.map((path) => [path, readFileSync(resolve(root, path), "utf8")])),
    manifests,
    workflow: parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")),
  };
};

test("no production source, build or packaging script, config or gated job reaches a package's tests", () => {
  const tree = repository();
  // The guard must see the ./testing exports it exists for, read from the manifests.
  const exported = testExports(tree.manifests);
  for (const name of ["@mend/db", "@mend/sessions", "@mend/store"]) {
    assert.deepEqual(exported.get(name), ["testing"], name);
  }
  for (const path of ["apps/api/src/access.ts", "scripts/bundle-health.mjs", "Dockerfile"]) {
    assert.ok(tree.files.has(path), `the scan must include ${path}`);
  }
  assert.deepEqual(findTestReaches(tree), []);
});

test("the guard catches every import form, path form and config, and exempts tests", () => {
  const manifests = [
    {
      name: "@mend/sessions",
      exports: { ".": "./src/index.ts", "./testing": "./test/testing.ts" },
    },
    { name: "@mend/kit", exports: { "./fixtures": { import: "./test/fixtures.ts" } } },
    { name: "@mend/domain", exports: { ".": "./src/index.ts" } },
  ];
  const reaches = (path, text) =>
    findTestReaches({ files: new Map([[path, text]]), manifests, workflow: undefined });
  for (const [path, text] of [
    ["apps/api/src/a.ts", 'import { fixture } from "@mend/sessions/testing";'],
    ["apps/api/src/a.ts", "import type {\n  Fixture,\n} from '@mend/sessions/testing/deep';"],
    ["apps/api/src/a.ts", 'export * from "@mend/sessions/testing";'],
    ["apps/api/src/a.ts", 'export { a } from "@mend/kit/fixtures";'],
    ["apps/api/src/a.ts", 'const m = await import("@mend/sessions/testing");'],
    ["apps/api/src/a.cjs", 'const m = require("@mend/sessions/testing");'],
    ["apps/api/src/a.ts", 'import "@mend/domain/test/helper.ts";'],
    ["packages/store/src/a.ts", 'import { x } from "../test/capture-fixture.ts";'],
    ["apps/api/src/a.ts", 'import { x } from "../../../packages/db/test/postgres.ts";'],
    ["scripts/bundle.mjs", 'import("/repo/packages/db/test/postgres.ts");'],
    ["scripts/packaging.test.mjs", 'import { x } from "../packages/db/test/postgres.ts";'],
    ["tooling/scripts/bundle-app.mjs", 'require.resolve("@mend/sessions/testing")'],
    ["apps/web/vite.config.ts", 'alias: { x: "../../packages/db/test/postgres.ts" }'],
    [
      "apps/web/tsconfig.json",
      '{ "compilerOptions": { "paths": { "x": ["../../packages/db/test/*"] } } }',
    ],
    [
      "apps/web/tsconfig.json",
      '{ // c\n "compilerOptions": { "paths": { "t/*": ["@mend/sessions/testing"] }, } }',
    ],
    ["Dockerfile", "COPY packages/sessions/test ./fixtures"],
    ["apps/web/vite.config.ts", 'alias: { "#fixtures": "src/testing/fixtures.ts" }'],
    ["apps/api/Dockerfile", "COPY ./packages/db/test/postgres.ts /app/"],
  ]) {
    assert.equal(reaches(path, text).length, 1, `${path}: ${text}`);
  }
  for (const [path, text] of [
    ["packages/sessions/test/engine.test.ts", 'import { f } from "@mend/sessions/testing";'],
    ["apps/api/src/route.test.ts", 'import { f } from "@mend/db/testing";'],
    ["apps/api/src/route.spec.tsx", 'import { f } from "../../../packages/db/test/postgres.ts";'],
    ["apps/cli/test-fixtures/server.mjs", 'import "@mend/sessions/testing";'],
    ["packages/db/vitest.config.ts", 'import { setup } from "./test/setup.ts";'],
    [
      "apps/api/src/a.ts",
      'import { a } from "@mend/sessions"; import { b } from "@mend/domain/ids";',
    ],
    ["apps/web/src/a.ts", 'import { a } from "./testing/view.ts";'],
    ["apps/api/src/a.ts", 'const note = "write packages/db/test/x.ts"; // packaging: testing'],
    ["packages/db/tsconfig.json", '{ "include": ["src", "test"] }'],
    ["packages/sessions/test/fixtures/shell-profile/Dockerfile", "COPY packages/sessions/test ."],
  ]) {
    assert.deepEqual(reaches(path, text), [], `${path}: ${text}`);
  }
  const gated = (job) =>
    findTestReaches({
      files: new Map(),
      manifests,
      workflow: {
        jobs: {
          [job.name]: {
            if: job.if,
            steps: [{ run: "docker build packages/sessions/test/fixtures/x" }],
          },
        },
      },
    });
  assert.equal(
    gated({ name: "packaging", if: "needs.changes.outputs.packaging != 'false'" }).length,
    1,
  );
  assert.equal(
    gated({ name: "mobile-web", if: "needs.changes.outputs.mobile != 'false'" }).length,
    1,
  );
  assert.deepEqual(gated({ name: "test-engines", if: "!cancelled()" }), []);
});
