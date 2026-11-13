import { beforeEach } from "vitest";

declare module "vitest" {
  interface TaskMeta {
    /** Each attempt's duration in milliseconds, in order: the CI reporter's retry evidence. */
    mendCiAttemptsMs?: ReadonlyArray<number>;
  }
}

// Captured before any test can install fake timers, which replace `performance.now`.
const now = performance.now.bind(performance);

/**
 * CI only (vitestCiGuard adds this setup file with the retry). Vitest reports one duration for a
 * retried test, its attempts added together, so each attempt is timed here: from the first
 * `beforeEach` to the end of `afterEach`. Fixture setup outside that window is not counted.
 */
beforeEach(({ task, onTestFinished }) => {
  const started = now();
  onTestFinished(() => {
    task.meta.mendCiAttemptsMs = [...(task.meta.mendCiAttemptsMs ?? []), now() - started];
  });
});
