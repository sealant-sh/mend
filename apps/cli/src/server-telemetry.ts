/**
 * Where this server's errors, traces and logs go: Sentry, when the operator names a project
 * (SLNT-1355). Off unless set: Mend runs in people's own Docker, and an install reports to nobody
 * until its operator says where (`--sentry-dsn`). Nothing here is ever a default.
 *
 * The bundle's supervisor gives each process the one DSN its product reports to
 * (scripts/bundle-supervisor.mjs): Mend's API, worker and web server `MEND_SENTRY_DSN`, sealant's
 * API, worker and SSH gateway `SEALANT_SENTRY_DSN`, the sealantd in each workspace
 * `SEALANTD_SENTRY_DSN` (which sealant's worker hands each workspace it launches), and the web
 * app's browser half `SENTRY_BROWSER_DSN`. The environment and the trace sample rate are shared.
 *
 * The values live in the server config, and `compose.telemetry.yaml` hands them to the `mend`
 * container, written into the overlay itself, not `server.env`: a CLI from before this setting
 * refuses a `server.env` line it does not know, and ignores a file it does not know, so an older
 * CLI can still read and upgrade the install (and drops the setting, which turns reporting off).
 * Unset, no overlay is written and the generation is what it was before the setting existed.
 */

export const TELEMETRY_COMPOSE_FILE = "compose.telemetry.yaml";

/** What an install sets; a value it does not set is off, or the server's own default. */
export interface ServerTelemetry {
  /** `MEND_SENTRY_DSN`: Mend's servers, the API, the worker and the web app's server. */
  readonly dsn?: string;
  /** `SEALANT_SENTRY_DSN`: the bundled sealant's API, worker and SSH gateway. */
  readonly sealantDsn?: string;
  /** `SEALANTD_SENTRY_DSN`: the sealantd in each workspace, handed to it by sealant's worker. */
  readonly sealantdDsn?: string;
  /** `SENTRY_BROWSER_DSN`: the web app in the browser, served to it at runtime. */
  readonly browserDsn?: string;
  /** `SENTRY_ENVIRONMENT`: absent, each process says `development`. */
  readonly environment?: string;
  /** `SENTRY_TRACES_SAMPLE_RATE`, 0 to 1 as written: absent, every trace (1). */
  readonly tracesSampleRate?: string;
}

/** A flag's value: a setting, or `default` to take a saved one away. */
export type TelemetryValue = string;

interface Field {
  readonly key: keyof ServerTelemetry;
  readonly flag: string;
  readonly variable: string;
  readonly rule: string;
  readonly valid: (value: string) => boolean;
}

/** `https://<public key>@<host>/<project id>`, the shape Sentry hands out. */
const isDsn = (value: string): boolean => {
  if (
    !/^https?:\/\/[A-Za-z0-9]+@[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._-]+)*\/\d+$/.test(value)
  )
    return false;
  return URL.canParse(value);
};

/**
 * Said without a URL's shape: the CLI scrubs whatever reads as a URL's credentials from what it
 * prints, which would leave `https://<host>/…` of an example with a key in it.
 */
const DSN_RULE =
  "a Sentry DSN (the https address Sentry gives, with the project's public key and its id), or default";

export const TELEMETRY_FIELDS: ReadonlyArray<Field> = [
  { key: "dsn", flag: "--sentry-dsn", variable: "MEND_SENTRY_DSN", rule: DSN_RULE, valid: isDsn },
  {
    key: "sealantDsn",
    flag: "--sealant-sentry-dsn",
    variable: "SEALANT_SENTRY_DSN",
    rule: DSN_RULE,
    valid: isDsn,
  },
  {
    key: "sealantdDsn",
    flag: "--sealantd-sentry-dsn",
    variable: "SEALANTD_SENTRY_DSN",
    rule: DSN_RULE,
    valid: isDsn,
  },
  {
    key: "browserDsn",
    flag: "--sentry-browser-dsn",
    variable: "SENTRY_BROWSER_DSN",
    rule: DSN_RULE,
    valid: isDsn,
  },
  {
    key: "environment",
    flag: "--sentry-environment",
    variable: "SENTRY_ENVIRONMENT",
    rule: "a name of letters, digits, dots, dashes and underscores, up to 64, or default",
    valid: (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value),
  },
  {
    key: "tracesSampleRate",
    flag: "--sentry-traces-sample-rate",
    variable: "SENTRY_TRACES_SAMPLE_RATE",
    rule: "a number from 0 to 1, such as 0.25, or default",
    valid: (value) => /^(?:0(?:\.\d{1,6})?|1(?:\.0{1,6})?|\.\d{1,6})$/.test(value),
  },
];

