import { errorReportingSettings, type ErrorReportingSettings } from "./settings.ts";

/**
 * A Node client's error reporter: the CLI, the desktop app's main process, the VS Code extension.
 * It installs nothing global, so it is safe in a process it shares (an extension host): it sees
 * only the errors its owner hands it.
 */
export interface ErrorReporter {
  /**
   * Hands one unexpected failure to Sentry. Never throws and never waits for the network.
   * `unhandled` marks a failure no code caught (an uncaught exception, an unhandled rejection), so
   * Sentry shows it as a crash rather than an error the app noticed.
   */
  readonly report: (error: unknown, options?: { readonly unhandled?: boolean }) => void;
  /** Waits at most `timeoutMs` for reports still on their way; true when none is left. */
  readonly flush: (timeoutMs: number) => Promise<boolean>;
}

export interface NodeReporterOptions {
  readonly settings: ErrorReportingSettings;
  /**
   * The directory the app's built files run from. Its frames read `app:///<path inside>`, the
   * names its source maps are uploaded under.
   */
  readonly appRoot: string;
  /** Tags on every report, from a fixed set of words: which client, which surface. */
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * Starts a reporter. The Sentry SDK is loaded here and only here, so a process with no DSN never
 * loads it.
 */
export const startNodeErrorReporter = async (
  options: NodeReporterOptions,
): Promise<ErrorReporter> => {
  const { makeNodeErrorReporter } = await import("./node-client.ts");
  return makeNodeErrorReporter(options);
};

/**
 * The reporter `env` asks for, or null when it names no DSN. Reporting never stops the app: a
 * reporter that cannot start is reported as null too.
 */
export const nodeErrorReporterFromEnv = async (
  env: Readonly<Record<string, string | undefined>>,
  options: Omit<NodeReporterOptions, "settings"> & { readonly release: string },
): Promise<ErrorReporter | null> => {
  const settings = errorReportingSettings((name) => env[name], options.release);
  if (settings === null) return null;
  try {
    return await startNodeErrorReporter({ settings, appRoot: options.appRoot, tags: options.tags });
  } catch {
    return null;
  }
};
