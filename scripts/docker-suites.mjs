// The suites that need a real Docker engine and otherwise skip: the server's first setup on Docker
// (volume ownership, the official Postgres bootstrap) and Undo on a mounted per-person workspace.
// Beside them, the full sweep of Undo's restore crashed at every write: too many processes for a
// test lane shared with other packages, so the lane runs its quick bound and this runner, one suite
// at a time, the whole of it (SLNT-1029).
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

// The rollback suite's workspace is a test fixture. Docker Hub limits anonymous pulls per runner
// address and CI has no login, so it comes by digest from Docker's official-image mirror on ECR
// Public. The bootstrap suite's Postgres is the official image the server ships, and stays as the
// product names it.
const rollbackImage =
  "public.ecr.aws/docker/library/node:26-trixie@sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac";

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
    env: { MEND_TEST_ROLLBACK_MOUNT: "1", MEND_TEST_ROLLBACK_IMAGE: rollbackImage },
    images: [rollbackImage],
  },
  {
    filter: "@mend/sessions",
    file: "test/rollback-restore-crash.property.test.ts",
    env: { MEND_TEST_ROLLBACK_CRASH_SWEEP: "full" },
    images: [],
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
