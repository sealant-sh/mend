import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { CI_FILE_BUDGET_MS } from "../test-ci/src/file-budget.ts";

// A test file on course to break CI's per-file limit (CI_FILE_BUDGET_MS), named before the PR.
// `verify check` already has each file's time here: the span from its first test's start to its
// last test's end in the JSON report. CI's guard times the whole module, on runners that share
// their CPU between two packages' Vitest workers and Postgres, so a file can take several times
// longer there.
//
// The ratio, measured on 15 Nov 2026 (local: `pnpm verify check --concurrency 2` on 05dca903e2,
// the dev machine under its usual load; CI: the CI_TIMING file records of main run 43744627675 on
// 96dbd5a3bc, test-engines, test-engines-b, test-clients-a, test-clients-b). Time here, then on CI:
//
//   t3-gateway test/queue-explore.test.ts              15 s    61-93 s  x4.1-6.2  (SLNT-1027)
//   sessions test/rollback-restore-crash.property      34 s    77 s     x2.3      (SLNT-1029)
//   sessions test/rollback-restore-crash.property      9.7 s   68.7 s   x7.1      (after #1710)
//   sessions test/engine-drain-lifecycle.test.ts       16.0 s  45.5 s   x2.85
//   cli src/server-lifecycle-uninstall-plans.test.ts   11.1 s  41.8 s   x3.76
//   sessions test/engine-processes.test.ts             12.4 s  41.5 s   x3.34
//   cli src/pair.test.ts                               8.0 s   37.5 s   x4.67
//   cli src/main-accounts.test.ts                      5.2 s   28.5 s   x5.50
//   t3-gateway test/steering.test.ts                   45.7 s  37.1 s   x0.81
//   sessions src/screen/screen-workers.test.ts         22.6 s  32.7 s   x1.45
//   db test/migrations.test.ts                         19.5 s  29.2 s   x1.50
//
// Over the 195 files that took 3 s or more here: x0.31 lowest, x2.08 median, x4.18 at the 90th
// percentile, x7.12 highest. Waiting-bound files (timers, child processes) run about x1;
// CPU- and disk-bound ones x3 to x5. So the ratio is 4: a file that takes a quarter of the limit
// here is named. That catches both incidents before their PRs (15 s and 34 s here). It does not
// catch a file that is fast here but CPU-bound beside other suites on CI (the 9.7 s case);
// measuring under stress-ng is the check for that. On main at 3d765f98f1 it names 18 files
// (SLNT-1032 lists them).
export const CI_TO_LOCAL_RATIO = 4;

/** Each test file's time here, from the JSON reports of one run, as { file, ms }. */
export const readFileTimes = (root, reportDir) => {
  if (!existsSync(reportDir)) return [];
  const times = [];
  for (const name of readdirSync(reportDir)
    .filter((file) => file.endsWith(".json"))
    .toSorted()) {
    const report = JSON.parse(readFileSync(join(reportDir, name), "utf8"));
    for (const file of report.testResults ?? []) {
      if (!Number.isFinite(file.startTime) || !Number.isFinite(file.endTime)) continue;
      times.push({ file: relative(root, file.name ?? ""), ms: file.endTime - file.startTime });
    }
  }
  return times;
};

/** The files whose time here puts them at risk of CI's limit, slowest first. */
export const atRisk = (times, budgetMs = CI_FILE_BUDGET_MS, ratio = CI_TO_LOCAL_RATIO) => {
  const thresholdMs = budgetMs / ratio;
  return times
    .filter((time) => time.ms >= thresholdMs)
    .toSorted((a, b) => b.ms - a.ms)
    .map(({ file, ms }) => ({
      file,
      ms,
      warning: `${file} took ${(ms / 1000).toFixed(1)} s here, at least ${(thresholdMs / 1000).toFixed(0)} s (CI's ${budgetMs / 1000} s limit / ${ratio}); CI runs files up to ${ratio}x slower`,
    }));
};

export const AT_RISK_ADVICE =
  "measure it under stress-ng (stress-ng --cpu 2 --iomix 2), split it, or move a long exploration to the formal or docker-suites job";

/** One sentence for the receipt, or empty when no file is at risk. */
export const summarizeRisk = (risky) =>
  risky.length === 0
    ? ""
    : `${risky.length} test ${risky.length === 1 ? "file" : "files"} at risk of CI's ${CI_FILE_BUDGET_MS / 1000} s per-file limit: ${risky
        .map((risk) => `${risk.file} (${(risk.ms / 1000).toFixed(1)} s here)`)
        .join(", ")}; ${AT_RISK_ADVICE}`;
