import { nodeErrorReporterFromEnv, type ErrorReporter } from "@mend/client-errors/node";
import * as vscode from "vscode";

import { MendApiError } from "./mend-http.js";
import { SignInError } from "./sign-in.js";

/**
 * The extension's errors-only Sentry reporting (SLNT-1357). It is on only when the extension host
 * has `MEND_SENTRY_DSN` set (no published build carries a DSN), and each report is sent only
 * while VS Code's telemetry is on (`telemetry.telemetryLevel`), as the extension guidelines ask.
 *
 * The extension host is shared with every other extension, so nothing global is installed: the
 * one thing reported is a failure the extension itself shows, at `showErrorToast`.
 */
let reporter: Promise<ErrorReporter | null> = Promise.resolve(null);

/** Starts reporting for this activation; a no-op without a DSN. */
export const startErrorReporting = (context: vscode.ExtensionContext): void => {
  const manifest: unknown = context.extension.packageJSON;
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String(manifest.version)
      : "unknown";
  reporter = nodeErrorReporterFromEnv(process.env, {
    release: `mend-vscode@${version}`,
    // The installed extension's folder, so frames read app:///dist/extension.js.
    appRoot: context.extensionPath,
    tags: {
      client: "vscode",
      "vscode.host": vscode.env.remoteName === undefined ? "local" : "remote",
      "vscode.ui": vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
    },
  });
};

/**
 * Reports a failure the extension did not expect. A refusal or an unreachable server
 * (`MendApiError`) and a sign-in that did not finish (`SignInError`) are answers the toast
 * already explains; the server reports its own failures.
 */
export const reportUnexpected = (cause: unknown): void => {
  if (cause instanceof MendApiError || cause instanceof SignInError) return;
  if (!vscode.env.isTelemetryEnabled) return;
  void reporter.then((started) => started?.report(cause));
};

/** At deactivation: at most 2 s for reports still on their way. */
export const flushErrorReports = async (): Promise<void> => {
  await (await reporter)?.flush(2_000);
};
