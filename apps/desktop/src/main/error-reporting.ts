import { nodeErrorReporterFromEnv } from "@mend/client-errors/node";
import { app } from "electron";

/**
 * The main process's errors-only Sentry reporting (SLNT-1357), on only when `MEND_SENTRY_DSN` is
 * set: no build carries a DSN. It covers this process alone. Once connected, the window shows the
 * server's own web app, whose errors are that app's to report; the local Connect and Offline shell
 * is out of scope here.
 *
 * What reaches it is what no code caught: an exception Electron would show in its "A JavaScript
 * error occurred in the main process" dialog, and a promise nobody awaited that failed. Both keep
 * their current behaviour; the report is sent beside them.
 */
export const startErrorReporting = async (): Promise<void> => {
  const reporter = await nodeErrorReporterFromEnv(process.env, {
    release: MEND_DESKTOP_RELEASE,
    // The asar (or apps/desktop in development), so frames read app:///out/main/<chunk>.js.
    appRoot: app.getAppPath(),
    tags: { client: "desktop", "desktop.process": "main" },
  });
  if (reporter === null) return;
  // A monitor sees the exception without changing what Electron does with it.
  process.on("uncaughtExceptionMonitor", (error) => reporter.report(error, { unhandled: true }));
  // A listener replaces Node's warning, so the warning is written here as Node would.
  process.on("unhandledRejection", (reason) => {
    reporter.report(reason, { unhandled: true });
    console.error("Unhandled promise rejection in the main process:", reason);
  });
};
