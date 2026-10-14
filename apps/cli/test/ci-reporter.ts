import type { Plugin } from "vitest/config";
import type { TestModule, Vitest } from "vitest/node";
import type { Reporter } from "vitest/reporters";

class CliCiReporter implements Reporter {
  private vitest: Vitest | undefined;

  constructor(private readonly fileBudgetMs: number) {}

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestModuleEnd(module: TestModule): void {
    const duration = module.diagnostic().duration;
    if (duration > this.fileBudgetMs) {
      const error = new Error(
        `CLI file execution budget exceeded: ${module.moduleId} took ${duration.toFixed(1)} ms > ${this.fileBudgetMs} ms`,
      );
      this.vitest?.logger.error(error.message);
      throw error;
    }
  }
}

/** Append after CLI resolution so --reporter=json changes output without removing the guard. */
export const cliCiGuard = (options: { readonly fileBudgetMs: number }): Plugin => ({
  name: "mend-cli-ci-guard",
  configureVitest({ vitest }) {
    vitest.config.reporters.push(new CliCiReporter(options.fileBudgetMs));
  },
});
