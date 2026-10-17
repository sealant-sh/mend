import { vitestCiGuard, type VitestCiPlugin } from "@mend/test-ci/vitest";

/** Keep the CLI fixture configurations on the same shared guard as the CLI test entrypoint. */
export const cliCiGuard = (options: { readonly fileBudgetMs: number }): VitestCiPlugin =>
  vitestCiGuard({ packageName: "@sealant/mend", fileBudgetMs: options.fileBudgetMs });
