import { formatWithOptions } from "node:util";

import { redactUrlCredentials } from "@mend/domain/workbench";
import { Console, Layer } from "effect";

/** One console call formatted as `console.log` would format it, then redacted. */
const line = (args: ReadonlyArray<unknown>): string =>
  redactUrlCredentials(formatWithOptions({}, ...args));

/**
 * `target` with the credential taken out of every URL it writes (docs/GIT-ACCESS.md, "Credentials
 * in repository URLs"). Effect's logger writes through the console it finds in context, so every
 * log line of the server passes here: a token a git error or an older row still carried never
 * reaches the log.
 */
export const redactingConsole = (target: Console.Console): Console.Console => ({
  ...target,
  debug: (...args) => target.debug(line(args)),
  error: (...args) => target.error(line(args)),
  info: (...args) => target.info(line(args)),
  log: (...args) => target.log(line(args)),
  trace: (...args) => target.trace(line(args)),
  warn: (...args) => target.warn(line(args)),
});

/** The server's console: `redactingConsole` over the process's own. */
export const RedactingConsoleLive: Layer.Layer<never> = Layer.succeed(
  Console.Console,
  redactingConsole(globalThis.console),
);
