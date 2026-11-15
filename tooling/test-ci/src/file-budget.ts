/**
 * CI's per-file execution limit: a test file that takes longer fails its CI job. The Vitest guard
 * (vitest.ts) and the node --test reporter (scripts/ci-node-reporter.mjs) both read it, and
 * `pnpm verify check` warns from it before a PR, so the three cannot drift.
 */
export const CI_FILE_BUDGET_MS = 60_000;
