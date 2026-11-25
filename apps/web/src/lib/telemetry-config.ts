/**
 * Whether, and where, the browser reports errors and traces to Sentry (SLNT-1349). The web server
 * reads it from its environment on every page it renders, so one build reports for the
 * deployments that set a DSN and stays silent everywhere else: a Mend someone runs for themselves
 * never reports to Sealant. Unset or unreadable means no Sentry code is loaded and nothing is sent.
 *
 * Kept small and free of the SDK: the root route reads it on every page, the sign-in page too.
 */

/** What the browser's Sentry client is started with. */
export interface BrowserTelemetry {
  readonly dsn: string;
  readonly environment: string;
  readonly release: string | null;
  readonly tracesSampleRate: number;
}

/**
 * The origin a DSN reports to (`https://<key>@sentry.example/4` → `https://sentry.example`), or
 * null when it is not a DSN: a URL over http(s) with a public key and a numeric project.
 */
export const dsnOrigin = (dsn: string): string | null => {
  if (!URL.canParse(dsn)) return null;
  const url = new URL(dsn);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username === "" || !/\/\d+$/.test(url.pathname)) return null;
  return url.origin;
};

const sampleRateOf = (text: string | undefined): number => {
  const rate = Number(text?.trim() === "" ? undefined : text);
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 1;
};

/**
 * The browser's telemetry from the web server's environment: `SENTRY_BROWSER_DSN` (the browser's
 * own project, not the server's `SENTRY_DSN`), `SENTRY_ENVIRONMENT`, the release
 * `mend-web@<MEND_VERSION>` (the name CI uploads the browser's source maps under,
 * scripts/sentry-release.sh; a `SENTRY_RELEASE` in the environment names the servers' release, never
 * the browser's) and
 * `SENTRY_TRACES_SAMPLE_RATE` (else every trace).
 */
export const browserTelemetryOf = (
  env: Readonly<Record<string, string | undefined>>,
): BrowserTelemetry | null => {
  const dsn = env["SENTRY_BROWSER_DSN"]?.trim() ?? "";
  if (dsn === "" || dsnOrigin(dsn) === null) return null;
  const version = env["MEND_VERSION"]?.trim() ?? "";
  const release = version === "" || version === "dev" ? "" : `mend-web@${version}`;
  return {
    dsn,
    environment: env["SENTRY_ENVIRONMENT"]?.trim() || "development",
    release: release === "" ? null : release,
    tracesSampleRate: sampleRateOf(env["SENTRY_TRACES_SAMPLE_RATE"]),
  };
};

/** Where the page keeps it: the server writes it into the document, the browser reads it once. */
const GLOBAL = "__MEND_TELEMETRY__";

/**
 * The document's script that hands the telemetry to the browser, or null when there is none. The
 * JSON is written so no value can close the script (`<` is escaped).
 */
export const telemetryScript = (telemetry: BrowserTelemetry | null): string | null =>
  telemetry === null
    ? null
    : `window.${GLOBAL}=${JSON.stringify(telemetry).replaceAll("<", "\\u003c")};`;

const isTelemetry = (value: unknown): value is BrowserTelemetry =>
  typeof value === "object" &&
  value !== null &&
  "dsn" in value &&
  typeof value.dsn === "string" &&
  dsnOrigin(value.dsn) !== null &&
  "environment" in value &&
  typeof value.environment === "string" &&
  "release" in value &&
  (value.release === null || typeof value.release === "string") &&
  "tracesSampleRate" in value &&
  typeof value.tracesSampleRate === "number";

/** The telemetry this page was served with, in the browser; null on the server or when off. */
export const pageTelemetry = (): BrowserTelemetry | null => {
  if (typeof window === "undefined") return null;
  const value: unknown = Reflect.get(window, GLOBAL);
  return isTelemetry(value) ? value : null;
};
