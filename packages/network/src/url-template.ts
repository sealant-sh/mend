import { SECRET_SEGMENT_PREFIXES } from "./secret-segments.ts";

/**
 * A request's path as a trace names it (SLNT-1375, SLNT-1407): each ID, code or name in it
 * replaced by what it is, so `GET /v1/sessions/sess_dce91a8f/output` reads
 * `GET /v1/sessions/:sessionId/output` wherever the call came from. A path one of `routes` matches
 * takes that route's own template (`/api/me/cli-auth/:code`, `/api/projects/:id/resources/:name`):
 * a short code or a resource's name looks like any other word. Anything else is templated by
 * shape. No dependencies past a list of strings: the browser's Sentry client uses it too.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `sess_dce1…`, `ws_01J9…`, `run_…`: an ID with its type in front. */
const PREFIXED_ID = /^[a-z]{1,12}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}$/;
/** A number, an address or a version: `42`, `10.0.0.4`, `1.2.3`. */
const NUMBER = /^\d[\d.:]*$/;
const HEX = /^[0-9a-f]{12,}$/i;
/** A ULID, a nanoid, a random token: long, and with a digit in it. */
const OPAQUE = /^(?=[^/]*\d)[A-Za-z0-9_-]{16,}$/;
/** Letters and digits mixed (`vdb3jti`, `57TX-M9HG`): a key, a code, a name. */
const MIXED = /^(?=.*[A-Za-z])(?=.*\d)/;
/** An API's version (`v1`) or a protocol's (`oauth2`) is part of the route. */
const VERSION = /^(?:v\d+|oauth2)$/;

const isIdSegment = (segment: string): boolean =>
  UUID.test(segment) ||
  PREFIXED_ID.test(segment) ||
  NUMBER.test(segment) ||
  HEX.test(segment) ||
  OPAQUE.test(segment) ||
  (MIXED.test(segment) && !VERSION.test(segment)) ||
  segment.includes("%") ||
  segment.includes("@");

/** `sessions` → `sessionId`, `harness-layouts` → `harnessLayoutId`; else `id`. */
const parameterFor = (previous: string | undefined): string => {
  if (previous === undefined || previous.startsWith(":") || !/^[a-z][a-z-_]*$/i.test(previous))
    return "id";
  const words = previous.split(/[-_]/).filter((word) => word !== "");
  const last = words.at(-1) ?? "";
  const singular = last.endsWith("ies")
    ? `${last.slice(0, -3)}y`
    : /(?:sses|xes|ches|shes)$/.test(last)
      ? last.slice(0, -2)
      : /[^s]s$/.test(last)
        ? last.slice(0, -1)
        : last;
  const camel = [...words.slice(0, -1), singular]
    .map((word, index) =>
      index === 0 ? word.toLowerCase() : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`,
    )
    .join("");
  return `${camel}Id`;
};

/** Route templates by their number of segments, each segment a literal or `null` for a parameter. */
export type RouteTemplates = ReadonlyMap<
  number,
  ReadonlyArray<{ readonly template: string; readonly segments: ReadonlyArray<string | null> }>
>;

/** `templates` (`/api/sessions/:id`), ready for `templatePath` to match a path against. */
export const routeTemplates = (templates: ReadonlyArray<string>): RouteTemplates => {
  const bySize = new Map<
    number,
    Array<{ readonly template: string; readonly segments: ReadonlyArray<string | null> }>
  >();
  for (const template of templates) {
    const segments = template
      .split("/")
      .map((segment) => (segment.startsWith(":") || segment === "*" ? null : segment));
    const sized = bySize.get(segments.length) ?? [];
    sized.push({ template, segments });
    bySize.set(segments.length, sized);
  }
  return bySize;
};

/**
 * The template of `routes` that `path` matches, a literal segment winning over a parameter from
 * the left (`/api/sessions/inbox` over `/api/sessions/:id`), as a router picks.
 */
const matchedRoute = (path: string, routes: RouteTemplates): string | undefined => {
  const segments = path.split("/");
  let best: { readonly template: string; readonly rank: string } | undefined;
  for (const route of routes.get(segments.length) ?? []) {
    let rank = "";
    let matches = true;
    for (const [index, literal] of route.segments.entries()) {
      const segment = segments[index] ?? "";
      if (literal === null) {
        if (segment === "") matches = false;
        rank += "0";
      } else if (literal === segment) rank += "1";
      else matches = false;
      if (!matches) break;
    }
    if (matches && (best === undefined || rank > best.rank))
      best = { template: route.template, rank };
  }
  return best?.template;
};

/** The path's segment after a prefix whose next segment is a secret (`/api/me/cli-auth/<code>`). */
const secretAt = (path: string): number | undefined => {
  for (const prefix of SECRET_SEGMENT_PREFIXES)
    if (path.startsWith(`${prefix}/`)) return prefix.split("/").length;
  return undefined;
};

/**
 * A request path with each ID in it named for what it is: `/v1/sessions/:sessionId/output`, or
 * the template of the route of `routes` it matches.
 */
export const templatePath = (path: string, routes?: RouteTemplates): string => {
  const matched = routes === undefined ? undefined : matchedRoute(path, routes);
  if (matched !== undefined) return matched;
  const secret = secretAt(path);
  const templated: Array<string> = [];
  for (const [index, segment] of path.split("/").entries()) {
    templated.push(
      index === secret
        ? ":secret"
        : segment !== "" && isIdSegment(segment)
          ? `:${parameterFor(templated.at(-1))}`
          : segment,
    );
  }
  const joined = templated.join("/");
  return joined === "" ? "/" : joined;
};

/** The path of `url`, absolute or not, without its query or fragment. */
export const pathOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return url.startsWith("/") ? (url.split(/[?#]/)[0] ?? url) : undefined;
  }
};
