/**
 * Whether a Mend client reports its errors, and where. Off unless the process is given a DSN.
 *
 * The clients read `MEND_SENTRY_DSN`, not the `SENTRY_DSN` the servers read (SLNT-1357): the CLI,
 * the desktop app and the VS Code extension run in a person's own shell, and a developer's shell
 * often holds a `SENTRY_DSN` for their own app. A self-hosted install never reports to us, because
 * no build carries a DSN as a default.
 */
export interface ErrorReportingSettings {
  /** `https://<public key>@<host>/<project id>`. */
  readonly dsn: string;
  /** `MEND_SENTRY_ENVIRONMENT`, `development` when unset. */
  readonly environment: string;
  /**
   * `<Sentry project>@<version>` (`mend-cli@0.36.0`): the same string the release's source maps are
   * uploaded under. Not the npm name: Sentry refuses a release with a `/` in it (`@sealant/mend`).
   */
  readonly release: string;
}

/** The names the settings come from, for docs and error words. */
export const DSN_VARIABLE = "MEND_SENTRY_DSN";
export const ENVIRONMENT_VARIABLE = "MEND_SENTRY_ENVIRONMENT";

/** A DSN as Sentry gives one: a public key, a host and a numeric project id. */
const DSN_SHAPE = /^https?:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._-]+)*\/\d+$/;

/**
 * The settings in `read`'s variables, or null when reporting is off. A value that is not a DSN
 * turns it off too, rather than sending to a guess: reporting is never worth a failed start.
 */
export const errorReportingSettings = (
  read: (name: string) => string | undefined,
  release: string,
): ErrorReportingSettings | null => {
  const dsn = read(DSN_VARIABLE)?.trim() ?? "";
  if (!DSN_SHAPE.test(dsn)) return null;
  const environment = read(ENVIRONMENT_VARIABLE)?.trim() ?? "";
  return { dsn, environment: environment === "" ? "development" : environment, release };
};
