import { isPreviewGrantSecret, type PreviewGrantSecret } from "@mend/db";
import { type PreviewId, PreviewLabel } from "@mend/domain";
import { Brand, Redacted, Schema } from "effect";

export type PreviewOrigin = string & Brand.Brand<"PreviewOrigin">;
const PreviewOrigin = Brand.nominal<PreviewOrigin>();

export type PreviewRouting =
  | { readonly mode: "loopback-http"; readonly port: number }
  | { readonly mode: "domain-https"; readonly domain: string; readonly port: number }
  | {
      readonly mode: "tailnet-https";
      readonly hostname: string;
      readonly ports: ReadonlyArray<{ readonly port: number; readonly previewId: PreviewId }>;
    };

const schemeOf = (routing: PreviewRouting) =>
  routing.mode === "loopback-http" ? "http:" : "https:";

const originAt = (scheme: string, authority: string): PreviewOrigin | null => {
  const parsed = URL.parse(`${scheme}//${authority}`);
  return parsed === null ? null : PreviewOrigin(parsed.origin);
};

export const previewOriginOf = (
  routing: PreviewRouting,
  preview: { readonly id: PreviewId; readonly label: PreviewLabel },
): PreviewOrigin | null => {
  switch (routing.mode) {
    case "loopback-http":
      return originAt("http:", `${preview.label}.localhost:${routing.port}`);
    case "domain-https":
      return originAt("https:", `${preview.label}.${routing.domain}:${routing.port}`);
    case "tailnet-https": {
      const assigned = routing.ports.find((entry) => entry.previewId === preview.id);
      return assigned === undefined
        ? null
        : originAt("https:", `${routing.hostname}:${assigned.port}`);
    }
  }
};

const isLabel = Schema.is(PreviewLabel);

/** `name` as a URL host reads it: lowercase, and punycode for a non-ASCII name. */
const hostnameOf = (name: string) => URL.parse(`http://${name}`)?.hostname ?? name.toLowerCase();

export const previewAtOrigin = (
  routing: PreviewRouting,
  origin: PreviewOrigin,
): { readonly label: PreviewLabel } | { readonly previewId: PreviewId } | null => {
  const url = new URL(origin);
  if (url.protocol !== schemeOf(routing)) return null;
  const port = Number(url.port === "" ? (url.protocol === "https:" ? 443 : 80) : url.port);
  const labelUnder = (suffix: string) => {
    const label = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : "";
    return isLabel(label) ? { label } : null;
  };
  switch (routing.mode) {
    case "loopback-http":
      return port === routing.port ? labelUnder(".localhost") : null;
    case "domain-https":
      return port === routing.port ? labelUnder(`.${hostnameOf(routing.domain)}`) : null;
    case "tailnet-https": {
      if (url.hostname !== hostnameOf(routing.hostname)) return null;
      const assigned = routing.ports.find((entry) => entry.port === port);
      return assigned === undefined ? null : { previewId: assigned.previewId };
    }
  }
};

export const reachedPreviewOrigin = (
  routing: PreviewRouting,
  authority: string,
): PreviewOrigin | null => {
  if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(authority)) return null;
  const origin = originAt(schemeOf(routing), authority);
  return origin === null || previewAtOrigin(routing, origin) === null ? null : origin;
};

export type GrantCookieName =
  | "mend-preview"
  | "__Host-mend-preview"
  | `__Host-mend-preview-${number}`;

export interface GrantCookie {
  readonly name: GrantCookieName;
  readonly secure: boolean;
}

/**
 * `__Host-` forbids `Domain`, so no sibling host can set or replace it. Cookies ignore the port, so
 * on the tailnet default the name carries it.
 */
export const grantCookieOf = (routing: PreviewRouting, origin: PreviewOrigin): GrantCookie => {
  switch (routing.mode) {
    case "loopback-http":
      return { name: "mend-preview", secure: false };
    case "domain-https":
      return { name: "__Host-mend-preview", secure: true };
    case "tailnet-https": {
      const port = new URL(origin).port;
      return { name: `__Host-mend-preview-${port === "" ? 443 : Number(port)}`, secure: true };
    }
  }
};

export const isGrantCookieName = (name: string): boolean =>
  name === "mend-preview" || /^__Host-mend-preview(-[0-9]+)?$/.test(name);

export const setGrantCookie = (cookie: GrantCookie, grant: PreviewGrantSecret): string =>
  `${cookie.name}=${Redacted.value(grant)}; Path=/; HttpOnly; SameSite=Lax${cookie.secure ? "; Secure" : ""}`;

const cookiePairs = (headers: ReadonlyArray<string>) =>
  headers.flatMap((header) =>
    header
      .split(";")
      .map((pair) => pair.trim())
      .filter((pair) => pair !== "")
      .map((pair) => {
        const equals = pair.indexOf("=");
        return equals === -1
          ? { name: pair, pair }
          : { name: pair.slice(0, equals).trim(), value: pair.slice(equals + 1).trim(), pair };
      }),
  );

export const readGrantCookie = (
  headers: ReadonlyArray<string>,
  name: GrantCookieName,
): PreviewGrantSecret | null | "repeated" => {
  const values = cookiePairs(headers).flatMap((cookie) =>
    cookie.name === name ? [cookie.value ?? ""] : [],
  );
  if (values.length > 1) return "repeated";
  const [value] = values;
  return value !== undefined && isPreviewGrantSecret(value) ? Redacted.make(value) : null;
};

export const withoutGrantCookies = (headers: ReadonlyArray<string>): string | null => {
  const kept = cookiePairs(headers).filter((cookie) => !isGrantCookieName(cookie.name));
  return kept.length === 0 ? null : kept.map((cookie) => cookie.pair).join("; ");
};
