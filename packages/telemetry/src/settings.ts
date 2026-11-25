/**
 * What a Mend server process reports to Sentry, read from its environment (SLNT-1349's contract).
 *
 * Off unless the process is given `SENTRY_DSN`: no Sentry client, no OTLP exporter, no network
 * call. Mend runs in people's own Docker, and their installs must never report to us, so no DSN is
 * ever a default; only the deployments we run set one.
 */

export interface TelemetrySettings {
  /** The DSN as given, for the Sentry client. */
  readonly dsn: string;
  readonly environment: string;
  /** `SENTRY_RELEASE`, else the one the process names for itself; undefined for a dev build. */
  readonly release: string | undefined;
  /** For root spans: a trace that arrives sampled or not keeps its caller's decision. */
  readonly tracesSampleRate: number;
  /** Where traces and logs go over OTLP/HTTP: `<baseUrl>/v1/traces` and `<baseUrl>/v1/logs`. */
  readonly otlp: {
    readonly baseUrl: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

type Environment = Readonly<Record<string, string | undefined>>;

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

interface ParsedDsn {
  readonly origin: string;
  readonly publicKey: string;
  readonly projectId: string;
}

/** `https://<key>@<host>/<project>`, the shape Sentry hands out; null for anything else. */
export const parseDsn = (dsn: string): ParsedDsn | null => {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const projectId = url.pathname.split("/").findLast((segment) => segment !== "");
  if (url.username === "" || projectId === undefined || !/^\d+$/.test(projectId)) return null;
  const prefix = url.pathname.slice(0, url.pathname.lastIndexOf(`/${projectId}`));
  return { origin: `${url.protocol}//${url.host}${prefix}`, publicKey: url.username, projectId };
};

/** `OTEL_EXPORTER_OTLP_HEADERS`: `name=value` pairs, comma-separated, values URL-encoded. */
const parseOtlpHeaders = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split(",").flatMap((pair) => {
      const at = pair.indexOf("=");
      if (at <= 0) return [];
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      try {
        return [[name, decodeURIComponent(value)]];
      } catch {
        return [[name, value]];
      }
    }),
  );

const sampleRateOf = (text: string | undefined): number => {
  if (text === undefined) return 1;
  const rate = Number(text);
  return Number.isFinite(rate) ? Math.min(Math.max(rate, 0), 1) : 1;
};

export class TelemetrySettingsError extends Error {
  override readonly name = "TelemetrySettingsError";
}

/**
 * The settings `environment` names, or null when it names no DSN. A DSN that is not one fails:
 * an operator who set it means telemetry to be on, and a typo should not quietly turn it off.
 */
export const telemetrySettings = (
  environment: Environment,
  defaults: { readonly release?: string | undefined } = {},
): TelemetrySettings | null => {
  const dsn = present(environment.SENTRY_DSN);
  if (dsn === undefined) return null;
  const parsed = parseDsn(dsn);
  if (parsed === null) {
    throw new TelemetrySettingsError(
      "SENTRY_DSN is not a Sentry DSN (the https address Sentry gives, with the project's public key and its id)",
    );
  }
  const endpoint = present(environment.OTEL_EXPORTER_OTLP_ENDPOINT);
  const headers = present(environment.OTEL_EXPORTER_OTLP_HEADERS);
  return {
    dsn,
    environment: present(environment.SENTRY_ENVIRONMENT) ?? "development",
    release: present(environment.SENTRY_RELEASE) ?? present(defaults.release),
    tracesSampleRate: sampleRateOf(present(environment.SENTRY_TRACES_SAMPLE_RATE)),
    otlp: {
      baseUrl:
        endpoint?.replace(/\/+$/, "") ??
        `${parsed.origin}/api/${parsed.projectId}/integration/otlp`,
      headers:
        headers !== undefined
          ? parseOtlpHeaders(headers)
          : endpoint === undefined
            ? { "x-sentry-auth": `sentry sentry_key=${parsed.publicKey}` }
            : {},
    },
  };
};
