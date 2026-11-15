// The suites that need a real Docker engine and otherwise skip: the server's first setup on Docker
// (volume ownership, the official Postgres bootstrap) and Undo on a mounted per-person workspace.
// Each opts in through its own variable; this runner sets it, and fails when a case skips, so a
// renamed gate cannot turn the job into a label.
//   node scripts/docker-suites.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const suites = [
  {
    filter: "@sealant/mend",
    file: "src/server-docker-protocol.test.ts",
    env: { MEND_DOCKER_TEST_CONTEXT: "default" },
    images: [],
  },
  {
    filter: "@sealant/mend",
    file: "src/server-postgres-bootstrap.test.ts",
    env: { MEND_DOCKER_TEST_CONTEXT: "default" },
    images: ["postgres:17-alpine"],
  },
  {
    filter: "@mend/sessions",
    file: "test/rollback-mounted-layout.test.ts",
    env: { MEND_TEST_ROLLBACK_MOUNT: "1" },
    images: ["node:26-trixie"],
  },
];

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} exited ${result.status}`);
};

// Each suite runs its containers with --pull=never.
for (const image of new Set(suites.flatMap((suite) => suite.images))) {
  run("docker", ["pull", "--quiet", image]);
}
const scratch = mkdtempSync(join(tmpdir(), "mend-docker-suites-"));
try {
  for (const [index, suite] of suites.entries()) {
    const report = join(scratch, `${index}.json`);
    run(
      "pnpm",
      [
        "--filter",
        suite.filter,
        "exec",
        "vitest",
        "run",
        suite.file,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${report}`,
      ],
      { env: { ...process.env, ...suite.env } },
    );
    const cases = JSON.parse(readFileSync(report, "utf8")).testResults.flatMap(
      (file) => file.assertionResults,
    );
    assert.ok(cases.length > 0, `${suite.file} ran no cases`);
    const unpassed = cases.filter((entry) => entry.status !== "passed");
    assert.deepEqual(
      unpassed.map((entry) => `${entry.status}: ${entry.fullName}`),
      [],
      `${suite.file}: every case must run and pass`,
    );
    console.log(`Observed ${cases.length} executed cases in ${suite.file}.`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
