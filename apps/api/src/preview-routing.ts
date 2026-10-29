import { isPreviewGrantSecret, type PreviewGrantSecret } from "@mend/db";
import { PreviewLabel } from "@mend/domain";
import { Brand, Redacted, Schema } from "effect";

export type PreviewOrigin = string & Brand.Brand<"PreviewOrigin">;
const PreviewOrigin = Brand.nominal<PreviewOrigin>();

export type PreviewRouting =
  | { readonly mode: "loopback-http"; readonly port: number }
  | { readonly mode: "domain-https"; readonly domain: string; readonly port: number }
  | {
      readonly mode: "tailnet-https";
      readonly hostname: string;
      /** The set Mend assigns previews from (`PreviewsRepo.assignTailnetPort`). */
      readonly ports: ReadonlyArray<number>;
    };

/** Where a preview is reached: its label, and on the tailnet default the port it holds. */
export interface PreviewPlace {
  readonly label: PreviewLabel;
  readonly tailnetPort: number | null;
}

const schemeOf = (routing: PreviewRouting) =>
  routing.mode === "loopback-http" ? "http:" : "https:";

const originAt = (scheme: string, authority: string): PreviewOrigin | null => {
  const parsed = URL.parse(`${scheme}//${authority}`);
  return parsed === null ? null : PreviewOrigin(parsed.origin);
};

/** Null on the tailnet default for a preview that holds no port of the set. */
export const previewOriginOf = (
  routing: PreviewRouting,
  place: PreviewPlace,
): PreviewOrigin | null => {
  switch (routing.mode) {
    case "loopback-http":
      return originAt("http:", `${place.label}.localhost:${routing.port}`);
    case "domain-https":
      return originAt("https:", `${place.label}.${routing.domain}:${routing.port}`);
    case "tailnet-https":
      return place.tailnetPort === null || !routing.ports.includes(place.tailnetPort)
        ? null
        : originAt("https:", `${routing.hostname}:${place.tailnetPort}`);
  }
};

const isLabel = Schema.is(PreviewLabel);

/** `name` as a URL host reads it: lowercase, and punycode for a non-ASCII name. */
const hostnameOf = (name: string) => URL.parse(`http://${name}`)?.hostname ?? name.toLowerCase();

export const previewAtOrigin = (
  routing: PreviewRouting,
  origin: PreviewOrigin,
): { readonly label: PreviewLabel } | { readonly tailnetPort: number } | null => {
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
      return routing.ports.includes(port) ? { tailnetPort: port } : null;
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

/**
 * How application cookies cross the gateway. A host per preview isolates them already. Tailnet
 * previews share one host on different ports and cookies ignore the port, so each preview's
 * HttpOnly cookies travel in its own namespace (docs/adr/0017, decision 6).
 */
export type CookiePolicy =
  | { readonly mode: "host-per-preview" }
  | { readonly mode: "tailnet-ports"; readonly label: PreviewLabel };

export const cookiePolicyOf = (
  routing: PreviewRouting,
  preview: { readonly label: PreviewLabel },
): CookiePolicy =>
  routing.mode === "tailnet-https"
    ? { mode: "tailnet-ports", label: preview.label }
    : { mode: "host-per-preview" };

const securityPrefixOf = (name: string) => /^__(?:host|secure)-/i.exec(name)?.[0] ?? "";

/** `__Host-` and `__Secure-` only mean something as the first characters, so they stay first. */
export const namespacedCookieName = (label: PreviewLabel, name: string): string => {
  const prefix = securityPrefixOf(name);
  return `${prefix}p-${label}.${name.slice(prefix.length)}`;
};

export type CookieNamespace =
  | { readonly _tag: "Plain" }
  | { readonly _tag: "Own"; readonly name: string }
  | { readonly _tag: "Foreign" };

export const cookieNamespaceOf = (label: PreviewLabel, wireName: string): CookieNamespace => {
  const prefix = securityPrefixOf(wireName);
  const rest = wireName.slice(prefix.length);
  const namespace = /^p-([^.]*)\./.exec(rest);
  if (namespace === null || !isLabel(namespace[1])) return { _tag: "Plain" };
  return namespace[1] === label
    ? { _tag: "Own", name: `${prefix}${rest.slice(namespace[0].length)}` }
    : { _tag: "Foreign" };
};

/**
 * A request carries no HttpOnly bit, so on a tailnet unprefixed cookies pass as the JavaScript
 * cookies the ADR leaves unisolated.
 */
export const appCookieHeader = (
  headers: ReadonlyArray<string>,
  policy: CookiePolicy,
): string | null => {
  const kept = cookiePairs(headers).flatMap((cookie) => {
    if (isGrantCookieName(cookie.name)) return [];
    if (policy.mode === "host-per-preview") return [cookie.pair];
    const read = cookieNamespaceOf(policy.label, cookie.name);
    switch (read._tag) {
      case "Plain":
        return [cookie.pair];
      case "Foreign":
        return [];
      case "Own":
        return isGrantCookieName(read.name) ? [] : [`${read.name}=${cookie.value ?? ""}`];
    }
  });
  return kept.length === 0 ? null : kept.join("; ");
};

const attributeName = (attribute: string) => (attribute.split("=")[0] ?? "").trim().toLowerCase();

const clears = (attributes: ReadonlyArray<string>, now: number) =>
  attributes.some((attribute) => {
    const value = attribute.slice(attribute.indexOf("=") + 1).trim();
    switch (attributeName(attribute)) {
      case "max-age":
        return Number(value) <= 0;
      case "expires":
        return Date.parse(value) <= now;
      default:
        return false;
    }
  });

/**
 * Never split a `Set-Cookie` list on commas: `Expires` contains one. A deletion names no
 * HttpOnly, as a cookie's identity is its name, so on a tailnet it clears the namespaced cookie
 * too.
 */
export const appSetCookie = (
  raw: string,
  policy: CookiePolicy,
  now = Date.now(),
): ReadonlyArray<string> => {
  const [pair = "", ...attributes] = raw.split(";");
  const equals = pair.indexOf("=");
  const name = equals === -1 ? "" : pair.slice(0, equals).trim();
  if (name === "" || isGrantCookieName(name)) return [];
  const kept = attributes
    .map((attribute) => attribute.trim())
    .filter((attribute) => attribute !== "" && attributeName(attribute) !== "domain");
  const cookie = (wireName: string) =>
    [`${wireName}=${pair.slice(equals + 1).trim()}`, ...kept].join("; ");
  if (policy.mode === "host-per-preview") return [cookie(name)];
  const namespaced = cookie(namespacedCookieName(policy.label, name));
  if (kept.some((attribute) => attributeName(attribute) === "httponly")) return [namespaced];
  // A script-visible cookie named like a namespace would arrive at that preview as its own.
  if (cookieNamespaceOf(policy.label, name)._tag !== "Plain") return [];
  return clears(kept, now) ? [cookie(name), namespaced] : [cookie(name)];
};