/** The flag's value, or null when it is none of what the flag takes. */
export const parseTelemetryValue = (field: Field, value: string): TelemetryValue | null =>
  value === "default" || field.valid(value) ? value : null;

/**
 * What a setup writes: each flag given, else what the install saved. `default` takes a saved value
 * away. Undefined when nothing is set, so the config carries no field at all.
 */
export const resolveTelemetry = (
  saved: ServerTelemetry | undefined,
  flags: Readonly<Partial<Record<keyof ServerTelemetry, TelemetryValue>>>,
): ServerTelemetry | undefined => {
  const entries = TELEMETRY_FIELDS.flatMap(({ key }) => {
    const flag = flags[key];
    const value = flag === "default" ? undefined : (flag ?? saved?.[key]);
    return value === undefined ? [] : [[key, value] as const];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

/** The saved field, or null when it is not what a setup writes. */
export const parseTelemetryField = (raw: unknown): ServerTelemetry | null => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const fields = new Map(Object.entries(raw));
  const known = new Set<string>(TELEMETRY_FIELDS.map(({ key }) => key));
  if (fields.size === 0 || [...fields.keys()].some((key) => !known.has(key))) return null;
  for (const field of TELEMETRY_FIELDS) {
    const value = fields.get(field.key);
    if (value !== undefined && (typeof value !== "string" || !field.valid(value))) return null;
  }
  return Object.fromEntries(
    TELEMETRY_FIELDS.flatMap(({ key }) => {
      const value = fields.get(key);
      return typeof value === "string" ? [[key, value] as const] : [];
    }),
  );
};

/** `compose.telemetry.yaml`, or undefined when the install sets nothing. */
export const renderTelemetryOverlay = (
  telemetry: ServerTelemetry | undefined,
): string | undefined => {
  if (telemetry === undefined) return undefined;
  return [
    "# Written by mend server setup from server.json: where this server's errors and traces go",
    "# (--sentry-dsn and the flags beside it). The supervisor gives each process its own product's",
    "# DSN. A value not named here is off, or the server's own default.",
    "services:",
    "  mend:",
    "    environment:",
    ...TELEMETRY_FIELDS.flatMap(({ key, variable }) => {
      const value = telemetry[key];
      return value === undefined ? [] : [`      ${variable}: "${value}"`];
    }),
    "",
  ].join("\n");
};

/** A DSN as an operator reads it: the host and the project, never the key. */
const projectOf = (dsn: string): string => {
  const url = new URL(dsn);
  return `${url.host} project ${url.pathname.split("/").findLast((part) => part !== "") ?? "?"}`;
};

/** The one line `mend server status` says, among the settings the install declares. */
export const telemetryLine = (telemetry: ServerTelemetry | undefined): string => {
  if (telemetry === undefined)
    return "telemetry · off: this server reports its errors and traces to nobody";
  const parts = [
    telemetry.dsn === undefined
      ? "Mend's servers report nothing"
      : `Mend's servers report to ${projectOf(telemetry.dsn)}`,
    telemetry.sealantDsn === undefined
      ? "sealant's nothing"
      : `sealant's to ${projectOf(telemetry.sealantDsn)}`,
    telemetry.sealantdDsn === undefined
      ? "sealantd's nothing"
      : `sealantd's to ${projectOf(telemetry.sealantdDsn)}`,
    telemetry.browserDsn === undefined
      ? "the browser nothing"
      : `the browser to ${projectOf(telemetry.browserDsn)}`,
    `environment ${telemetry.environment ?? "development"}`,
    `traces sampled at ${telemetry.tracesSampleRate ?? "1"}`,
  ];
  return `telemetry · ${parts.join(", ")}`;
};

/** What setup says when this run changes the setting; nothing when it does not. */
export const telemetryChangedLines = (
  before: ServerTelemetry | undefined,
  after: ServerTelemetry | undefined,
): ReadonlyArray<string> =>
  TELEMETRY_FIELDS.every(({ key }) => before?.[key] === after?.[key])
    ? []
    : [`${telemetryLine(after)}. It applies once Mend restarts.`];
