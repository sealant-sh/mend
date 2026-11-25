import { fileURLToPath } from "node:url";

import { nodeErrorReporterFromEnv, type ErrorReporter } from "@mend/client-errors/node";

import { CommandInputError } from "./command-result.ts";
import { findCommand } from "./help.ts";
import { MendRequestError } from "./server-request.ts";
import { ServerRefusal } from "./server-store.ts";
import { cliVersion } from "./version.ts";

/**
 * The CLI's errors-only Sentry reporting (SLNT-1357), on only when `MEND_SENTRY_DSN` is set: no
 * published build carries a DSN. The release is `mend-cli@<version>`, the name its
 * source maps are uploaded under by the release run.
 */
export const startCliErrorReporter = (): Promise<ErrorReporter | null> =>
  nodeErrorReporterFromEnv(process.env, {
    release: `mend-cli@${cliVersion()}`,
    // dist/ and src/ sit one level under the package, so frames read app:///dist/<chunk>.js.
    appRoot: fileURLToPath(new URL("../", import.meta.url)),
    tags: { client: "cli", command: commandName(process.argv.slice(2)) },
  });

/** The command a run was, by its catalog name: never an argument the person typed. */
const commandName = (argv: ReadonlyArray<string>): string => {
  const boundary = argv.indexOf("--");
  const own = boundary === -1 ? argv : argv.slice(0, boundary);
  return findCommand(own.filter((word) => !word.startsWith("-")))?.name ?? "unknown";
};

/**
 * Whether a failure that reached the top is a bug worth a report. A server's refusal or absence, a
 * person's input and a refusal the CLI words itself are answers it already explains; the server
 * reports its own failures.
 */
export const isUnexpectedFailure = (error: unknown): boolean =>
  !(
    error instanceof MendRequestError ||
    error instanceof CommandInputError ||
    error instanceof ServerRefusal
  );

/** At most this long is spent sending reports before the CLI exits (CONTRACT.md: ~2 s). */
export const FLUSH_MS = 2_000;

/**
 * A crash no command caught is reported before the process ends as Node would end it: the error
 * on stderr, exit code 1. Installed only while reporting is on, so without a DSN Node's own
 * handling is untouched.
 */
export const reportCrashes = (reporter: ErrorReporter): void => {
  const crash = async (error: unknown): Promise<never> => {
    reporter.report(error, { unhandled: true });
    await reporter.flush(FLUSH_MS);
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exit(1);
  };
  process.once("uncaughtException", (error) => void crash(error));
};
