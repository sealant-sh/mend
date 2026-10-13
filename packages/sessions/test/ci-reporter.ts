import type { UserConsoleLog } from "vitest";
import type { Plugin } from "vitest/config";
import type { TestModule, Vitest } from "vitest/node";
import type { Reporter } from "vitest/reporters";

const CLOCK_WARNING = /using time, but is not advancing the test clock/i;

class SessionsCiReporter implements Reporter {
  private vitest: Vitest | undefined;
  private readonly locations = new Map<string, string>();

  constructor(private readonly fileBudgetMs: number | undefined) {}

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunStart(): void {
    this.locations.clear();
  }

  onTestModuleCollected(module: TestModule): void {
    this.locations.set(module.id, module.moduleId);
    for (const test of module.children.allTests()) {
      this.locations.set(test.id, `${module.moduleId} > ${test.fullName}`);
    }
    for (const suite of module.children.allSuites()) {
      this.locations.set(suite.id, `${module.moduleId} > ${suite.fullName}`);
    }
  }

  onUserConsoleLog(log: UserConsoleLog): void {
    if (!CLOCK_WARNING.test(log.content)) return;
    const location =
      (log.taskId === undefined ? undefined : this.locations.get(log.taskId)) ??
      log.origin ??
      "unattributed test console";
    const error = new Error(`sessions Clock warning: ${location}\n${log.content}`);
    if (this.vitest === undefined) throw error;
    this.vitest.logger.error(error.message);
    // Console RPCs are separate from task events: register the failure with the runner
    // immediately so even a late log is included in its exit status and JSON report.
    this.vitest.state.catchError(error, "Sessions Clock warning");
  }

  onTestModuleEnd(module: TestModule): void {
    const duration = module.diagnostic().duration;
    if (this.fileBudgetMs !== undefined && duration > this.fileBudgetMs) {
      const error = new Error(
        `sessions file execution budget exceeded: ${module.moduleId} took ${duration.toFixed(1)} ms > ${this.fileBudgetMs} ms`,
      );
      this.vitest?.logger.error(error.message);
      throw error;
    }
  }
}

/** Append after CLI resolution so --reporter=json changes output without removing the guard. */
export const sessionsCiGuard = (options: { readonly fileBudgetMs?: number } = {}): Plugin => ({
  name: "mend-sessions-ci-guard",
  configureVitest({ vitest }) {
    vitest.config.reporters.push(new SessionsCiReporter(options.fileBudgetMs));
  },
});
