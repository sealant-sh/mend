// THROWAWAY (SLNT-952): proves CI's retry and flake record end to end. Removed before merge.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

const counter = join(
  tmpdir(),
  `mend-flaky-probe-${process.env["GITHUB_RUN_ID"] ?? "local"}-${process.env["GITHUB_RUN_ATTEMPT"] ?? "1"}`,
);

it("fails on its first attempt and passes on its retry", () => {
  const attempt = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 1;
  writeFileSync(counter, String(attempt));
  console.error(`probe: GITHUB_STEP_SUMMARY=${process.env["GITHUB_STEP_SUMMARY"] ?? "<unset>"}`);
  expect(attempt, "the first attempt fails on purpose").toBeGreaterThan(1);
});
